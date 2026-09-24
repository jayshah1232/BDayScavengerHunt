const express = require('express');
const { db, getSetting, setSetting, lockTeamMode, logActivity, advanceTeamStage } = require('../db');
const { requireGate, requirePlayer, requireTeam } = require('../middleware/auth');

const router = express.Router();

function teamRow(id) {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
}
function teams() {
  return db.prepare('SELECT * FROM teams ORDER BY id').all();
}
function pool() {
  return db.prepare('SELECT id, name, created_at FROM players WHERE team_id IS NULL ORDER BY created_at ASC').all();
}
function normalize(str) {
  return (str || '').trim().toLowerCase();
}

function maybeInitDraftTurn() {
  if (getSetting('team_mode') !== 'draft') return;
  if (getSetting('draft_current_turn_team_id')) return;
  const [a, b] = teams();
  if (a.captain_player_id && b.captain_player_id) {
    setSetting('draft_current_turn_team_id', String(a.id));
    logActivity('draft', 'Both captains are in — the draft can begin.');
  }
}

function maybeFinishDraft() {
  if (getSetting('team_mode') !== 'draft') return;
  if (pool().length === 0) {
    setSetting('draft_complete', '1');
    logActivity('draft', 'Draft complete — all joined players have a team.');
  }
}

// Try to auto-attach a newly-joined player as a captain (draft mode) or via
// roster match (auto mode). Called right after a player record is created.
function tryAutoPlace(player) {
  const mode = getSetting('team_mode');
  const name = normalize(player.name);

  if (mode === 'draft' || !mode) {
    for (const t of teams()) {
      if (t.captain_name && normalize(t.captain_name) === name && !t.captain_player_id) {
        db.prepare('UPDATE teams SET captain_player_id = ? WHERE id = ?').run(player.id, t.id);
        db.prepare('UPDATE players SET team_id = ?, is_captain = 1 WHERE id = ?').run(t.id, player.id);
        logActivity('join', `${player.name} joined as captain of ${t.name}`, t.id);
        maybeInitDraftTurn();
        return true;
      }
    }
  }

  if (mode === 'auto') {
    let rosterMap = {};
    try { rosterMap = JSON.parse(getSetting('roster_map', '{}')); } catch (_) {}
    const teamId = rosterMap[name];
    if (teamId) {
      db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(teamId, player.id);
      const t = teamRow(teamId);
      logActivity('join', `${player.name} auto-assigned to ${t ? t.name : 'a team'}`, teamId);
      return true;
    }
    logActivity('join', `${player.name} joined but their name doesn't match anyone on the roster.`);
  }

  return false;
}

function broadcast(req) {
  req.app.get('io').emit('game-state-changed');
}

// ---- Public-ish game state, used by the lobby/draft screens ----
router.get('/state', requireGate, requirePlayer, (req, res) => {
  const t = teams();
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);

  res.json({
    gameTitle: getSetting('game_title', 'Scavenger Hunt'),
    gamePhase: getSetting('game_phase', 'lobby'),
    teamMode: getSetting('team_mode'),
    leaderboardEnabled: getSetting('leaderboard_enabled') === '1',
    draftComplete: getSetting('draft_complete') === '1',
    draftCurrentTurnTeamId: getSetting('draft_current_turn_team_id')
      ? Number(getSetting('draft_current_turn_team_id')) : null,
    me: me ? { id: me.id, name: me.name, teamId: me.team_id, isCaptain: !!me.is_captain } : null,
    teams: t.map((team) => ({
      id: team.id,
      name: team.name,
      captainName: team.captain_name,
      captainJoined: !!team.captain_player_id,
      memberCount: db.prepare('SELECT COUNT(*) AS c FROM players WHERE team_id = ?').get(team.id).c,
      members: db.prepare('SELECT id, name, is_captain FROM players WHERE team_id = ? ORDER BY is_captain DESC, created_at ASC').all(team.id),
    })),
    pool: pool(),
  });
});

// ---- Lock team mode: first click wins for the whole group ----
router.post('/team-mode', requireGate, requirePlayer, (req, res) => {
  const { mode } = req.body || {};
  if (!['draft', 'auto'].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });

  const locked = lockTeamMode(mode);

  if (locked === mode) {
    logActivity('mode', `Team mode set to "${mode}"`);
    if (mode === 'auto') {
      // Retroactively place anyone who already joined before the mode locked.
      pool().forEach((p) => tryAutoPlace(p));
    } else {
      // Retroactively catch anyone who already joined and happens to be a captain.
      pool().forEach((p) => tryAutoPlace(p));
      maybeInitDraftTurn();
    }
  }

  broadcast(req);
  res.json({ ok: true, lockedMode: locked });
});

