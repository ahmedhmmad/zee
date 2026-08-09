#!/usr/bin/env bash
#
# Collect a diagnostic snapshot: service state, recent logs, and the database
# rows that explain what the system thinks is happening.
#
# Bounded on purpose - enough to diagnose, small enough to paste.
#
#   sudo -u zee -i bash -lc 'cd ~/htdocs/locks.ahmedhammad.page && bash scripts/diagnostics.sh'
#
# Writes to /tmp/zee-diagnostics.txt and prints it.

set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/zee-diagnostics.txt}"

# DATABASE_URL lives in .env, which only the site user can read.
DB="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"

section() { printf '\n===== %s =====\n' "$1"; }

{
  printf 'Zee diagnostics — %s\n' "$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
  printf 'commit: %s\n' "$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  section "services"
  systemctl is-active zee-gateway zee-api 2>&1
  systemctl show zee-gateway -p ActiveEnterTimestamp -p NRestarts 2>&1
  systemctl show zee-api -p ActiveEnterTimestamp -p NRestarts 2>&1

  section "gateway log (last 120 lines, scanner noise removed)"
  journalctl -u zee-gateway -n 120 --no-pager 2>&1 | grep -vE 'unidentified frames'

  section "api errors (last 60)"
  journalctl -u zee-api -n 400 --no-pager 2>&1 | grep -iE '"level":(40|50|60)|error' | tail -60

  if [ -n "$DB" ]; then
    section "devices and live state"
    psql "$DB" -c "SELECT d.device_id, d.name, d.plate_number, d.firmware_version IS NOT NULL AS has_fw,
                          (d.static_password IN ('888888','123456')) AS default_pw,
                          s.is_connected, s.last_seen_at, s.battery_percent, s.motor_locked,
                          s.rope_inserted, s.positioned, s.satellites, s.gsm_signal
                     FROM devices d LEFT JOIN device_state s ON s.device_id = d.device_id
                    ORDER BY d.name;" 2>&1

    section "recent commands (20)"
    psql "$DB" -c "SELECT id, device_id, command_type, status, requested_by, reason,
                          requested_at, sent_at, confirmed_at, not_before, last_error
                     FROM commands ORDER BY id DESC LIMIT 20;" 2>&1

    section "recent lock events (15)"
    psql "$DB" -c "SELECT id, device_id, reported_at, received_at, event_source_name,
                          unlock_allowed, wrong_password_count, rfid_card, command_id
                     FROM lock_events ORDER BY reported_at DESC LIMIT 15;" 2>&1

    section "arrival unlocks"
    psql "$DB" -c "SELECT id, device_id, name, radius_m, is_armed, expires_at,
                          triggered_at, triggered_distance_m, triggered_command_id
                     FROM arrival_unlocks ORDER BY id DESC LIMIT 10;" 2>&1

    section "locations"
    psql "$DB" -c "SELECT id, name, kind, radius_m,
                          round(ST_Y(location::geometry)::numeric,5) AS lat,
                          round(ST_X(location::geometry)::numeric,5) AS lon, is_active
                     FROM locations ORDER BY id;" 2>&1

    section "refused frames carrying a device id (10)"
    psql "$DB" -c "SELECT device_id, count(*) AS attempts, max(at) AS last_seen, max(remote_ip::text) AS ip
                     FROM rejected_frames WHERE device_id IS NOT NULL
                    GROUP BY device_id ORDER BY max(at) DESC LIMIT 10;" 2>&1

    section "position volume (last 24h)"
    psql "$DB" -c "SELECT device_id, count(*) AS rows, min(reported_at) AS oldest, max(reported_at) AS newest,
                          count(*) FILTER (WHERE positioned) AS with_fix
                     FROM positions WHERE received_at > now() - interval '24 hours'
                    GROUP BY device_id;" 2>&1

    section "migrations"
    psql "$DB" -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;" 2>&1

    section "recent audit (15)"
    psql "$DB" -c "SELECT at, actor, action, device_id, command_id FROM audit_log
                    ORDER BY at DESC LIMIT 15;" 2>&1
  else
    section "database"
    echo "DATABASE_URL not found in $APP_DIR/.env — database sections skipped"
  fi

  section "disk"
  df -h / 2>&1
} > "$OUT" 2>&1

echo "written to $OUT"
echo
cat "$OUT"
