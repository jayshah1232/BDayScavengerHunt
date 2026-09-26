/**
 * Load both teams' full location lists from a CSV file — no more typing
 * everything into the Setup page by hand.
 *
 * Expected CSV columns (header row required, any order):
 *   Name, Acceptable Answers, Clue, Task, Extra Hint, Team, Order
 * - "Acceptable Answers" is pipe-separated ("CN Tower|CN|Canada's National Tower"),
 *   matched case-insensitively and ignoring filler words like "the" — same
 *   format the Setup page uses.
 * - "Team" is "1", "2", or "BOTH" for a stop shared by both teams' routes
 *   (a shared stop can also just be two separate rows, one per team, with
 *   "Team" set to "1" and "2" respectively — either way works).
 * - "Order" is that team's visiting order for the row (1, 2, 3, ...) — each
 *   team's list is its own rows sorted by this number, so the two teams can
 *   visit a shared stop at completely different points in their routes.
 *
 * Requires the two teams to already exist (run `npm run setup` first).
 * Replaces each team's *entire* current location list — safe only while the
 * hunt hasn't started yet (same rule as the Setup page).
 *
 * Run with: npm run seed-locations -- /path/to/LocationSeed.csv
 */
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore, \n (if present) ends the row */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function loadRecords(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows.');

  const header = rows[0].map((h) => h.trim());
  const required = ['Name', 'Acceptable Answers', 'Clue', 'Task', 'Extra Hint', 'Team', 'Order'];
  const missing = required.filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);

  return rows.slice(1).map((cells) => {
    const rec = {};
    header.forEach((h, i) => { rec[h] = (cells[i] || '').trim(); });
    return rec;
  });
}

function locationsForTeam(records, teamNumber) {
  const rows = records.filter((r) => {
    const team = r.Team.toUpperCase();
    return team === 'BOTH' || team === String(teamNumber);
  });

  const withOrder = rows.map((r) => {
    const order = Number(r.Order);
    if (!r.Order || Number.isNaN(order)) {
      throw new Error(`Row for "${r.Name}" (Team ${r.Team}) has an invalid Order value: "${r.Order}"`);
    }
    return {
      name: r.Name,
      hint: r.Clue,
      guessAnswer: r['Acceptable Answers'],
      task: r.Task,
      extraHint: r['Extra Hint'],
      order,
    };
  });

  const seenOrders = new Set();
  withOrder.forEach((loc) => {
    if (seenOrders.has(loc.order)) {
      throw new Error(`Team ${teamNumber} has two rows with Order ${loc.order} — each row needs a unique order per team.`);
    }
    seenOrders.add(loc.order);
  });

  return withOrder.sort((a, b) => a.order - b.order);
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('\nUsage: npm run seed-locations -- /path/to/LocationSeed.csv\n');
    process.exit(1);
  }
  const resolvedPath = path.resolve(csvPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`\nCan't find a file at: ${resolvedPath}\n`);
    process.exit(1);
  }

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

  let records;
  try {
    records = loadRecords(resolvedPath);
  } catch (err) {
    console.error(`\nCouldn't read that CSV: ${err.message}\n`);
    process.exit(1);
  }

  const [team1, team2] = teams;
  let team1Locations, team2Locations;
  try {
    team1Locations = locationsForTeam(records, 1);
    team2Locations = locationsForTeam(records, 2);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  if (!team1Locations.length || !team2Locations.length) {
    console.error('\nAt least one team ended up with zero locations — check the "Team" column uses "1", "2", or "BOTH".\n');
    process.exit(1);
  }

  console.log(`\nSeeding locations for "${team1.name}" (Team 1 rows) and "${team2.name}" (Team 2 rows) from ${resolvedPath}...\n`);

  // Same dependency-order wipe the admin Setup page uses — locations are
  // always a full per-team replace, so clear everything that could
  // reference the old rows first.
  db.prepare('DELETE FROM hint_requests').run();
  db.prepare('DELETE FROM stage_completions').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM location_guesses').run();
  db.prepare('DELETE FROM locations').run();

  const insertLoc = db.prepare(`
    INSERT INTO locations (team_id, stage_order, name, hint, guess_answer, task, extra_hint)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  [[team1.id, team1Locations], [team2.id, team2Locations]].forEach(([teamId, locations]) => {
    locations.forEach((loc, i) => {
      insertLoc.run(teamId, i, loc.name, loc.hint, loc.guessAnswer, loc.task, loc.extraHint || null);
      console.log(`  ${i + 1}. ${loc.name}`);
    });
  });

  console.log('\nDone — every location has its clue, accepted guesses, task, and extra hint set.');
  console.log('Spot-check them on the Setup page (⚙️ Game Setup) before the event.\n');
}

main();
