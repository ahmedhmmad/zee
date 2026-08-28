-- Record how far each device's clock is from ours, so a lock event can be
-- matched to the command that caused it.
--
-- A P45 lock event is stamped with the DEVICE's clock and is cached in flash
-- and delivered late - minutes late normally, hours after a coverage gap. So
-- receipt time cannot be used to decide which command an event belongs to: the
-- window would have to be hours wide, and a window that wide is ambiguous
-- exactly when several commands are in flight. The device's own reported_at is
-- the right thing to match on, but only once it is corrected onto our clock.
--
-- The plan proposed taking the offset from the time-sync handshake. It cannot
-- be taken from there: the P22,2 frame the device sends is a bare request for
-- the time and carries no device timestamp at all (src/protocol/decode-ascii.ts,
-- the `command === 'P22' && parts[2] === '2'` branch). A real-time position
-- frame is the better source anyway - it carries reportedAt from the same clock
-- that stamps a P45, so this measures precisely the thing being corrected.
--
-- Only real-time frames may be sampled. Blind-area (type 3) and backlog
-- (type 4) frames are deliberately old, and sampling one would record a device
-- as hours behind when its clock is fine.
--
-- Idempotent; adds two nullable columns and drops nothing.

BEGIN;

ALTER TABLE device_state
  ADD COLUMN IF NOT EXISTS clock_offset_ms bigint,
  ADD COLUMN IF NOT EXISTS clock_offset_at timestamptz;

COMMENT ON COLUMN device_state.clock_offset_ms IS
  'device clock minus server clock, in milliseconds, sampled from the last '
  'real-time position frame. Positive means the device is ahead. To read a '
  'device timestamp on our clock, subtract this. NULL means never sampled - '
  'and a NULL here must make an event-to-command match fail rather than fall '
  'back to raw device time.';

COMMENT ON COLUMN device_state.clock_offset_at IS
  'When the offset was last sampled. A stale offset is refused rather than '
  'trusted: device clocks drift, and a wrong correction produces a confident '
  'wrong attribution, which is worse than no attribution at all.';

COMMIT;
