const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, getSetting, setSetting, logActivity, advanceTeamStage, minutesSinceLastPlayerActivity, resetGameProgress } = require('../db');
const { requireGate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

function broadcastGame(req) {
  req.app.get('io').emit('game-state-changed');
}
function broadcastTeam(req, teamId) {
  req.app.get('io').to(`team-${teamId}`).emit('state-changed');
}

router.post('/login', requireGate, loginLimiter, (req, res) => {
  const { password } = req.body || {};
  const hash = getSetting('admin_password_hash');
  if (!hash || typeof password !== 'string' || !bcrypt.compareSync(password, hash)) {
    return res.status(403).json({ error: 'incorrect' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post('/logout', requireGate, (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

// ---- Dashboard: teams, lobby status, pending media, activity feed ----
router.get('/overview', requireGate, requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY id').all().map((t) => {
    const total = db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(t.id).c;
    const currentLocation = t.current_stage < total
      ? db.prepare('SELECT id, name FROM locations WHERE team_id = ? AND stage_order = ?').get(t.id, t.current_stage)
      : null;
    const currentPhase = currentLocation
      ? (db.prepare('SELECT 1 FROM location_guesses WHERE team_id = ? AND location_id = ?').get(t.id, currentLocation.id) ? 'task' : 'guessing')
      : null;
    return {
      id: t.id,
      name: t.name,
      progress: t.current_stage,
      total,
      finished: total > 0 && t.current_stage >= total,
      currentLocation,
      currentPhase,
      members: db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY name ASC').all(t.id),
      quietMinutes: (getSetting('game_phase') === 'active' && t.current_stage < total)
        ? minutesSinceLastPlayerActivity(t.id) : null,
      hintsUsed: db.prepare('SELECT COUNT(*) AS c FROM hint_requests WHERE team_id = ?').get(t.id).c,
    };
  });

  const unassigned = db.prepare('SELECT id, name, created_at FROM players WHERE team_id IS NULL ORDER BY created_at ASC').all();

  const pending = db.prepare(
    `SELECT s.id, s.filename, s.media_kind, s.submitted_at, t.id AS teamId, t.name AS teamName,
            l.name AS locationName, l.admin_note AS adminNote, p.name AS playerName
     FROM submissions s
     JOIN teams t ON t.id = s.team_id
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN players p ON p.id = s.player_id
     WHERE s.status = 'pending'
     ORDER BY s.submitted_at ASC`
  ).all();

  const recentReviewed = db.prepare(
    `SELECT s.id, s.status, s.reviewed_at, t.name AS teamName, l.name AS locationName
     FROM submissions s JOIN teams t ON t.id = s.team_id JOIN locations l ON l.id = s.location_id
     WHERE s.status IN ('approved','rejected') ORDER BY s.reviewed_at DESC LIMIT 15`
  ).all();

  const activity = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 40').all();

  res.json({
    gamePhase: getSetting('game_phase', 'lobby'),
    leaderboardEnabled: getSetting('leaderboard_enabled') === '1',
    teams,
    // Informational only — rosters are set ahead of time on the Setup page,
    // so there's no live "place this player" action for the admin to take.
    // A name showing up here just means it didn't match the roster; the
    // player fixes it themselves from their own screen.
    unassigned,
    pending,
    recentReviewed,
    activity,
    canStart: teams.every((t) => t.members.length > 0 && t.total > 0),
  });
});

router.get('/image/:submissionId', requireGate, requireAdmin, (req, res) => {
  const sub = db.prepare('SELECT filename FROM submissions WHERE id = ?').get(req.params.submissionId);
  if (!sub) return res.status(404).end();
  res.sendFile(sub.filename, { root: path.join(__dirname, '..', 'uploads') });
});

router.post('/review/:submissionId', requireGate, requireAdmin, (req, res) => {
  const { decision, note } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });

  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.submissionId);
  if (!sub) return res.status(404).json({ error: 'not_found' });
  if (sub.status !== 'pending') return res.status(409).json({ error: 'already_reviewed' });

  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare(`UPDATE submissions SET status = ?, note = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(status, (note || '').trim().slice(0, 300), sub.id);

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(sub.team_id);
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(sub.location_id);

  if (decision === 'approve' && location && location.stage_order === team.current_stage) {
    const { gameJustEnded } = advanceTeamStage(team.id, location.id);
    // Any other pending submission for this same now-completed stage is moot —
    // first one to be approved is the one that counts.
    db.prepare(
      `UPDATE submissions SET status = 'superseded', reviewed_at = datetime('now')
       WHERE team_id = ? AND location_id = ? AND status = 'pending' AND id != ?`
    ).run(team.id, location.id, sub.id);
    logActivity('review', `Approved ${team.name}'s submission for ${location.name} — moving to next hint`, team.id);
    if (gameJustEnded) broadcastGame(req);
  } else if (decision === 'reject') {
    logActivity('review', `Rejected ${team.name}'s submission for ${location ? location.name : 'a location'}`, team.id);
  }

  broadcastTeam(req, team.id);
  req.app.get('io').to('admins').emit('admin-activity');
  res.json({ ok: true });
});

// ---- Lobby controls ----
router.post('/start-hunt', requireGate, requireAdmin, (req, res) => {
  setSetting('game_phase', 'active');
  setSetting('hunt_started_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
  logActivity('game', 'The admin started the hunt!');
  broadcastGame(req);
  res.json({ ok: true });
});

// Manual stage advance — the WhatsApp/slow-upload backup path: if a team
// sends their proof straight to the group chat instead of the app, push
// them forward here without needing a matching submission row (skips both
// the guess step and the task for that location).
router.post('/advance-team', requireGate, requireAdmin, (req, res) => {
  const { teamId, note } = req.body || {};
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(400).json({ error: 'invalid_team' });

  const total = db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(team.id).c;
  if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

  const location = db.prepare('SELECT * FROM locations WHERE team_id = ? AND stage_order = ?').get(team.id, team.current_stage);
  const { gameJustEnded } = advanceTeamStage(team.id, location.id);
  logActivity('admin', `Admin manually advanced ${team.name}${note ? ` — ${note}` : ''}`, team.id);
  broadcastTeam(req, team.id);
  if (gameJustEnded) broadcastGame(req);
  res.json({ ok: true });
});

// ---- Opt-in leaderboard toggle ----
router.post('/leaderboard-toggle', requireGate, requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  setSetting('leaderboard_enabled', enabled ? '1' : '0');
  logActivity('admin', `Admin ${enabled ? 'enabled' : 'disabled'} the shared leaderboard`);
  broadcastGame(req);
  res.json({ ok: true });
});

// ---- Printable backup hint sheet (open on a laptop, Ctrl+P) ----
router.get('/hint-sheet', requireGate, requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
  const sections = teams.map((team) => {
    const locations = db.prepare('SELECT * FROM locations WHERE team_id = ? ORDER BY stage_order ASC').all(team.id);
    const rows = locations.map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(l.name)}</td>
        <td>${escapeHtml(l.hint)}</td>
        <td>${escapeHtml(l.guess_answer || '—')}</td>
        <td>${escapeHtml(l.task || '—')}</td>
        <td>${escapeHtml(l.admin_note || '')}</td>
        <td>${escapeHtml(l.extra_hint || '—')}</td>
      </tr>`).join('');
    return `
      <h2>${escapeHtml(team.name)}</h2>
      <table><thead><tr><th>#</th><th>Location</th><th>Hint</th><th>Accepted guesses</th><th>Task</th><th>Admin note</th><th>Extra hint</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No locations configured</td></tr>'}</tbody></table>`;
  }).join('');

  res.send(`<!DOCTYPE html><html><head><title>Hint Sheet</title>
  <style>
    body{font-family:sans-serif;padding:20px;} table{border-collapse:collapse;width:100%;margin-bottom:28px;}
    td,th{border:1px solid #999;padding:8px;text-align:left;vertical-align:top;font-size:14px;}
    th{background:#eee;} h2{margin-top:0;}
    @media print { body { padding: 0; } table { page-break-inside: avoid; } }
  </style></head><body>
  <h1>${escapeHtml(getSetting('game_title', 'Scavenger Hunt'))} — Backup Hint Sheet</h1>
  <p>Print this before the event as a manual fallback if the server goes down. Each team has its own location list below.</p>
  ${sections}
  </body></html>`);
});

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Setup page: load current configuration for editing ----
router.get('/setup', requireGate, requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
  let rosterMap = {};
  try { rosterMap = JSON.parse(getSetting('roster_map', '{}')); } catch (_) {}
  // Turn {name: teamId} back into a per-team comma list for the form.
  const rosterByTeam = {};
  teams.forEach((t) => { rosterByTeam[t.id] = []; });
  Object.entries(rosterMap).forEach(([name, teamId]) => {
    if (rosterByTeam[teamId]) rosterByTeam[teamId].push(name);
  });

  res.json({
    gameTitle: getSetting('game_title', 'Scavenger Hunt'),
    gateQuestion: getSetting('gate_question', ''),
    hasGateAnswer: !!getSetting('gate_answer_hash'),
    hasAdminPassword: !!getSetting('admin_password_hash'),
    teams: teams.map((t) => ({
      name: t.name,
      rosterNames: (rosterByTeam[t.id] || []).join(', '),
      locations: db.prepare('SELECT * FROM locations WHERE team_id = ? ORDER BY stage_order ASC').all(t.id).map((l) => ({
        name: l.name,
        hint: l.hint,
        guessAnswer: l.guess_answer || '',
        task: l.task || '',
        adminNote: l.admin_note || '',
        extraHint: l.extra_hint || '',
      })),
    })),
    gamePhase: getSetting('game_phase', 'lobby'),
  });
});

