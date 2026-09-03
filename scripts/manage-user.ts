/**
 * Change what an existing operator may do, or take their access away.
 *
 *   npm run user -- list
 *   npm run user -- grant-unlock <username>
 *   npm run user -- revoke-unlock <username>
 *   npm run user -- deactivate <username>
 *   npm run user -- activate <username>
 *   npm run user -- set-password <username> <password>
 *
 * The other half of `user:add`. Without it the role split is only half built:
 * there is no way to correct an account created with the wrong permission, no
 * way to retire an operator who has left, and no way to stand up the view-only
 * account needed to check that /unlock really does return 403.
 *
 * A CLI rather than a route, for the same reason as create-user.ts: a
 * user-administration screen any logged-in operator could reach would let a
 * view-only account promote itself.
 *
 * Deactivating takes effect on the account's next request, not at its next
 * login — the API resolves the user on every request precisely so that
 * withdrawing access does not wait twelve hours for a cookie to expire.
 */

import { pool } from '../src/db.ts';
import { findByUsername, hashPassword } from '../src/api/users.ts';

const [action, username, password] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE =
  'usage: npm run user -- <list|grant-unlock|revoke-unlock|activate|deactivate|set-password> [username] [password]';

if (!action) fail(USAGE);

if (action === 'list') {
  const { rows } = await pool.query<{
    id: number;
    username: string;
    may_unlock: boolean;
    is_active: boolean;
    last_login_at: Date | null;
  }>(
    `SELECT id, username, may_unlock, is_active, last_login_at
       FROM users ORDER BY id`,
  );
  if (rows.length === 0) console.log('No accounts.');
  for (const u of rows) {
    const flags = [
      u.is_active ? 'active' : 'DEACTIVATED',
      u.may_unlock ? 'MAY UNLOCK' : 'view only',
    ].join(', ');
    const seen = u.last_login_at ? u.last_login_at.toISOString().slice(0, 16).replace('T', ' ') : 'never';
    console.log(`${String(u.id).padStart(3)}  ${u.username.padEnd(20)} ${flags.padEnd(24)} last login: ${seen}`);
  }
  await pool.end();
  process.exit(0);
}

if (!username) fail(USAGE);

const user = await findByUsername(username);
if (!user) fail(`No user called "${username}".`);

switch (action) {
  case 'grant-unlock':
  case 'revoke-unlock': {
    const grant = action === 'grant-unlock';
    await pool.query('UPDATE users SET may_unlock = $2 WHERE id = $1', [user.id, grant]);
    console.log(
      `${user.username} ${grant ? 'MAY NOW OPEN LOCKS' : 'is now view only'}.` +
        (grant ? ' This account can open a valve on any tanker in the fleet.' : ''),
    );
    break;
  }

  case 'activate':
  case 'deactivate': {
    const active = action === 'activate';
    await pool.query('UPDATE users SET is_active = $2 WHERE id = $1', [user.id, active]);
    console.log(
      `${user.username} is now ${active ? 'active' : 'DEACTIVATED'}.` +
        (active ? '' : ' Any session it holds stops working on its next request.'),
    );

    // Locking out the last account that can open a lock is a thing to do on
    // purpose, not by accident on a Friday afternoon.
    if (!active) {
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM users WHERE is_active AND may_unlock',
      );
      if ((rows[0]?.n ?? 0) === 0) {
        console.warn(
          'WARNING: no active account can now open a lock. Nobody can unlock a truck ' +
            'until one is granted with: npm run user -- grant-unlock <username>',
        );
      }
    }
    break;
  }

  case 'set-password': {
    if (!password) fail('usage: npm run user -- set-password <username> <password>');
    if (password.length < 12) {
      fail('Refusing a password under 12 characters. This one credential can open every valve in the fleet.');
    }
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      await hashPassword(password),
    ]);
    console.log(`Password changed for ${user.username}.`);
    break;
  }

  default:
    fail(USAGE);
}

await pool.end();
