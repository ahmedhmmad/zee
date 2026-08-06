#!/usr/bin/env bash
# Watch for a real device connecting. Filters out scanner noise.
DB="${1:?usage: check-device.sh <DATABASE_URL>}"
echo "=== devices on the allowlist ==="
psql "$DB" -tAc "SELECT device_id || '  ' || name FROM devices WHERE is_active;"
echo
echo "=== live state ==="
psql "$DB" -c "SELECT device_id, last_seen_at, is_connected, positioned, satellites, battery_percent, gsm_signal FROM device_state;"
echo "=== frames refused that DID carry a device id (i.e. a real lock) ==="
psql "$DB" -c "SELECT at, device_id, reason, remote_ip FROM rejected_frames WHERE device_id IS NOT NULL ORDER BY at DESC LIMIT 10;"
echo "=== positions in the last hour ==="
psql "$DB" -tAc "SELECT count(*) || ' rows' FROM positions WHERE received_at > now() - interval '1 hour';"
