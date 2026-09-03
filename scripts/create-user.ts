/**
 * Create an operator account.
 *
 *   npm run user:add -- <username> <password> [--unlock]
 *
 * A CLI rather than a route, deliberately: there is no user-administration UI
 * yet, and adding one that any logged-in operator could reach would let a
 * view-only account create itself an unlock-capable one. Whoever can run this
 * already has the server.
 *
 * `--unlock` grants permission to open locks. Without it the account can watch
 * the fleet and nothing else, which is the right default: opening a valve on a
 * tanker full of petrol should be a deliberate grant, not what you get by
 * omission.
 */

import { pool } from '../src/db.ts';
import { createUser, findByUsername } from '../src/api/users.ts';

const args = process.argv.slice(2);
const mayUnlock = args.includes('--unlock');
const [username, password] = args.filter((a) => !a.startsWith('--'));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/*
 * `npm run user:add ahmed pw --unlock` without the `--` separator does not do
 * what it looks like: npm eats the flag as one of its own config options and
 * this script never sees it. The account is then created view-only while the
 * person who ran it believes they granted unlock permission.
 *
 * npm leaves the swallowed flag in the environment, which is how we can tell
 * the difference between "they did not ask for it" and "they asked and npm ate
 * it". Refuse rather than guess: silently granting valve-opening permission
 * from an inferred flag is the wrong direction to be clever in.
 */
if (!mayUnlock && process.env.npm_config_unlock) {
  fail(
    'It looks like you passed --unlock but npm consumed it as its own option.\n' +
      'Nothing has been created. Add the -- separator:\n' +
      `  npm run user:add -- ${username ?? '<username>'} '<password>' --unlock`,
  );
}

if (!username || !password) {
  fail('usage: npm run user:add -- <username> <password> [--unlock]');
}

// Six is the device password length; an operator login is not a device and has
// no such excuse.
if (password.length < 12) {
  fail(
    'Refusing a password under 12 characters. This one credential can open ' +
      'every valve in the fleet.',
  );
}

if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) {
  fail('Username must be 2-40 characters of letters, digits, dot, underscore or hyphen.');
}

if (await findByUsername(username)) {
  fail(`A user called "${username}" already exists (usernames are case-insensitive).`);
}

const user = await createUser(username, password, mayUnlock, 'cli');
console.log(
  `Created ${user.username} (id ${user.id}) — ${
    user.may_unlock ? 'MAY UNLOCK LOCKS' : 'view only'
  }.`,
);
if (!mayUnlock) console.log('Pass --unlock to grant permission to open locks.');

await pool.end();
