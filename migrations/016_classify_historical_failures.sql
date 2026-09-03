-- Classify the failures already in the table, so the repeated-failure lockout
-- stops counting things that were never the device's answer.
--
-- /unlock refuses a third unlock after two failed ones, on the reasoning that a
-- wrong stored password fails identically every time. That reasoning only holds
-- for failures the DEVICE reported. Until now a socket that broke mid-write was
-- recorded exactly like a rejected password, so two dropped connections locked
-- an operator out of a truck whose password was always correct.
--
-- The code fix stops new rows appearing. It does nothing about the rows already
-- there: without this backfill the lockout survives its own fix, because the
-- count still finds two old 'socket write failed' rows and refuses. So this is
-- not tidying-up - it is the half of the fix that unblocks the trucks.
--
-- Anything that cannot be classified from its recorded error becomes
-- 'unclassified', never 'device_rejected'. Guessing in the other direction
-- would invent a password rejection that may never have happened and keep a
-- truck locked out on the strength of it. An unclassified row is not counted.
--
-- Idempotent: only rows with no cause yet are touched.

BEGIN;

-- The transport failure the gateway used to write for any unsuccessful
-- write(), including plain backpressure - which was not a failure at all.
UPDATE commands
   SET failure_cause = 'transport'
 WHERE failure_cause IS NULL
   AND last_error = 'socket write failed';

UPDATE commands
   SET failure_cause = 'no_response'
 WHERE failure_cause IS NULL
   AND last_error = 'no response from device after 3 attempts';

UPDATE commands
   SET failure_cause = 'cancelled'
 WHERE failure_cause IS NULL
   AND last_error = 'cancelled by operator';

-- Everything else that ended badly. The device's own refusal was written here
-- as the raw response text, and so were errors from a dozen other places, with
-- nothing recorded to tell them apart. They are not counted.
UPDATE commands
   SET failure_cause = 'unclassified'
 WHERE failure_cause IS NULL
   AND status IN ('failed', 'rejected', 'expired');

COMMIT;
