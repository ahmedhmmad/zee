-- Give the audit trail a person in it.
--
-- Today authentication is one shared AUTH_PASSWORD, the session cookie's entire
-- payload is the literal string 'ok' — it carries no identity whatsoever — and
-- every audit row is attributed to `operator@<client ip>`. So one credential
-- opens any valve in the fleet and nothing records who used it.
--
-- These records are the Ministry's accountability trail for unlocking valves on
-- fuel tankers. "Somebody with the password, from this IP" is not an answer to
-- "who opened this truck".
--
-- Deliberately the minimum that makes the trail mean something. Not SSO, not
-- fine-grained RBAC, not delegated administration — one table, one role
-- distinction, and real attribution. The rest is Phase 2.
--
-- Idempotent. Nothing is deleted; the historical actor strings are moved into
-- the ip_address column they belong in rather than being discarded.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL,
  -- scrypt, from node:crypto — no new dependency, per the repo's
  -- dependency-light posture. Format: scrypt$N$r$p$<salt hex>$<hash hex>, so
  -- the parameters travel with the hash and can be raised later without
  -- invalidating existing ones.
  password_hash text        NOT NULL,

  /*
   * The one role distinction: may this person open a valve?
   *
   * Not a permission matrix. Viewing the fleet and opening a tanker full of
   * petrol are different kinds of act, and that is the distinction worth having
   * before a pilot. Everything finer waits for Phase 2.
   *
   * Defaults to false: a new account can watch, and someone has to decide
   * deliberately that it can unlock.
   */
  may_unlock    boolean     NOT NULL DEFAULT false,

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  last_login_at timestamptz
);

-- Usernames are matched case-insensitively, so they must be unique that way
-- too, or "Ahmed" and "ahmed" become two accounts that look like one person.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

COMMENT ON TABLE users IS
  'Named operators. The session cookie carries this id, and audit_log.actor is '
  'it — so every unlock has a person against it, not just an IP.';

-- ---------------------------------------------------------------------------
-- The trail that already exists.
-- ---------------------------------------------------------------------------

-- Old rows say `operator@10.0.0.5`, which is an address wearing an identity's
-- clothes. Move the address to the column for addresses, then say plainly that
-- the actor is not known — an honest gap is worth more than a field that looks
-- like attribution and is not.
UPDATE audit_log
   SET ip_address = COALESCE(ip_address, substring(actor from '^operator@(.+)$'))
 WHERE actor LIKE 'operator@%';

UPDATE audit_log
   SET actor = 'unknown-legacy'
 WHERE actor LIKE 'operator@%';

COMMENT ON COLUMN audit_log.actor IS
  'The users.id that performed this, as text; "gateway" or "system" for actions '
  'the platform took itself; "unknown-legacy" for rows written before named '
  'users existed, when the only credential was shared.';

COMMIT;