// ---- Free self-select (used for auto-mode fallback join and post-draft latecomers) ----
router.post('/join-team', requireGate, requirePlayer, (req, res) => {
  const { teamId } = req.body || {};
  const mode = getSetting('team_mode');
  const draftDone = getSetting('draft_complete') === '1';
  if (mode === 'draft' && !draftDone) {
    return res.status(403).json({ error: 'draft_in_progress' });
  }
  const t = teamRow(teamId);
  if (!t) return res.status(400).json({ error: 'invalid_team' });

  db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(t.id, req.session.playerId);
  const player = db.prepare('SELECT name FROM players WHERE id = ?').get(req.session.playerId);
  logActivity('join', `${player.name} joined ${t.name}`, t.id);
  broadcast(req);
  res.json({ ok: true });
});

// ---- Captain draft pick ----
router.post('/draft-pick', requireGate, requirePlayer, (req, res) => {
  const { playerId } = req.body || {};
  if (getSetting('team_mode') !== 'draft') return res.status(400).json({ error: 'not_draft_mode' });

  const turnTeamId = Number(getSetting('draft_current_turn_team_id') || 0);
  if (!turnTeamId) return res.status(400).json({ error: 'draft_not_started' });

  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
  const turnTeam = teamRow(turnTeamId);
  if (!me || !turnTeam || turnTeam.captain_player_id !== me.id) {
    return res.status(403).json({ error: 'not_your_turn' });
  }

  const pick = db.prepare('SELECT * FROM players WHERE id = ? AND team_id IS NULL').get(playerId);
  if (!pick) return res.status(400).json({ error: 'invalid_pick' });

  db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(turnTeam.id, pick.id);
  logActivity('draft', `${turnTeam.name} (captain ${me.name}) picked ${pick.name}`, turnTeam.id);

  const all = teams();
  const other = all.find((t) => t.id !== turnTeam.id);
  if (pool().length > 0 && other) {
    setSetting('draft_current_turn_team_id', String(other.id));
  }
  maybeFinishDraft();

  broadcast(req);
  res.json({ ok: true });
});

// ---- NFC / manual check-in ----
function currentLocationFor(team) {
  return db.prepare('SELECT * FROM locations WHERE team_id = ? AND stage_order = ?').get(team.id, team.current_stage);
}
function totalLocationsFor(teamId) {
  return db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(teamId).c;
}

function completeCheckin(req, res, team, location) {
  if (location.nfc_question && location.nfc_question.trim()) {
    return res.json({ ok: true, needsAnswer: true, question: location.nfc_question });
  }
  advanceTeamPastLocation(req, team, location, 'Tapped in');
  return res.json({ ok: true, needsAnswer: false, advanced: true });
}

function advanceTeamPastLocation(req, team, location, verb) {
  const { gameJustEnded } = advanceTeamStage(team.id, location.id);
  logActivity('checkin', `${team.name} — ${verb} at ${location.name}`, team.id);
  const io = req.app.get('io');
  io.to(`team-${team.id}`).emit('state-changed');
  io.to('admins').emit('admin-activity');
  if (gameJustEnded) io.emit('game-state-changed');
}

router.post('/checkin', requireGate, requirePlayer, requireTeam, (req, res) => {
  const { token } = req.body || {};
  const team = teamRow(req.teamId);
  const total = totalLocationsFor(team.id);
  if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

  const location = currentLocationFor(team);
  if (!location || location.verification_type !== 'nfc') {
    return res.status(400).json({ error: 'not_an_nfc_stage' });
  }
  if (!token || location.nfc_token !== token) {
    // Could be the wrong tag, or a tag for a location this team already passed.
    const anyMatch = db.prepare('SELECT id FROM locations WHERE nfc_token = ?').get(token);
    if (anyMatch) return res.status(409).json({ error: 'not_current_location' });
    return res.status(404).json({ error: 'unknown_tag' });
  }

  completeCheckin(req, res, team, location);
});

router.post('/checkin-code', requireGate, requirePlayer, requireTeam, (req, res) => {
  const { code } = req.body || {};
  const team = teamRow(req.teamId);
  const total = totalLocationsFor(team.id);
  if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

  const location = currentLocationFor(team);
  if (!location || location.verification_type !== 'nfc') {
    return res.status(400).json({ error: 'not_an_nfc_stage' });
  }
  if (!code || normalize(code) !== normalize(location.nfc_backup_code)) {
    return res.status(403).json({ error: 'incorrect_code' });
  }

  completeCheckin(req, res, team, location);
});

