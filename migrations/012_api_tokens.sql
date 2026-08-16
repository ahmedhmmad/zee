-- Tokens for the read-only integration API (/api/v1/*), which exists so other
-- systems - the Ministry's fuel committee platform among them - can pull
-- vehicle positions and plot them on their own map.
--
-- Only the SHA-256 of each token is stored. The token itself is shown once, by
-- scripts/create-api-token.ts, and is not recoverable afterwards: a copy of
-- this table is then useless to whoever takes it, which matters because these
-- tokens are handed to third parties and will end up pasted into their
-- configuration files and ticket systems.
--
-- Deliberately separate from the operator console password. Revoking a
-- partner's access must not mean changing the password every driver uses, and
-- the usage columns below show which partner is actually calling.

BEGIN;

CREATE TABLE IF NOT EXISTS api_tokens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Who this was issued to, so it can be revoked by name a year from now.
  name          text        NOT NULL,
  token_sha256  char(64)    NOT NULL UNIQUE,

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,

  -- Usage, not just existence. A token that has never been used and one that
  -- fires every thirty seconds need different conversations.
  last_used_at  timestamptz,
  last_used_ip  inet,
  request_count bigint      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS api_tokens_lookup_idx
  ON api_tokens (token_sha256) WHERE is_active;

COMMENT ON TABLE api_tokens IS
  'Bearer tokens for the read-only /api/v1 integration API. SHA-256 only; '
  'the plaintext token is displayed once at creation and never stored.';

COMMIT;
