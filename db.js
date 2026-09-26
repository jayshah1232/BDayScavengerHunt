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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  stage_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  hint_en TEXT, -- optional overly-formal English translation of hint, for the slang/English toggle
  guess_answer TEXT NOT NULL DEFAULT '', -- pipe-separated accepted guesses, matched case/filler-word-insensitively
  task TEXT NOT NULL DEFAULT '', -- instructions (usually "take a photo of...") shown once the location is correctly guessed
  task_en TEXT, -- optional English translation of task
  admin_note TEXT,
  extra_hint TEXT, -- optional elective hint players can reveal if stuck guessing
  extra_hint_en TEXT, -- optional English translation of extra_hint
  UNIQUE(team_id, stage_order)
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  is_ready INTEGER NOT NULL DEFAULT 0, -- ready-up screen, between the admin starting the hunt and it actually going live
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

CREATE TABLE IF NOT EXISTS location_guesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  guessed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, location_id)
);

-- The bonus "find the host" round every team reaches after their regular
-- locations. Not tied to a specific location row (there's only ever one of
-- these per team) — approving any team's is what ends the whole hunt.
CREATE TABLE IF NOT EXISTS final_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  filename TEXT NOT NULL,
  media_kind TEXT NOT NULL DEFAULT 'image',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  note TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);
