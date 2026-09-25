const express = require('express');
const { db, getSetting, logActivity, advanceTeamStage } = require('../db');
const { requireGate, requirePlayer, requireTeam } = require('../middleware/auth');

const router = express.Router();

function teamRow(id) {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
}
function teams() {
  return db.prepare('SELECT * FROM teams ORDER BY id').all();
}
function normalize(str) {
  return (str || '').trim().toLowerCase();
}

// Common filler words stripped before comparing a guess, so "the CN Tower",
// "cn tower", and "a cn tower" all match the same accepted answer.
const FILLER_WORDS = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'to', 'near']);
function normalizeGuess(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(' ')
    .trim();
}
function guessMatches(guess, location) {
  const normalizedGuess = normalizeGuess(guess);
  if (!normalizedGuess) return false;
  const accepted = (location.guess_answer || '').split('|').map(normalizeGuess).filter(Boolean);
  return accepted.includes(normalizedGuess);
}

// Teams are entirely admin-assigned now (via the roster set on the Setup
// page) — this is the only way a joining player ever ends up on a team.
function tryAutoPlace(player) {
  let rosterMap = {};
  try { rosterMap = JSON.parse(getSetting('roster_map', '{}')); } catch (_) {}
  const teamId = rosterMap[normalize(player.name)];
  if (teamId) {
    db.prepare('UPDATE players SET team_id = ? WHERE id = ?').run(teamId, player.id);
    const t = teamRow(teamId);
    logActivity('join', `${player.name} placed on ${t ? t.name : 'a team'}`, teamId);
    return true;
  }
  logActivity('join', `${player.name} joined but their name doesn't match anyone on the roster.`);
  return false;
}

function broadcast(req) {
  req.app.get('io').emit('game-state-changed');
}

function currentLocationFor(team) {
  return db.prepare('SELECT * FROM locations WHERE team_id = ? AND stage_order = ?').get(team.id, team.current_stage);
}
function totalLocationsFor(teamId) {
  return db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(teamId).c;
}
function isGuessed(teamId, locationId) {
  return !!db.prepare('SELECT 1 FROM location_guesses WHERE team_id = ? AND location_id = ?').get(teamId, locationId);
}

// ---- Game state used by the waiting room / roster-mismatch screens ----
router.get('/state', requireGate, requirePlayer, (req, res) => {
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
  const myTeam = me && me.team_id ? teamRow(me.team_id) : null;

  res.json({
    gameTitle: getSetting('game_title', 'Scavenger Hunt'),
    gamePhase: getSetting('game_phase', 'lobby'),
    leaderboardEnabled: getSetting('leaderboard_enabled') === '1',
    me: me ? { id: me.id, name: me.name, teamId: me.team_id } : null,
    team: myTeam ? {
      id: myTeam.id,
      name: myTeam.name,
      members: db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY created_at ASC').all(myTeam.id),
    } : null,
  });
});

// ---- Guess the current location; once correct, its task unlocks ----
router.post('/guess', requireGate, requirePlayer, requireTeam, (req, res) => {
  const { guess } = req.body || {};
  const team = teamRow(req.teamId);
  const total = totalLocationsFor(team.id);
  if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

  const location = currentLocationFor(team);
  if (!location) return res.status(400).json({ error: 'no_active_location' });
  if (isGuessed(team.id, location.id)) return res.status(400).json({ error: 'already_guessed' });

  if (!guessMatches(guess, location)) {
    return res.status(403).json({ error: 'incorrect_guess' });
  }

  db.prepare('INSERT INTO location_guesses (team_id, location_id) VALUES (?, ?)').run(team.id, location.id);
  logActivity('guess', `${team.name} correctly guessed ${location.name}`, team.id);
  const io = req.app.get('io');
  io.to(`team-${team.id}`).emit('state-changed');
  io.to('admins').emit('admin-activity');

  res.json({ ok: true, locationName: location.name, task: location.task });
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

module.exports = { router, tryAutoPlace };