// ---- Setup page: save everything at once ----
router.post('/setup', requireGate, requireAdmin, (req, res) => {
  if (getSetting('game_phase', 'lobby') !== 'lobby') {
    return res.status(403).json({ error: 'hunt_in_progress' });
  }
  const { gameTitle, gateQuestion, gateAnswer, adminPassword, teams } = req.body || {};

  if (!Array.isArray(teams) || teams.length !== 2) return res.status(400).json({ error: 'need_two_teams' });
  if (teams.some((t) => !Array.isArray(t.locations) || t.locations.length === 0)) {
    return res.status(400).json({ error: 'need_locations' });
  }

  setSetting('game_title', (gameTitle || 'Scavenger Hunt').trim().slice(0, 60));
  if (gateQuestion && gateQuestion.trim()) setSetting('gate_question', gateQuestion.trim());
  if (gateAnswer && gateAnswer.trim()) {
    setSetting('gate_answer_hash', bcrypt.hashSync(gateAnswer.trim().toLowerCase(), 10));
  }
  if (adminPassword && adminPassword.trim()) {
    setSetting('admin_password_hash', bcrypt.hashSync(adminPassword.trim(), 10));
  }

  // Teams: update the two existing rows by position rather than delete/recreate,
  // so ids stay stable. (Blocked above unless we're still in the lobby, so no
  // players/progress reference them yet in a way this could disrupt.)
  const existingTeams = db.prepare('SELECT id FROM teams ORDER BY id').all();
  const rosterMap = {};
  const teamIds = teams.map((t, i) => {
    const name = (t.name || `Team ${i + 1}`).trim().slice(0, 40);
    let teamId;
    if (existingTeams[i]) {
      teamId = existingTeams[i].id;
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, teamId);
    } else {
      teamId = db.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid;
    }
    (t.rosterNames || '').split(',').map((n) => n.trim()).filter(Boolean).forEach((n) => {
      rosterMap[n.toLowerCase()] = teamId;
    });
    return teamId;
  });
  setSetting('roster_map', JSON.stringify(rosterMap));

  // Locations: full replace, per team — safe because we've already confirmed
  // the hunt hasn't started, so nothing references these rows yet.
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM location_guesses').run();
  db.prepare('DELETE FROM locations').run();
  const insertLoc = db.prepare(`
    INSERT INTO locations (team_id, stage_order, name, hint, guess_answer, task, admin_note, extra_hint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  teams.forEach((t, teamIndex) => {
    const teamId = teamIds[teamIndex];
    t.locations.forEach((l, i) => {
      const name = (l.name || `Location ${i + 1}`).trim().slice(0, 60);
      const hint = (l.hint || '').trim().slice(0, 500);
      const guessAnswer = (l.guessAnswer || '').trim().slice(0, 300);
      const task = (l.task || '').trim().slice(0, 500);
      const adminNote = (l.adminNote || '').trim().slice(0, 500) || null;
      const extraHint = (l.extraHint || '').trim().slice(0, 500) || null;
      insertLoc.run(teamId, i, name, hint, guessAnswer, task, adminNote, extraHint);
    });
  });

  logActivity('admin', 'Admin saved changes in the Setup page');
  broadcastGame(req);
  res.json({ ok: true });
});

// ---- Reset all progress (keeps configuration) so a fresh test/event can start ----
router.post('/setup/reset', requireGate, requireAdmin, (req, res) => {
  resetGameProgress();
  logActivity('admin', 'Admin reset the game — all players and progress cleared');
  broadcastGame(req);
  res.json({ ok: true });
});

module.exports = router;
