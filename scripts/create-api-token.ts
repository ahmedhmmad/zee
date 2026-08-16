/**
 * Issue a token for the read-only integration API.
 *
 *   sudo -u zee node --env-file=.env scripts/create-api-token.ts "Ministry fuel committee"
 *
 * Prints the token once. Only its SHA-256 is stored, so it cannot be shown
 * again - if it is lost, revoke that row and issue a new one.
 *
 * To list what has been issued and whether it is actually being used:
 *   SELECT id, name, is_active, created_at, last_used_at, request_count FROM api_tokens;
 *
 * To revoke:
 *   UPDATE api_tokens SET is_active = false WHERE name = '...';
 */

import crypto from 'node:crypto';
import { pool } from '../src/db.ts';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('usage: node scripts/create-api-token.ts "<who this is for>"');
  process.exit(2);
}

// 32 bytes of urlsafe base64. Long enough that guessing is not a threat model,
// short enough to paste into someone else's configuration without wrapping.
const token = crypto.randomBytes(32).toString('base64url');
const digest = crypto.createHash('sha256').update(token).digest('hex');

const { rows } = await pool.query<{ id: number }>(
  `INSERT INTO api_tokens (name, token_sha256, created_by) VALUES ($1, $2, $3) RETURNING id`,
  [name, digest, process.env.SUDO_USER ?? process.env.USER ?? 'unknown'],
);

console.log(`
Token created for: ${name}   (id ${rows[0]!.id})

  ${token}

This is shown once and is not recoverable. Give it to the partner over a
channel you would be willing to send a password over.

They call it as:

  curl -H "Authorization: Bearer ${token}" \\
       https://<your-host>/api/v1/vehicles.geojson

Revoke with:

  UPDATE api_tokens SET is_active = false WHERE id = ${rows[0]!.id};
`);

await pool.end();