`);

// Migration: add the "gate" timer column to teams if this DB predates it.
const teamCols2 = db.prepare('PRAGMA table_info(teams)').all().map((c) => c.name);
if (!teamCols2.includes('finished_regular_at')) {
  db.exec('ALTER TABLE teams ADD COLUMN finished_regular_at TEXT');
}

// Migration: teams/players used to carry draft-mode captain fields (players
// self-selected teams via a draft or auto-roster choice). Teams are now
// always admin-assigned via the roster, so there's no more concept of a
// captain — drop the now-meaningless columns if an older database has them.
const teamCols = db.prepare('PRAGMA table_info(teams)').all().map((c) => c.name);
['captain_player_id', 'captain_name'].forEach((col) => {
  if (teamCols.includes(col)) {
    try {
      db.exec(`ALTER TABLE teams DROP COLUMN ${col}`);
    } catch (e) {
      console.warn(`Could not drop legacy "${col}" column from teams (harmless, ignoring): ${e.message}`);
    }
  }
});
const playerCols = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (playerCols.includes('is_captain')) {
  try {
    db.exec('ALTER TABLE players DROP COLUMN is_captain');
  } catch (e) {
    console.warn(`Could not drop legacy "is_captain" column from players (harmless, ignoring): ${e.message}`);
  }
}

// Migration: locations used to be NFC-tag-or-photo verified with no guessing
// step. The game now always asks players to guess the location from a hint
// before revealing a task (photo/video only) — old NFC fields and old rows
// aren't meaningfully convertible to that shape, so rebuild the table empty
// and clear anything that referenced those old rows.
const locationCols = db.prepare('PRAGMA table_info(locations)').all().map((c) => c.name);
if (!locationCols.includes('team_id') || locationCols.includes('verification_type') || !locationCols.includes('guess_answer')) {
  db.exec(`
    DELETE FROM hint_requests;
    DELETE FROM stage_completions;
    DELETE FROM submissions;
    DELETE FROM location_guesses;
    DROP TABLE locations;
    CREATE TABLE locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      stage_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      hint TEXT NOT NULL,
      hint_en TEXT,
      guess_answer TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      task_en TEXT,
      admin_note TEXT,
      extra_hint TEXT,
      extra_hint_en TEXT,
      UNIQUE(team_id, stage_order)
    );
  `);
  db.prepare('UPDATE teams SET current_stage = 0').run();
  console.log('Database migrated: locations now use a guess-the-spot-then-do-a-task flow (NFC support removed). Reconfigure locations on the Setup page.');
}

// Migration: add the optional English-translation columns (slang/English
// toggle) if this DB predates them.
const locationCols2 = db.prepare('PRAGMA table_info(locations)').all().map((c) => c.name);
['hint_en', 'task_en', 'extra_hint_en'].forEach((col) => {
  if (!locationCols2.includes(col)) {
    db.exec(`ALTER TABLE locations ADD COLUMN ${col} TEXT`);
  }
});

// Migration: add the ready-up flag to players if this DB predates it.
const playerCols2 = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (!playerCols2.includes('is_ready')) {
  db.exec('ALTER TABLE players ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0');
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

function logActivity(type, message, teamId = null) {
  db.prepare('INSERT INTO activity_log (type, message, team_id) VALUES (?, ?, ?)').run(type, message, teamId);
}

// Seconds a team must wait at the "Ah Ah We Aint Done Yet" gate (after their
// last regular location) before the bonus final-round challenge unlocks.
const GATE_WAIT_SECONDS = 30;

// Seconds between everyone hitting "Ready" and the hunt actually going live.
const READY_COUNTDOWN_SECONDS = 3;

// The single place a team's stage ever moves forward through their regular
// locations — whether triggered by an admin approving media or a manual
// backup override. If this lands them exactly on "total" (no locations
// left), they've hit the gate — stamp when, so the wait can be timed
// server-side regardless of what the client does.
function advanceTeamStage(teamId, locationId) {
  db.prepare('UPDATE teams SET current_stage = current_stage + 1 WHERE id = ?').run(teamId);
  db.prepare('INSERT INTO stage_completions (team_id, location_id) VALUES (?, ?)').run(teamId, locationId);

  const team = db.prepare('SELECT current_stage FROM teams WHERE id = ?').get(teamId);
  const total = db.prepare('SELECT COUNT(*) AS c FROM locations WHERE team_id = ?').get(teamId).c;
  if (team.current_stage === total) {
    db.prepare("UPDATE teams SET finished_regular_at = datetime('now') WHERE id = ?").run(teamId);
  }
}

// The hunt now only ends when someone's final-round submission is approved
// (see routes/admin.js) — finishing regular locations just unlocks the gate
// and then the bonus round, not the game itself.
function endGame(winningTeamId, winningTeamName) {
  setSetting('game_phase', 'ended');
  setSetting('winning_team_id', String(winningTeamId));
  logActivity('game', `${winningTeamName} found the host and won the hunt! 🏆`, winningTeamId);
}

// Minutes since this team last did anything player-driven (a correct guess or
// a media submission), used for the "this team's gone quiet" admin nudge.
// Falls back to when the hunt started if they haven't done anything yet.
function minutesSinceLastPlayerActivity(teamId) {
  const row = db.prepare(
    `SELECT ts FROM activity_log WHERE team_id = ? AND type IN ('guess', 'submission') ORDER BY ts DESC LIMIT 1`
  ).get(teamId);
  const baseline = row ? row.ts : getSetting('hunt_started_at');
  if (!baseline) return null;
  const then = new Date(baseline.replace(' ', 'T') + 'Z').getTime();
  return Math.floor((Date.now() - then) / 60000);
}

// Wipes players and all in-game progress so a fresh test/event can start,
// while keeping configuration intact (locations, team names, roster, gate
// question, admin password). Used by the admin Setup page's "Reset Game" action.
function resetGameProgress() {
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM final_submissions').run();
  db.prepare('DELETE FROM location_guesses').run();
  db.prepare('DELETE FROM activity_log').run();
  db.prepare('DELETE FROM players').run();
  db.prepare('UPDATE teams SET current_stage = 0, finished_regular_at = NULL').run();
  db.prepare("DELETE FROM settings WHERE key IN ('hunt_started_at', 'winning_team_id', 'all_ready_at')").run();
  setSetting('game_phase', 'lobby');
}

module.exports = {
  db, getSetting, setSetting, logActivity,
  advanceTeamStage, endGame, minutesSinceLastPlayerActivity, resetGameProgress,
  GATE_WAIT_SECONDS, READY_COUNTDOWN_SECONDS,
};
