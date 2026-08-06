-- Surface data the gateway already receives but had nowhere to put.

BEGIN;

-- Firmware string from the P01 response, e.g.
-- JT701D_20250521_China_Jointech_BleRfid_NOTURN_SIM7600G_LoRaN1987-SX127X_PCBV2.3_R2.3.1
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_version text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_seen_at timestamptz;

-- Present in every position frame; previously only stored per-row.
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS mileage_km integer;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS mcc integer;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS mnc integer;

COMMIT;
