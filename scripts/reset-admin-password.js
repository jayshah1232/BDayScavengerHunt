/**
 * Reset the admin password without touching anything else — teams, locations,
 * players, and the gate question are all left exactly as they are.
 * Run with: npm run reset-admin-password
 * Safe to run any time, including mid-event, since it only ever changes
 * admin_password_hash.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { setSetting } = require('../db');

// Same reliable pattern as scripts/setup.js — readline's built-in question()
// can silently stop resolving on the second call depending on how stdin is
// fed to the process.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lineIterator = rl[Symbol.asyncIterator]();
async function ask(promptText) {
  process.stdout.write(promptText);
  const { value, done } = await lineIterator.next();
  return done ? '' : value;
}

async function main() {
  console.log('\n=== Reset Admin Password ===\n');
  console.log('This only changes the admin password. Teams, locations, players,');
  console.log('and the gate question are all left untouched.\n');

  const newPassword = (await ask('New admin password: ')).trim();
  if (!newPassword) {
    console.log('\nNo password entered — nothing was changed.\n');
    rl.close();
    return;
  }

  setSetting('admin_password_hash', bcrypt.hashSync(newPassword, 10));
  console.log('\nAdmin password updated — takes effect immediately, no restart needed.');
  console.log('Log into /admin with the new password.\n');
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