router.post('/checkin-answer', requireGate, requirePlayer, requireTeam, (req, res) => {
  const { answer } = req.body || {};
  const team = teamRow(req.teamId);
  const total = totalLocationsFor(team.id);
  if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

  const location = currentLocationFor(team);
  if (!location || location.verification_type !== 'nfc' || !location.nfc_question) {
    return res.status(400).json({ error: 'no_question_pending' });
  }

  const accepted = (location.nfc_answer || '').split('|').map(normalize).filter(Boolean);
  if (!accepted.includes(normalize(answer))) {
    return res.status(403).json({ error: 'incorrect_answer' });
  }

  advanceTeamPastLocation(req, team, location, 'Answered correctly');
  res.json({ ok: true, advanced: true });
});

// ---- Teams naming themselves — open until the hunt actually starts ----
router.post('/rename-team', requireGate, requirePlayer, requireTeam, (req, res) => {
  if (getSetting('game_phase', 'lobby') !== 'lobby') {
    return res.status(403).json({ error: 'hunt_already_started' });
  }
  const { name } = req.body || {};
  const clean = (name || '').trim().slice(0, 40);
  if (!clean) return res.status(400).json({ error: 'name_required' });

  const team = teamRow(req.teamId);
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(clean, team.id);
  logActivity('team', `Team renamed to "${clean}"`, team.id);
  broadcast(req);
  res.json({ ok: true });
});

// ---- Opt-in leaderboard: rough progress only, no hints or photos ----
router.get('/leaderboard', requireGate, requirePlayer, (req, res) => {
  if (getSetting('leaderboard_enabled') !== '1') {
    return res.status(403).json({ error: 'leaderboard_disabled' });
  }
  res.json({
    teams: teams().map((t) => {
      const total = totalLocationsFor(t.id);
      return { name: t.name, progress: Math.min(t.current_stage, total), total };
    }),
  });
});

// ---- Post-game recap: this team's stage-by-stage times + approved media, plus a finish comparison ----
router.get('/recap', requireGate, requirePlayer, requireTeam, (req, res) => {
  const team = teamRow(req.teamId);
  const total = totalLocationsFor(team.id);
  if (team.current_stage < total) return res.status(400).json({ error: 'not_finished' });

  const startedAt = getSetting('hunt_started_at');
  const completions = db.prepare(
    `SELECT sc.completed_at, l.name AS locationName,
            EXISTS(SELECT 1 FROM hint_requests hr WHERE hr.team_id = sc.team_id AND hr.location_id = sc.location_id) AS hintUsed
     FROM stage_completions sc JOIN locations l ON l.id = sc.location_id
     WHERE sc.team_id = ? ORDER BY sc.id ASC`
  ).all(team.id);

  const toMs = (ts) => new Date(ts.replace(' ', 'T') + 'Z').getTime();
  let prev = startedAt ? toMs(startedAt) : null;
  const splits = completions.map((c) => {
    const now = toMs(c.completed_at);
    const seconds = prev ? Math.round((now - prev) / 1000) : null;
    prev = now;
    return { locationName: c.locationName, seconds, hintUsed: !!c.hintUsed };
  });
  const totalSeconds = startedAt && completions.length
    ? Math.round((toMs(completions[completions.length - 1].completed_at) - toMs(startedAt)) / 1000)
    : null;
  const hintsUsed = db.prepare('SELECT COUNT(*) AS c FROM hint_requests WHERE team_id = ?').get(team.id).c;

  const media = db.prepare(
    `SELECT id, media_kind FROM submissions WHERE team_id = ? AND status = 'approved' ORDER BY id ASC`
  ).all(team.id);

  const allTeamFinishes = teams().map((t) => {
    const finishRow = db.prepare(
      `SELECT sc.completed_at FROM stage_completions sc WHERE sc.team_id = ? ORDER BY sc.id DESC LIMIT 1`
    ).get(t.id);
    const tTotal = totalLocationsFor(t.id);
    const finished = t.current_stage >= tTotal;
    return {
      name: t.name,
      finished,
      totalSeconds: finished && startedAt && finishRow ? Math.round((toMs(finishRow.completed_at) - toMs(startedAt)) / 1000) : null,
      hintsUsed: db.prepare('SELECT COUNT(*) AS c FROM hint_requests WHERE team_id = ?').get(t.id).c,
    };
  });

  res.json({ teamName: team.name, totalSeconds, splits, hintsUsed, media, allTeamFinishes });
});

module.exports = { router, tryAutoPlace, broadcast: (req) => req.app.get('io').emit('game-state-changed') };
