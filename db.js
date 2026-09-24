const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hunt.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  current_stage INTEGER NOT NULL DEFAULT 0,
  captain_name TEXT,
  captain_player_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  stage_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  admin_note TEXT,
  verification_type TEXT NOT NULL DEFAULT 'media', -- 'media' | 'nfc'
  nfc_token TEXT UNIQUE,
  nfc_backup_code TEXT,
  nfc_question TEXT,
  nfc_answer TEXT, -- pipe-separated list of accepted answers, case/space-insensitive
  extra_hint TEXT, -- optional elective hint players can reveal if stuck
  UNIQUE(team_id, stage_order)
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  is_captain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  player_id INTEGER REFERENCES players(id),
  filename TEXT NOT NULL,
  media_kind TEXT NOT NULL DEFAULT 'image', -- 'image' | 'video'
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  note TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS stage_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  completed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hint_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  requested_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, location_id)
);
`);

// Migration: locations used to be one shared sequence for both teams; now
// each team has its own pool (a team_id column, and stage_order unique per
// team instead of globally). An older database won't have team_id yet — old
// location rows aren't meaningfully assignable to either team, so rebuild
// the table empty and clear anything that referenced those old rows.
const locationCols = db.prepare("PRAGMA table_info(locations)").all().map((c) => c.name);
if (!locationCols.includes('team_id')) {
  db.exec(`
    DELETE FROM hint_requests;
    DELETE FROM stage_completions;
    DELETE FROM submissions;
    DROP TABLE locations;
    CREATE TABLE locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      stage_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      hint TEXT NOT NULL,
      admin_note TEXT,
      verification_type TEXT NOT NULL DEFAULT 'media',
      nfc_token TEXT UNIQUE,
      nfc_backup_code TEXT,
      nfc_question TEXT,
      nfc_answer TEXT,
      extra_hint TEXT,
      UNIQUE(team_id, stage_order)
    );
  `);
  db.prepare('UPDATE teams SET current_stage = 0').run();
  console.log('Database migrated: locations are now a separate pool per team. Run "npm run setup" or use the Setup page to configure each team\'s locations.');
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Atomic "first click wins" lock for team_mode. Returns the mode that ended
// up locked in — either the one this call just set, or whatever a concurrent
// caller beat us to a moment earlier.
function lockTeamMode(mode) {
  const existing = getSetting('team_mode');
  if (existing) return existing;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('team_mode', ?)
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN settings.value IS NULL THEN excluded.value ELSE settings.value END`
  ).run(mode);
  return getSetting('team_mode');
}

function logActivity(type, message, teamId = null) {
  db.prepare('INSERT INTO activity_log (type, message, team_id) VALUES (?, ?, ?)').run(type, message, teamId);
}

// The single place a team's stage ever moves forward — whether triggered by
// an admin approving media, a successful NFC check-in, or a manual backup
// override. Keeping this in one function means the time-tracking record and
// the auto-end-game check can never accidentally be skipped by one path.
function advanceTeamStage(teamId, locationId) {
  db.prepare('UPDATE teams SET current_stage = current_stage + 1 WHERE id = ?').run(teamId);
  db.prepare('INSERT INTO stage_completions (team_id, location_id) VALUES (?, ?)').run(teamId, locationId);
  const wasActive = getSetting('game_phase') === 'active';
  maybeEndGame();
  return { gameJustEnded: wasActive && getSetting('game_phase') === 'ended' };
}

function maybeEndGame() {
  const teams = db.prepare('SELECT id, current_stage FROM teams').all();
  if (teams.length === 0) return;
  const stillGoing = teams.filter((t) => {
    const total = db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(t.id).c;
    return total === 0 || t.current_stage < total;
  });
  if (stillGoing.length === 0 && getSetting('game_phase') === 'active') {
    setSetting('game_phase', 'ended');
    logActivity('game', 'All teams have finished — the hunt has ended!');
  }
}

// Minutes since this team last did anything player-driven (a check-in or a
// media submission), used for the "this team's gone quiet" admin nudge.
// Falls back to when the hunt started if they haven't done anything yet.
function minutesSinceLastPlayerActivity(teamId) {
  const row = db.prepare(
    `SELECT ts FROM activity_log WHERE team_id = ? AND type IN ('checkin', 'submission') ORDER BY ts DESC LIMIT 1`
  ).get(teamId);
  const baseline = row ? row.ts : getSetting('hunt_started_at');
  if (!baseline) return null;
  const then = new Date(baseline.replace(' ', 'T') + 'Z').getTime();
  return Math.floor((Date.now() - then) / 60000);
}

// Wipes players and all in-game progress so a fresh test/event can start,
// while keeping configuration intact (locations, team names/captains,
// gate question, admin password, roster). Used by the admin Setup page's
// "Reset Game" action.
function resetGameProgress() {
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM activity_log').run();
  db.prepare('DELETE FROM players').run();
  db.prepare('UPDATE teams SET current_stage = 0, captain_player_id = NULL').run();
  db.prepare("DELETE FROM settings WHERE key IN ('team_mode', 'draft_complete', 'draft_current_turn_team_id', 'hunt_started_at')").run();
  setSetting('game_phase', 'lobby');
}

module.exports = {
  db, getSetting, setSetting, lockTeamMode, logActivity,
  advanceTeamStage, maybeEndGame, minutesSinceLastPlayerActivity, resetGameProgress,
};
