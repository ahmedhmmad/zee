/**
 * Named operators, their passwords, and what they are allowed to do.
 *
 * Password hashing is `scrypt` from `node:crypto` — deliberately not a
 * dependency. scrypt is memory-hard and is what Node ships for exactly this.
 *
 * The parameters travel inside the stored string, so raising them later does
 * not invalidate every existing hash: an old hash still verifies with its own
 * parameters, and is rewritten at the next successful login.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from '../db.ts';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/**
 * N=16384, r=8, p=1 — the classic interactive-login parameters, about 16MB and
 * ~50ms per hash on this class of box. Node's default maxmem is 32MB, which
 * N=16384 fits; raising N means raising maxmem with it.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 };
const KEY_LEN = 64;

export interface User {
  id: number;
  username: string;
  may_unlock: boolean;
  is_active: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Verify a candidate against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt row
 * must fail the login, never take the login route down.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5]!, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  try {
    const key = await scrypt(password, Buffer.from(parts[4]!, 'hex'), expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    });
    // Constant time: a byte-by-byte comparison leaks how much of the hash
    // matched, which is enough to attack it offline given the stored salt.
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Look a user up for login. Case-insensitive, matching the unique index. */
export async function findByUsername(username: string): Promise<(User & { password_hash: string }) | null> {
  const { rows } = await pool.query<User & { password_hash: string }>(
    `SELECT id, username, password_hash, may_unlock, is_active
       FROM users WHERE lower(username) = lower($1)`,
    [username],
  );
  return rows[0] ?? null;
}

/** The user behind a session id, or null if they are gone or deactivated. */
export async function findActiveById(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `SELECT id, username, may_unlock, is_active
       FROM users WHERE id = $1 AND is_active`,
    [id],
  );
  return rows[0] ?? null;
}

export async function recordLogin(id: number): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]).catch(() => {});
}

export async function createUser(
  username: string,
  password: string,
  mayUnlock: boolean,
  createdBy: string,
): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (username, password_hash, may_unlock, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, may_unlock, is_active`,
    [username.trim(), await hashPassword(password), mayUnlock, createdBy],
  );
  return rows[0]!;
}

export async function userCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return rows[0]?.n ?? 0;
}

/**
 * Carry the existing shared credential into a named account, once.
 *
 * Without this, deploying the named-users change locks every operator out of a
 * live system until somebody runs a script — on a platform whose whole purpose
 * is to open valves for trucks that are already on the road. So the first start
 * after the migration turns AUTH_PASSWORD into a real account called
 * `operator`, and says loudly that it is still one shared credential and still
 * has to be replaced.
 *
 * Only ever when the table is empty. It cannot resurrect or overwrite an
 * account, and it does nothing on every subsequent start.
 */
export async function seedFromSharedPassword(sharedPassword: string): Promise<boolean> {
  if (!sharedPassword) return false;
  if ((await userCount()) > 0) return false;

  await createUser('operator', sharedPassword, true, 'migration');
  console.warn(
    '[api] Created the account "operator" from AUTH_PASSWORD so nobody is locked out. ' +
      'It is STILL ONE SHARED CREDENTIAL: create a named account per person ' +
      '(npm run user:add) and deactivate this one. Until then the audit trail ' +
      'cannot say who opened a valve.',
  );
  return true;
}
