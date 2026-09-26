/**
 * Interactive one-time setup. Run with: npm run setup
 * Safe to re-run before the event — it overwrites config. Don't re-run mid-game.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db, setSetting } = require('../db');

// We deliberately avoid readline's built-in question() — calling it
// repeatedly can silently stop resolving depending on how stdin is fed to
// the process. Pulling lines from the async iterator directly is the
// reliable pattern for a multi-prompt CLI like this one.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lineIterator = rl[Symbol.asyncIterator]();
async function ask(promptText) {
  process.stdout.write(promptText);
  const { value, done } = await lineIterator.next();
  return done ? '' : value;
}

async function main() {
  console.log('\n=== Scavenger Hunt Setup ===\n');

  console.log('The "gate" is a shared question only your friend group would know the answer to.');
  console.log('This is not per-person security — it just filters out strangers finding the link.\n');
  const gateQ = await ask('Gate question: ');
  const gateA = await ask('Gate answer: ');
  setSetting('gate_question', gateQ.trim());
  setSetting('gate_answer_hash', bcrypt.hashSync(gateA.trim().toLowerCase(), 10));

  const adminPass = await ask('\nAdmin password (yours, for reviewing submissions): ');
  setSetting('admin_password_hash', bcrypt.hashSync(adminPass, 10));

  const title = await ask('\nGame title (shown to players) [Scavenger Hunt]: ');
  setSetting('game_title', title.trim() || 'Scavenger Hunt');

  // --- Teams + roster ---
  // Teams are entirely admin-assigned — there's no draft or self-pick anymore,
  // so every player who'll join needs to be on one team's roster ahead of time.
  console.log('\nSetting up exactly 2 teams. You assign every player to a team here (or later on the Setup page) —');
  console.log('players never pick their own team.\n');
  const team1Name = (await ask('Team 1 name [Team A]: ')).trim() || 'Team A';
  const team2Name = (await ask('Team 2 name [Team B]: ')).trim() || 'Team B';

  // Wipe in dependency order — every one of these tables references teams
  // and/or locations via foreign keys, so children have to go first or the
  // deletes below fail with "FOREIGN KEY constraint failed" (locations and
  // final_submissions both reference teams; the rest reference locations).
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM final_submissions').run();
  db.prepare('DELETE FROM location_guesses').run();
  db.prepare('DELETE FROM locations').run();
  db.prepare('DELETE FROM activity_log').run();
  db.prepare('DELETE FROM players').run();
  db.prepare('DELETE FROM teams').run();
  const insertTeam = db.prepare('INSERT INTO teams (name) VALUES (?)');
  const t1 = insertTeam.run(team1Name);
  const t2 = insertTeam.run(team2Name);

  const rosterMap = {};
  for (const [teamName, teamId] of [[team1Name, t1.lastInsertRowid], [team2Name, t2.lastInsertRowid]]) {
    const namesRaw = await ask(`Names for ${teamName}, comma-separated (as they'll type them when they join): `);
    namesRaw.split(',').map((n) => n.trim()).filter(Boolean).forEach((n) => {
      rosterMap[n.toLowerCase()] = teamId;
    });
  }
  setSetting('roster_map', JSON.stringify(rosterMap));

  // --- Locations ---
  // Each team gets its own separate pool of locations — configuring two full
  // lists interactively here would be tedious. This just creates one
  // placeholder per team so the game is immediately startable; use the web
  // Setup page (⚙️ Game Setup on the dashboard) to actually build out each
  // team's real list, with add/remove/reorder controls. (Already wiped above,
  // in the same pass as teams — no need to clear again here.)
  const insertLoc = db.prepare(`
    INSERT INTO locations (team_id, stage_order, name, hint, guess_answer, task)
    VALUES (?, 0, ?, ?, ?, ?)
  `);
  insertLoc.run(t1.lastInsertRowid, 'Placeholder location', 'Set this up on the Setup page before the event!', 'placeholder', 'Set the real task text on the Setup page.');
  insertLoc.run(t2.lastInsertRowid, 'Placeholder location', 'Set this up on the Setup page before the event!', 'placeholder', 'Set the real task text on the Setup page.');

  console.log(`\nSetup complete: teams "${team1Name}" and "${team2Name}" are ready.`);
  console.log('Each has one placeholder location — go to ⚙️ Game Setup on the admin dashboard');
  console.log('to build out each team\'s real location list: a hint, the accepted guesses, and the');
  console.log('task players get once they guess right.');
  console.log('\nStart the server with: npm start\n');
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
