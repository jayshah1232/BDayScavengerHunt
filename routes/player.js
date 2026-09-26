const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { fromBuffer } = require('file-type');
const { db, getSetting, logActivity, GATE_WAIT_SECONDS } = require('../db');
const { requireGate, requirePlayer, requireTeam } = require('../middleware/auth');
const { tryAutoPlace } = require('./game');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_VIDEO = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp']);
const EXT_FOR = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp',
};

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 75);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

function currentLocation(teamId, stageIndex) {
  return db.prepare('SELECT * FROM locations WHERE team_id = ? AND stage_order = ?').get(teamId, stageIndex);
}
function totalLocations(teamId) {
  return db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(teamId).c;
}
function isGuessed(teamId, locationId) {
  return !!db.prepare('SELECT 1 FROM location_guesses WHERE team_id = ? AND location_id = ?').get(teamId, locationId);
}
function normalize(str) {
  return (str || '').trim().toLowerCase();
}

// Validates a file actually looks like an allowed image/video (by content,
// not filename/browser-reported type) and writes it to uploads/ with a
// random name. Shared by both the regular per-location submit and the
// final-round submit. Returns null if the file isn't an allowed type.
async function saveMediaFile(buffer) {
  const type = await fromBuffer(buffer);
  let kind = null;
  if (type && ALLOWED_IMAGE.has(type.mime)) kind = 'image';
  else if (type && ALLOWED_VIDEO.has(type.mime)) kind = 'video';
  if (!kind) return null;
  const filename = `${uuidv4()}${EXT_FOR[type.mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return { kind, filename };
}

// --- Names still up for grabs: everyone on the roster who hasn't joined yet.
// The join screen only offers a dropdown of these, so a typo (or picking a
// name someone else already has) isn't possible from the app itself. ---
router.get('/roster-names', requireGate, (req, res) => {
  let rosterMap = {};
  try { rosterMap = JSON.parse(getSetting('roster_map', '{}')); } catch (_) {}
  const taken = new Set(db.prepare('SELECT name FROM players').all().map((p) => normalize(p.name)));
  const available = Object.keys(rosterMap)
    .filter((n) => !taken.has(n))
    .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
    .sort((a, b) => a.localeCompare(b));
  res.json({ available });
});

// --- Join with a name picked from the roster dropdown ---
router.post('/join', requireGate, (req, res) => {
  const { name } = req.body || {};
  const clean = (name || '').trim().slice(0, 40);
  if (!clean) return res.status(400).json({ error: 'name_required' });

  let rosterMap = {};
  try { rosterMap = JSON.parse(getSetting('roster_map', '{}')); } catch (_) {}
  if (!rosterMap[normalize(clean)]) return res.status(400).json({ error: 'not_on_roster' });

  const already = db.prepare('SELECT 1 FROM players WHERE lower(name) = ?').get(normalize(clean));
  if (already) return res.status(409).json({ error: 'name_taken' });

  const info = db.prepare('INSERT INTO players (name) VALUES (?)').run(clean);
  req.session.playerId = info.lastInsertRowid;
  req.session.playerName = clean;

  const player = { id: info.lastInsertRowid, name: clean };
  tryAutoPlace(player);

  req.app.get('io').emit('game-state-changed');
  res.json({ ok: true, playerId: player.id, name: clean });
});

// --- "That's not me" — picked the wrong name from the dropdown before the
// hunt started. Deletes the player row (freeing the name back up for
// whoever it actually belongs to) and clears the session so they land back
// on the join screen. ---
router.post('/switch', requireGate, requirePlayer, (req, res) => {
  if (getSetting('game_phase', 'lobby') !== 'lobby') {
    return res.status(403).json({ error: 'hunt_already_started' });
  }
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
  if (player) {
    db.prepare('DELETE FROM players WHERE id = ?').run(player.id);
    logActivity('join', `${player.name} switched back to pick a different name`);
  }
  req.session.playerId = null;
  req.session.playerName = null;

  req.app.get('io').emit('game-state-changed');
  res.json({ ok: true });
});

// --- Current game state for this player's team: guess/task, the post-locations
// gate wait, the final bonus round, or progress + submission status for any of them ---
router.get('/state', requireGate, requirePlayer, (req, res) => {
  const playerRow = db.prepare('SELECT team_id FROM players WHERE id = ?').get(req.session.playerId);
  const teamId = playerRow ? playerRow.team_id : null;
  let team = null;
  let location = null;
  let phase = null;
  let pendingCount = 0;
  let lastRejectedNote = null;
  let hintUsed = false;
  let total = 0;
  let gateReadyAt = null;

  if (teamId) {
    team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (team) {
      total = totalLocations(team.id);

      if (team.current_stage < total) {
        location = currentLocation(team.id, team.current_stage);
        const guessed = isGuessed(team.id, location.id);
        phase = guessed ? 'task' : 'guessing';
        hintUsed = !!db.prepare(
          `SELECT 1 FROM hint_requests WHERE team_id = ? AND location_id = ?`
        ).get(team.id, location.id);
        if (guessed) {
          pendingCount = db.prepare(
            `SELECT COUNT(*) AS c FROM submissions WHERE team_id = ? AND location_id = ? AND status = 'pending'`
          ).get(team.id, location.id).c;
          const lastRejected = db.prepare(
            `SELECT note FROM submissions WHERE team_id = ? AND location_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1`
          ).get(team.id, location.id);
          lastRejectedNote = pendingCount > 0 ? null : (lastRejected ? (lastRejected.note || '') : null);
        }
      } else if (team.current_stage === total) {
        phase = 'gate';
        if (team.finished_regular_at) {
          gateReadyAt = new Date(team.finished_regular_at.replace(' ', 'T') + 'Z').getTime() + GATE_WAIT_SECONDS * 1000;
        }
      } else {
        phase = 'final';
        pendingCount = db.prepare(
          `SELECT COUNT(*) AS c FROM final_submissions WHERE team_id = ? AND status = 'pending'`
        ).get(team.id).c;
        const lastRejected = db.prepare(
          `SELECT note FROM final_submissions WHERE team_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1`
        ).get(team.id);
        lastRejectedNote = pendingCount > 0 ? null : (lastRejected ? (lastRejected.note || '') : null);
      }
    }
  }

  res.json({
    gameTitle: getSetting('game_title', 'Scavenger Hunt'),
    gamePhase: getSetting('game_phase', 'lobby'),
    playerName: req.session.playerName || null,
    team: team ? { id: team.id, name: team.name } : null,
    progress: team ? team.current_stage : 0,
    total,
    phase,
    gateReadyAt,
    location: location ? {
      hint: location.hint,
      hasExtraHint: !!location.extra_hint,
      extraHint: hintUsed ? location.extra_hint : null,
      name: phase === 'task' ? location.name : null,
      task: phase === 'task' ? location.task : null,
    } : null,
    pendingCount,
    lastRejectedNote,
  });
});

// --- Submit a photo or video for the team's current location (only once it's been correctly guessed) ---
router.post('/submit', requireGate, requirePlayer, requireTeam, upload.single('media'), async (req, res) => {
  try {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.teamId);
    if (!team) return res.status(400).json({ error: 'no_team' });

    const total = totalLocations(team.id);
    if (team.current_stage >= total) return res.status(400).json({ error: 'already_finished' });

    const location = currentLocation(team.id, team.current_stage);
    if (!location) return res.status(400).json({ error: 'no_active_location' });
    if (!isGuessed(team.id, location.id)) return res.status(400).json({ error: 'not_guessed_yet' });

    if (!req.file) return res.status(400).json({ error: 'media_required' });

    const saved = await saveMediaFile(req.file.buffer);
    if (!saved) return res.status(400).json({ error: 'invalid_media' });

    const info = db.prepare(
      `INSERT INTO submissions (team_id, location_id, player_id, filename, media_kind, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(team.id, location.id, req.session.playerId, saved.filename, saved.kind);

    logActivity('submission', `${req.session.playerName} submitted a ${saved.kind} for ${location.name}`, team.id);

    const io = req.app.get('io');
    io.to('admins').emit('new-submission', {
      id: info.lastInsertRowid,
      teamName: team.name,
      locationName: location.name,
      submittedBy: req.session.playerName,
    });
    io.to(`team-${team.id}`).emit('state-changed');

    res.json({ ok: true });
  } catch (err) {
    console.error('submit error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Submit a photo/video for the final "find the host" bonus round — only
// reachable once a team has passed the gate. Approving this one (in the
// admin dashboard) ends the whole hunt, for both teams, immediately. ---
router.post('/submit-final', requireGate, requirePlayer, requireTeam, upload.single('media'), async (req, res) => {
  try {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.teamId);
    if (!team) return res.status(400).json({ error: 'no_team' });

    const total = totalLocations(team.id);
    if (team.current_stage !== total + 1) return res.status(400).json({ error: 'not_at_final' });

    if (!req.file) return res.status(400).json({ error: 'media_required' });

    const saved = await saveMediaFile(req.file.buffer);
    if (!saved) return res.status(400).json({ error: 'invalid_media' });

    const info = db.prepare(
      `INSERT INTO final_submissions (team_id, player_id, filename, media_kind, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ).run(team.id, req.session.playerId, saved.filename, saved.kind);

    logActivity('submission', `${req.session.playerName} submitted the FINAL CHALLENGE photo for ${team.name}`, team.id);

    const io = req.app.get('io');
    io.to('admins').emit('new-submission', {
      id: info.lastInsertRowid,
      teamName: team.name,
      locationName: 'FINAL CHALLENGE',
      submittedBy: req.session.playerName,
      isFinal: true,
    });
    io.to(`team-${team.id}`).emit('state-changed');

    res.json({ ok: true });
  } catch (err) {
    console.error('submit-final error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- View one's own team's approved media (used by the post-game recap gallery).
// Only approved submissions, and only if it belongs to the requester's own team. ---
router.get('/media/:submissionId', requireGate, requirePlayer, requireTeam, (req, res) => {
  const sub = db.prepare(
    `SELECT filename FROM submissions WHERE id = ? AND team_id = ? AND status = 'approved'`
  ).get(req.params.submissionId, req.teamId);
  if (!sub) return res.status(404).end();
  res.sendFile(sub.filename, { root: UPLOAD_DIR });
});

// --- Same, for the final-round bonus photo. ---
router.get('/final-media/:submissionId', requireGate, requirePlayer, requireTeam, (req, res) => {
  const sub = db.prepare(
    `SELECT filename FROM final_submissions WHERE id = ? AND team_id = ? AND status = 'approved'`
  ).get(req.params.submissionId, req.teamId);
  if (!sub) return res.status(404).end();
  res.sendFile(sub.filename, { root: UPLOAD_DIR });
});

// --- Reveal (and record) the elective extra hint for the team's current
// location. One per team per location — calling it again just re-returns
// the same hint without counting a second time. ---
router.post('/hint', requireGate, requirePlayer, requireTeam, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.teamId);
  const total = totalLocations(req.teamId);
  if (!team || team.current_stage >= total) return res.status(400).json({ error: 'no_active_location' });

  const location = currentLocation(team.id, team.current_stage);
  if (!location || !location.extra_hint) return res.status(404).json({ error: 'no_extra_hint' });

  const already = db.prepare('SELECT 1 FROM hint_requests WHERE team_id = ? AND location_id = ?').get(team.id, location.id);
  if (!already) {
    db.prepare('INSERT INTO hint_requests (team_id, location_id) VALUES (?, ?)').run(team.id, location.id);
    logActivity('hint', `${team.name} used the extra hint for ${location.name}`, team.id);
    req.app.get('io').to('admins').emit('admin-activity');
  }

  res.json({ ok: true, hint: location.extra_hint });
});

module.exports = router;
