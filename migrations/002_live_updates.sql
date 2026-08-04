-- Push notifications for the live map, so the API never polls.
--
-- The gateway writes; the API listens and forwards to connected browsers over
-- WebSocket. Same mechanism already used for command dispatch.

BEGIN;

CREATE OR REPLACE FUNCTION notify_device_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('device_update', json_build_object(
    'kind', TG_ARGV[0],
    'deviceId', COALESCE(NEW.device_id, OLD.device_id)
  )::text);
  RETURN NULL;  -- AFTER trigger, return value is ignored
END;
$$;

CREATE TRIGGER device_state_notify
  AFTER INSERT OR UPDATE ON device_state
  FOR EACH ROW EXECUTE FUNCTION notify_device_change('state');

CREATE TRIGGER lock_events_notify
  AFTER INSERT ON lock_events
  FOR EACH ROW EXECUTE FUNCTION notify_device_change('lock_event');

CREATE TRIGGER commands_status_notify
  AFTER UPDATE OF status ON commands
  FOR EACH ROW EXECUTE FUNCTION notify_device_change('command');

COMMIT;
