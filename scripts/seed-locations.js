/**
 * One-time helper to pre-load each team's location list (names + accepted
 * guesses) without having to type them all into the Setup page by hand.
 * Leaves "hint" and "task" blank on every location — fill those in on the
 * web Setup page (⚙️ Game Setup), since only you know what clue and task
 * you want for each spot.
 *
 * Requires the two teams to already exist (run `npm run setup` first).
 * Replaces each team's *entire* current location list — safe only while the
 * hunt hasn't started yet (same rule as the Setup page).
 *
 * Run with: npm run seed-locations
 */
const { db, getSetting } = require('../db');

// Team 1's spots, in visiting order. Each accepts a few common ways someone
// might type the name — normalizeGuess() in routes/game.js already ignores
// case and filler words like "the," so we don't need to list those variants.
const TEAM_1_LOCATIONS = [
  { name: 'CN Tower', guessAnswer: 'CN Tower|CN|Canada\'s National Tower' },
  { name: 'BeaverTails', guessAnswer: 'BeaverTails|Beaver Tails|Beavertail' },
  { name: 'Miku', guessAnswer: 'Miku|Miku Toronto|Miku Restaurant' },
  { name: 'LCBO', guessAnswer: 'LCBO|Liquor Store' },
  { name: 'Sugar Beach', guessAnswer: 'Sugar Beach' },
  { name: 'George Brown', guessAnswer: 'George Brown|George Brown College|GBC' },
  { name: 'Distillery District', guessAnswer: 'Distillery District|Distillery' },
  { name: 'Biidaasige Park', guessAnswer: 'Biidaasige Park|Biidaasige' },
];

// Team 2's spots, in visiting order.
const TEAM_2_LOCATIONS = [
  { name: 'CN Tower', guessAnswer: 'CN Tower|CN|Canada\'s National Tower' },
  { name: 'Union Station', guessAnswer: 'Union Station|Union' },
  { name: 'Hockey Hall of Fame', guessAnswer: 'Hockey Hall of Fame|HHOF|Hall of Fame' },
  { name: 'Berczy Park', guessAnswer: 'Berczy Park|Berczy' },
  { name: 'George Brown', guessAnswer: 'George Brown|George Brown College|GBC' },
  { name: 'LCBO', guessAnswer: 'LCBO|Liquor Store' },
  { name: 'Distillery District', guessAnswer: 'Distillery District|Distillery' },
  { name: 'Biidaasige Park', guessAnswer: 'Biidaasige Park|Biidaasige' },
];

function main() {
  if (getSetting('game_phase', 'lobby') !== 'lobby') {
    console.error('\nThe hunt has already started (or isn\'t reset) — this would wipe in-progress locations.');
    console.error('Run "Reset Game" on the admin Setup page first, then re-run this.\n');
    process.exit(1);
  }

  const teams = db.prepare('SELECT id, name FROM teams ORDER BY id').all();
  if (teams.length !== 2) {
    console.error(`\nExpected exactly 2 teams, found ${teams.length}. Run "npm run setup" first to create them.\n`);
    process.exit(1);
  }

  const [team1, team2] = teams;
  console.log(`\nSeeding locations for "${team1.name}" (Team 1 list) and "${team2.name}" (Team 2 list)...\n`);

  // Same dependency-order wipe the admin Setup page uses — only this team's
  // rows would need clearing in principle, but locations are always a full
  // per-team replace, so we clear everything that could reference old rows.
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM location_guesses').run();
  db.prepare('DELETE FROM locations').run();

  const insertLoc = db.prepare(`
    INSERT INTO locations (team_id, stage_order, name, hint, guess_answer, task)
    VALUES (?, ?, ?, '', ?, '')
  `);

  [[team1.id, TEAM_1_LOCATIONS], [team2.id, TEAM_2_LOCATIONS]].forEach(([teamId, locations]) => {
    locations.forEach((loc, i) => {
      insertLoc.run(teamId, i, loc.name, loc.guessAnswer);
      console.log(`  ${i + 1}. ${loc.name}`);
    });
  });

  console.log('\nDone. Every location has its name and accepted guesses set, but no hint or task yet.');
  console.log('Head to ⚙️ Game Setup on the admin dashboard and fill in each location\'s clue and task before the event.\n');
}

main();
