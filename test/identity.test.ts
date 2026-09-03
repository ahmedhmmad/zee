/**
 * Named operators, permission to unlock, and keeping credentials out of the
 * places that keep copies of things.
 *
 * Before this, authentication was one shared password, the session cookie's
 * whole payload was the literal string 'ok', and every audit row was attributed
 * to `operator@<ip>`. One credential opened any valve in the fleet and nothing
 * recorded who used it — on the records the Ministry relies on to say who
 * opened a tanker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
process.env.AUTH_PASSWORD ??= 'unused-in-these-tests';

const { hashPassword, verifyPassword } = await import('../src/api/users.ts');
const { RateLimiter } = await import('../src/api/config.ts');
const { redactPayload } = await import('../src/gateway/session.ts');

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(root + p, 'utf8');

// --- Password hashing --------------------------------------------------------

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('correct horse battery stapl', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently every time', async () => {
  // Salted. Two operators who pick the same password must not be visibly the
  // same in the table, and a stolen dump must not be attackable once for all.
  const a = await hashPassword('same-password-twice');
  const b = await hashPassword('same-password-twice');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-twice', a), true);
  assert.equal(await verifyPassword('same-password-twice', b), true);
});

test('the hash carries its own parameters, so they can be raised later', async () => {
  const hash = await hashPassword('whatever');
  const [scheme, N, r, p, salt, key] = hash.split('$');
  assert.equal(scheme, 'scrypt');
  assert.equal(Number(N), 16_384);
  assert.ok(Number(r) > 0 && Number(p) > 0);
  assert.equal(Buffer.from(salt!, 'hex').length, 16);
  assert.equal(Buffer.from(key!, 'hex').length, 64);
});

test('a corrupt stored hash fails the login rather than the process', async () => {
  // A bad row must not be able to take the login route down for everyone.
  for (const bad of ['', 'not-a-hash', 'scrypt$x$8$1$aa$bb', 'scrypt$16384$8$1$aa', '$$$$$']) {
    assert.equal(await verifyPassword('anything', bad), false, `should reject: ${bad}`);
  }
});

// --- Rate limiting -----------------------------------------------------------

test('a limiter allows its limit and then refuses', () => {
  const limiter = new RateLimiter(3, 60_000);
  assert.deepEqual([1, 2, 3].map(() => limiter.allow('k')), [true, true, true]);
  assert.equal(limiter.allow('k'), false);
  assert.equal(limiter.allow('k'), false);
});

test('keys are counted separately', () => {
  // Or one busy operator locks out everybody else.
  const limiter = new RateLimiter(1, 60_000);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('b'), true);
  assert.equal(limiter.allow('a'), false);
});

test('the window rolls over', async () => {
  const limiter = new RateLimiter(1, 40);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(limiter.allow('k'), true);
});

test('a successful login forgets the failures before it', () => {
  // Otherwise a typo costs an operator their next four attempts.
  const limiter = new RateLimiter(2, 60_000);
  limiter.allow('k');
  limiter.allow('k');
  limiter.clear('k');
  assert.equal(limiter.allow('k'), true);
});

// --- Credentials out of the records ------------------------------------------

test('an audited payload keeps the command word and drops the secret', () => {
  assert.equal(redactPayload('unlock_static', '(P43,123456)'), '(P43,<redacted>)');
  assert.equal(redactPayload('set_password', '(P44,654321,123456)'), '(P44,<redacted>)');
  // Nothing sensitive in a query or a setting; keeping it whole is what makes
  // an audit row worth reading.
  assert.equal(redactPayload('query_position', '(P02)'), '(P02)');
  assert.equal(redactPayload('set_intervals', '(P04,1,60,30)'), '(P04,1,60,30)');
});

test('the queue stores a placeholder, never the password', () => {
  const routes = read('src/api/routes.ts');
  const arrivals = read('src/gateway/arrivals.ts');

  // commands.payload lives for the life of the authorisation and is readable
  // by anyone with database access. It was carrying every truck's unlock
  // password in clear.
  assert.doesNotMatch(routes, /\(P43,\$\{device\.static_password\}\)/);
  assert.doesNotMatch(arrivals, /\(P43,\$\{password\}\)/);
  assert.match(routes, /\{\{static_password\}\}/);
  assert.match(arrivals, /\{\{static_password\}\}/);
  // Neither password in the rotation payload either.
  assert.doesNotMatch(routes, /\(P44,\$\{next\},\$\{current\}\)/);
});

test('the placeholder is filled in at dispatch, and refused when it cannot be', () => {
  const store = read('src/gateway/store.ts');
  const claim = /export async function claimPendingCommands[\s\S]*?\n\}/.exec(store)![0]!;
  assert.match(claim, /replace\(u\.payload, '\{\{static_password\}\}'/);

  // A missing password must yield null, not a frame reading "(P43,)". Checked
  // per placeholder, because a blanket replace() with NULL would blank every
  // ordinary payload that has no placeholder at all.
  assert.match(claim, /d\.static_password IS NULL THEN NULL/);

  const session = read('src/gateway/session.ts');
  assert.match(session, /if \(cmd\.payload === null\)/);
});

test('the audit trail records a person, not an address', () => {
  const routes = read('src/api/routes.ts');
  const actorOf = /function actorOf\(req: FastifyRequest\): string \{[\s\S]*?\n\}/.exec(routes);
  assert.ok(actorOf, 'actorOf not found');
  assert.doesNotMatch(actorOf[0]!, /operator@/, 'an IP is not an identity');
  assert.match(actorOf[0]!, /String\(user\.id\)/);
  // The address is still recorded — in the column for addresses.
  assert.match(routes, /INSERT INTO audit_log \(actor, action, device_id, command_id, detail, ip_address\)/);
});

test('the session cookie carries who, not merely that somebody knew a password', () => {
  const config = read('src/api/config.ts');
  assert.doesNotMatch(config, /unsigned\.value === 'ok'/);
  assert.match(config, /sessionUserId\(req: FastifyRequest\): number \| null/);
  assert.match(read('src/api/routes.ts'), /setCookie\(apiConfig\.cookieName, String\(user\.id\)/);
});

// --- Permission --------------------------------------------------------------

test('everything that opens a lock requires the unlock role', () => {
  const routes = read('src/api/routes.ts');
  for (const route of [
    "app.post('/api/devices/:id/unlock'",
    "app.post('/api/devices/:id/sublocks/:subId/unlock'",
    // Arming an arrival rule IS authorising an unlock, one that fires with
    // nobody deciding in the moment.
    "app.post('/api/devices/:id/arrivals'",
  ]) {
    const i = routes.indexOf(route);
    assert.ok(i !== -1, `${route} not found`);
    const body = routes.slice(i, i + 1200);
    assert.match(body, /await requireUnlockRole\(req, reply\)/, `${route} is not role-gated`);
  }
});

test('a deactivated account stops working at its next request', () => {
  // Not at its next login. A cookie is good for twelve hours, and twelve hours
  // of an ex-operator being able to open valves is not a rounding error.
  const routes = read('src/api/routes.ts');
  assert.match(routes, /account_inactive/);
  assert.match(read('src/api/users.ts'), /WHERE id = \$1 AND is_active/);
});

test('login is rate limited per account and per address', () => {
  // Either alone is trivially sidestepped: one account from a botnet, or one
  // address working through a list of usernames.
  const routes = read('src/api/routes.ts');
  assert.match(routes, /loginByIp\.allow\(req\.ip\)/);
  assert.match(routes, /loginByUser\.allow\(name\.toLowerCase\(\)\)/);
  assert.match(routes, /unlockByUser\.allow\(actor\) && unlockByIp\.allow\(req\.ip\)/);
});

test('a missing account costs the same time as a wrong password', () => {
  // Response time alone would otherwise enumerate valid usernames.
  const routes = read('src/api/routes.ts');
  assert.match(routes, /DUMMY_HASH/);
  assert.match(routes, /const DUMMY_HASH = await hashPassword\(/);
});

test('AUTH_DISABLED cannot be set outside development', () => {
  // It opens the console AND the unlock endpoint on one environment variable.
  // "Must not be set in production" in a comment is not a control.
  const config = read('src/api/config.ts');
  assert.match(config, /authDisabled && nodeEnv !== 'development'/);
  assert.match(config, /throw new Error\(/);
});
