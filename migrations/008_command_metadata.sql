-- Carry structured data alongside a command.
--
-- Needed for password rotation. The stored password must only change once the
-- DEVICE confirms it accepted the new one - update the database first and a
-- failed command locks you out of your own lock. So the intended new password
-- travels with the command and is promoted on success.

BEGIN;

ALTER TABLE commands ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN commands.metadata IS
  'Command-specific payload. For password rotation: {"newPassword": "..."} '
  'promoted into devices.static_password only after the device confirms.';

COMMIT;
