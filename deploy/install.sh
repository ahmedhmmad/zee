#!/usr/bin/env bash
#
# Zee lock platform — one-shot deployment to a fresh Ubuntu server.
#
# Usage, on the NEW server only:
#
#   curl -fsSL https://raw.githubusercontent.com/ahmedhmmad/zee/main/deploy/install.sh -o install.sh
#   sudo bash install.sh
#
# Options:
#   --skip-firewall      deploy the application but leave ufw alone
#   --skip-tls           deploy without requesting a certificate (DNS not ready yet)
#   --evaluation-days N  length of the agreed evaluation period, counted from
#                        this install. 0 means no limit. Defaults to 60.
#   --evaluation-minutes N
#                        same, in minutes. For demonstrating the expiry itself
#                        inside one sitting; use --evaluation-days for a real
#                        pilot.
#
# Safe to re-run: every stage checks whether its work is already done. A re-run
# keeps the evaluation date already in .env unless --evaluation-days is given
# explicitly, so re-running to fix something cannot silently renew the period.
# Secrets are read silently and never printed.

set -euo pipefail

# Prompts must come from the terminal even if the script itself was piped in.
exec 3</dev/tty || exec 3</dev/stdin

SKIP_FIREWALL=0
SKIP_TLS=0
# Evaluation period, in days from this install. Set on the command line rather
# than asked for: it is a term of the pilot agreement fixed by the supplier,
# not a choice made by whoever happens to run the installer.
EVAL_DAYS=60
EVAL_MINUTES=""
EVAL_DAYS_EXPLICIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-firewall) SKIP_FIREWALL=1 ;;
    --skip-tls)      SKIP_TLS=1 ;;
    --evaluation-days)
      shift
      [ $# -gt 0 ] || { echo "--evaluation-days needs a number" >&2; exit 2; }
      EVAL_DAYS=$1; EVAL_MINUTES=""; EVAL_DAYS_EXPLICIT=1 ;;
    --evaluation-days=*)
      EVAL_DAYS=${1#*=}; EVAL_MINUTES=""; EVAL_DAYS_EXPLICIT=1 ;;
    --evaluation-minutes)
      shift
      [ $# -gt 0 ] || { echo "--evaluation-minutes needs a number" >&2; exit 2; }
      EVAL_MINUTES=$1; EVAL_DAYS_EXPLICIT=1 ;;
    --evaluation-minutes=*)
      EVAL_MINUTES=${1#*=}; EVAL_DAYS_EXPLICIT=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if ! printf '%s' "$EVAL_DAYS" | grep -qE '^[0-9]+$'; then
  echo "--evaluation-days must be a whole number of days (0 for no limit)" >&2
  exit 2
fi
if [ -n "$EVAL_MINUTES" ] && ! printf '%s' "$EVAL_MINUTES" | grep -qE '^[0-9]+$'; then
  echo "--evaluation-minutes must be a whole number of minutes (0 for no limit)" >&2
  exit 2
fi

APP_DIR=/home/zee/app
REPO=https://github.com/ahmedhmmad/zee.git
GATEWAY_PORT=10001
API_PORT=3333

# --- helpers ----------------------------------------------------------------

bold()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

ask() {  # ask <varname> <prompt> [default]
  local __var=$1 __prompt=$2 __default=${3:-} __reply
  if [ -n "$__default" ]; then
    printf '  %s [%s]: ' "$__prompt" "$__default"
  else
    printf '  %s: ' "$__prompt"
  fi
  read -r __reply <&3
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

ask_secret() {  # ask_secret <varname> <prompt> — silent, asks twice
  local __var=$1 __prompt=$2 __a __b
  while :; do
    printf '  %s: ' "$__prompt";        read -rs __a <&3; echo
    printf '  %s (again): ' "$__prompt"; read -rs __b <&3; echo
    [ -z "$__a" ] && { warn "cannot be empty"; continue; }
    [ "$__a" = "$__b" ] || { warn "they do not match, try again"; continue; }
    printf -v "$__var" '%s' "$__a"; return
  done
}

trap 'die "failed on line $LINENO. Nothing further was changed; fix the cause and re-run."' ERR

# --- preflight --------------------------------------------------------------

bold "Preflight"

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash install.sh"
grep -qi ubuntu /etc/os-release || die "this script targets Ubuntu"
ok "Ubuntu $(. /etc/os-release && echo "$VERSION_ID"), $(uname -m)"

# The old server must keep running as the rollback, so refuse to run there.
if [ -d /home/zee/htdocs ]; then
  die "this looks like the OLD server (found /home/zee/htdocs). Run on the NEW one."
fi

# Whatever the operator is connected with must survive the firewall, and the
# script has no business guessing whether that is SSH, AnyDesk, RDP or a
# console. A port we are listening on that also has an established peer IS the
# way somebody is currently reaching this machine — no name required.
session_ports() {
  # Listening ports first, then the local port of every established
  # connection; anything appearing in both is a service somebody is connected
  # to. Done in one awk pass so nothing depends on sort order.
  {
    # Loopback-only listeners cannot be a remote access path, whatever is
    # connected to them: PostgreSQL and the API both live there.
    ss -Hltn 2>/dev/null |
      awk '$4 !~ /^(127\.|\[::1\])/ { sub(/.*:/, "", $4); print "L", $4 }'
    # And only peers from off-box count. A loopback peer is the application
    # talking to its own database, not a person logged in.
    ss -Htn state established 2>/dev/null |
      awk '$4 !~ /^(127\.|\[::1\])/ { sub(/.*:/, "", $3); print "E", $3 }'
  } | awk '$1 == "L" { listening[$2] = 1 }
           $1 == "E" && listening[$2] && !seen[$2]++ { print $2 }'
}

SESSION_PORTS=$(session_ports)
if [ -n "$SESSION_PORTS" ]; then
  ok "you are connected on port(s) $(echo $SESSION_PORTS) — these stay open"
else
  warn "could not detect how you are connected; the firewall will still allow"
  warn "any port with a live session when it is applied"
fi

if ufw status 2>/dev/null | grep -q '^Status: active'; then
  warn "a firewall is ALREADY active:"
  ufw status | sed 's/^/      /'
  warn "the firewall stage will add rules to it rather than replace it"
fi

# --- gather inputs ----------------------------------------------------------

bold "Configuration"
info "Passwords are hidden as you type. The database password and session"
info "secret are generated automatically and never displayed."
echo

DETECTED_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
ask DOMAIN "Console hostname, or leave the IP for testing" "${DETECTED_IP:-locks.ahmedhammad.page}"

# Let's Encrypt will not issue for a bare IP, so an address means plain HTTP.
IS_IP=0
if printf '%s' "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  IS_IP=1
  SKIP_TLS=1
fi
EMAIL=""
[ $IS_IP -eq 1 ] || ask EMAIL "Email for certificate notices" "eng.ahammad7@gmail.com"
ask_secret AUTH_PASSWORD "Console login password (you will use this to sign in)"
ask GMAPS_KEY  "Google Maps API key (blank to use OpenStreetMap)" ""
ask ARCGIS_KEY "ArcGIS API key from the client's Esri licence (blank to skip)" ""
ask DUMP_FILE  "Path to database dump from the old server (blank for empty DB)" ""

# Evaluation period. A disclosed pilot term, not a hidden switch: after this
# date the platform stops serving and shows a notice, until the date in .env is
# updated and the services restarted. Nothing is deleted. See README
# "Evaluation period".
#
# An existing date survives a re-run untouched. The installer is meant to be
# safe to re-run when something needs fixing, and recomputing the date there
# would quietly restart the clock every time - so the period could never
# actually end. Passing --evaluation-days explicitly is the way to change it.
EVALUATION_EXPIRES_AT=""
EXISTING_EVAL=""
[ -r "$APP_DIR/.env" ] && EXISTING_EVAL=$(
  sed -n 's/^EVALUATION_EXPIRES_AT=//p' "$APP_DIR/.env" | head -1 | tr -d '\r'
)

# The anchor: when the evaluation period began here, recorded in the database
# at first install and never rewritten.
#
# The period is measured from the anchor, not from now. Otherwise re-running
# the install command with the same flag just issues another period, and the
# limit never arrives - which is the whole point of having one. Re-running
# --evaluation-minutes 30 an hour later now yields a date already in the past.
#
# Missing on a fresh box (no postgres, no database, or an older schema), and
# then today is the anchor. Every failure mode here lands on "start the clock
# now", which is correct for a first install and harmless on a re-run.
EVAL_ANCHOR=""
if command -v psql >/dev/null 2>&1; then
  EVAL_ANCHOR=$(sudo -u postgres psql -tAd zee \
    -c "SELECT value FROM platform_meta WHERE key = 'evaluation_started_at'" \
    2>/dev/null | tr -d '[:space:]' || true)
fi
EVAL_ANCHOR_FOUND=1
if [ -z "$EVAL_ANCHOR" ]; then
  EVAL_ANCHOR=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EVAL_ANCHOR_FOUND=0
fi

if [ -n "$EXISTING_EVAL" ] && [ $EVAL_DAYS_EXPLICIT -eq 0 ]; then
  EVALUATION_EXPIRES_AT=$EXISTING_EVAL
  info "Evaluation period already set to $EVALUATION_EXPIRES_AT — keeping it."
  info "Pass --evaluation-days N to change it."
elif [ -n "$EVAL_MINUTES" ]; then
  # Minutes need a full instant, not a date: a bare YYYY-MM-DD is read as the
  # end of that day, which would give the rest of the day rather than the
  # minutes asked for.
  if [ "$EVAL_MINUTES" -gt 0 ]; then
    EVALUATION_EXPIRES_AT=$(date -u -d "$EVAL_ANCHOR +$EVAL_MINUTES minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
    [ -z "$EVALUATION_EXPIRES_AT" ] && die "could not compute the expiry time — is GNU date available?"
  fi
elif [ "$EVAL_DAYS" -gt 0 ]; then
  EVALUATION_EXPIRES_AT=$(date -u -d "$EVAL_ANCHOR +$EVAL_DAYS days" +%Y-%m-%d 2>/dev/null || echo "")
  [ -z "$EVALUATION_EXPIRES_AT" ] && die "could not compute the expiry date — is GNU date available?"
fi

# Say plainly that the clock did not restart, so a re-run producing a date in
# the past reads as the mechanism working rather than as a broken install.
if [ $EVAL_ANCHOR_FOUND -eq 1 ] && [ $EVAL_DAYS_EXPLICIT -eq 1 ]; then
  info "Evaluation period is measured from the first install here"
  info "($EVAL_ANCHOR) — re-running does not restart it."
fi

if [ -n "$DUMP_FILE" ] && [ ! -r "$DUMP_FILE" ]; then
  die "cannot read dump file: $DUMP_FILE"
fi

# With no dump, the schema comes from the migrations and the database starts
# empty — so the locks have to be registered here. The gateway rejects any
# device that is not on this list, which is the only barrier against forged
# telemetry in a protocol that has no authentication of its own.
# The locks already commissioned in Tripoli. A device ID is printed on the
# unit's label and is not a secret, so seeding them here removes the step most
# likely to be mistyped — and a mistyped ID fails silently, as a lock that is
# simply never heard from.
PRESET_DEVICE_IDS=(8055430364 8055430383)
PRESET_DEVICE_NAMES=("Truck 1" "Truck 2")

DEVICE_IDS=(); DEVICE_NAMES=(); DEVICE_PLATES=(); DEVICE_PASSWORDS=()
if [ -z "$DUMP_FILE" ]; then
  echo
  info "These locks are registered automatically:"
  for i in "${!PRESET_DEVICE_IDS[@]}"; do
    info "  ${PRESET_DEVICE_IDS[$i]}  ${PRESET_DEVICE_NAMES[$i]}"
  done

  # Asked once for the whole preset rather than per device. It has to be asked:
  # a wrong password still lets positions arrive normally and only fails at the
  # moment someone tries to unlock, which is the worst time to find out.
  echo
  ask PRESET_PASS "Unlock password for these locks" "123456"
  for i in "${!PRESET_DEVICE_IDS[@]}"; do
    DEVICE_IDS+=("${PRESET_DEVICE_IDS[$i]}")
    DEVICE_NAMES+=("${PRESET_DEVICE_NAMES[$i]}")
    DEVICE_PLATES+=("")
    DEVICE_PASSWORDS+=("$PRESET_PASS")
  done

  echo
  info "Any other locks? The 10-digit device ID is printed on the label"
  info "underneath each unit. Leave the ID blank when you have finished."
  while :; do
    echo
    ask DEV_ID "Device ID (blank to finish)" ""
    [ -z "$DEV_ID" ] && break
    if ! printf '%s' "$DEV_ID" | grep -qE '^[0-9]{10}$'; then
      warn "must be exactly 10 digits"; continue
    fi
    if printf '%s\n' "${DEVICE_IDS[@]}" | grep -qx "$DEV_ID"; then
      warn "$DEV_ID is already on the list"; continue
    fi
    ask DEV_NAME  "  Vehicle name"            "Truck $(( ${#DEVICE_IDS[@]} + 1 ))"
    ask DEV_PLATE "  Plate number (optional)" ""
    ask DEV_PASS  "  Unlock password"         "$PRESET_PASS"
    DEVICE_IDS+=("$DEV_ID"); DEVICE_NAMES+=("$DEV_NAME")
    DEVICE_PLATES+=("$DEV_PLATE"); DEVICE_PASSWORDS+=("$DEV_PASS")
    ok "will register $DEV_ID"
  done
fi

# Two hazards in one place: a single quote would end the SQL literal, and a
# terminal that mangles non-ASCII input sends byte sequences Postgres rejects
# outright. Drop the invalid ones rather than failing the whole run over a
# vehicle name that can be corrected in the console.
sql_quote() {
  local v
  v=$(printf '%s' "$1" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || printf '%s' "$1")
  printf '%s' "${v//\'/\'\'}"
}

# Generated, not asked: nothing needs to know these but the application.
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
COOKIE_SECRET=$(openssl rand -hex 32)

bold "About to install"
info "Console      $([ $IS_IP -eq 1 ] && echo "http" || echo "https")://$DOMAIN"
info "Gateway      port $GATEWAY_PORT, public"
info "Application  $APP_DIR, running as user 'zee'"
info "Database     local PostgreSQL + PostGIS, loopback only"
info "Restore      ${DUMP_FILE:-none — starting with an empty database}"
[ ${#DEVICE_IDS[@]} -gt 0 ] && info "Devices      ${#DEVICE_IDS[@]} to register: ${DEVICE_IDS[*]}"
# Spelled out rather than done with ${x:+a}${x:-b}: that pair reads as an
# if/else but is not one - ${x:-b} substitutes x's own VALUE whenever x is set,
# so both halves fire and the value is appended to the label. Here that printed
# the Google Maps key to the terminal in a script whose whole premise is that
# secrets are never displayed.
if [ -n "$ARCGIS_KEY" ]; then
  info "Maps         Esri/ArcGIS (licensed)$([ -n "$GMAPS_KEY" ] && echo ", Google also available")"
elif [ -n "$GMAPS_KEY" ]; then
  info "Maps         Google"
else
  info "Maps         OpenStreetMap"
fi
if [ -n "$EVALUATION_EXPIRES_AT" ]; then
  info "Evaluation   ends $EVALUATION_EXPIRES_AT"
else
  info "Evaluation   no limit"
fi
info "TLS          $([ $IS_IP -eq 1 ] && echo 'none — plain HTTP, certificates need a hostname' || { [ $SKIP_TLS -eq 1 ] && echo 'skipped' || echo 'certbot, needs DNS pointing here'; })"
info "Firewall     $([ $SKIP_FIREWALL -eq 1 ] && echo 'skipped' || echo 'asked for confirmation at the end')"
echo
ask CONFIRM "Continue? (yes/no)" "no"
[ "$CONFIRM" = yes ] || die "aborted, nothing changed"

# --- 1. packages ------------------------------------------------------------

bold "1/6  Installing packages"

export DEBIAN_FRONTEND=noninteractive
export PGCLIENTENCODING=UTF8
apt-get update -qq

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
ok "Node $(node -v)"

apt-get install -y -qq postgresql postgresql-contrib nginx certbot python3-certbot-nginx git at curl ufw
PG_VER=$(psql --version | grep -oP '\d+' | head -1)
apt-get install -y -qq postgis "postgresql-${PG_VER}-postgis-3"
ok "PostgreSQL $PG_VER with PostGIS, nginx, certbot"

# --- 2. database ------------------------------------------------------------

bold "2/6  Database"

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='zee_app'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER USER zee_app WITH PASSWORD '$DB_PASSWORD';"
  ok "role zee_app existed — password rotated"
else
  sudo -u postgres psql -qc "CREATE USER zee_app WITH PASSWORD '$DB_PASSWORD';"
  ok "role zee_app created"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='zee'" | grep -q 1; then
  sudo -u postgres createdb -O zee_app zee
  ok "database zee created"
fi
sudo -u postgres psql -qd zee -c "CREATE EXTENSION IF NOT EXISTS postgis;"

if [ -n "$DUMP_FILE" ]; then
  # pg_restore reports ownership noise on a fresh cluster; that is expected.
  sudo -u postgres pg_restore -d zee --no-owner --role=zee_app "$DUMP_FILE" 2>/dev/null || true
  DEV_COUNT=$(sudo -u postgres psql -tAd zee -c "SELECT count(*) FROM devices" 2>/dev/null || echo 0)
  ok "restored — $DEV_COUNT device(s) in the database"
  warn "delete the dump when you have verified this: shred -u $DUMP_FILE"
fi

# Refuse to continue if Postgres is reachable from off-box.
if ss -lntH 'sport = :5432' | grep -qv '127.0.0.1\|::1'; then
  die "PostgreSQL is listening beyond loopback — fix listen_addresses before continuing"
fi
ok "PostgreSQL bound to loopback only"

# --- 2b. tuning for 3,000 devices -------------------------------------------
#
# The Postgres defaults are sized for a machine that might be doing anything.
# This one is doing one thing: absorbing roughly 36 position inserts a second in
# the steady state, and bursts of thousands when a fleet reconnects after a
# restart and replays its buffered positions.
#
# Written to conf.d rather than edited into postgresql.conf, so a package
# upgrade cannot silently revert it and so removing the file removes the change.
PG_MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
cat > "/etc/postgresql/$PG_VER/main/conf.d/60-zee.conf" <<PGCONF
# Managed by deploy/install.sh — do not edit by hand; re-running the installer
# rewrites this file. Sized for the Zee lock platform on a $PG_MEM_MB MB box.

# A quarter of RAM is the standard starting point for a dedicated database.
shared_buffers = $(( PG_MEM_MB / 4 ))MB
# What the planner assumes is cached, counting the OS page cache. Too low and
# it chooses sequential scans over the indexes this workload depends on.
effective_cache_size = $(( PG_MEM_MB / 2 ))MB
work_mem = 16MB
maintenance_work_mem = 256MB

# Checkpoint less often and spread the writes. The default max_wal_size makes a
# steady insert stream checkpoint every few minutes, and each one is a latency
# spike straight into the position path.
max_wal_size = 4GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = on

# SSD, not a spinning disk: random reads cost close to sequential ones. Left at
# the default of 4.0 the planner avoids index scans it should be choosing.
random_page_cost = 1.1

# Anything over a second is worth seeing. Without this the first evidence of a
# slow query is an operator saying the console feels slow.
log_min_duration_statement = 1000
shared_preload_libraries = 'pg_stat_statements'

# positions and commands churn far faster than the default autovacuum
# thresholds assume; per-table settings are applied below.
PGCONF

# Table-level autovacuum, which cannot live in a config file. positions is
# append-only but still needs its visibility map maintained for index-only
# scans; commands is updated on every state change and bloats without it.
sudo -u postgres psql -qd zee -c "
  ALTER TABLE IF EXISTS positions SET (autovacuum_vacuum_scale_factor = 0.02,
                                       autovacuum_analyze_scale_factor = 0.01);
  ALTER TABLE IF EXISTS commands  SET (autovacuum_vacuum_scale_factor = 0.05,
                                       autovacuum_analyze_scale_factor = 0.02);
" 2>/dev/null || true

# Enforced database-side, so a query that hangs cannot hold a pool connection
# indefinitely no matter what the application forgot. Maintenance raises it for
# itself with SET LOCAL.
sudo -u postgres psql -qc "
  ALTER ROLE zee_app SET statement_timeout = '15s';
  ALTER ROLE zee_app SET idle_in_transaction_session_timeout = '30s';
" || true

# shared_buffers and shared_preload_libraries need a restart, not a reload.
# Seconds, and the services reconnect on their own.
systemctl restart postgresql
ok "PostgreSQL tuned for the fleet (${PG_MEM_MB}MB box) and restarted"

# The kernel's accept queue. When 3,000 devices reconnect together the default
# somaxconn of 4096 is fine, but older kernels default to 128 — and anything the
# listener asks for above somaxconn is silently truncated to it.
cat > /etc/sysctl.d/60-zee.conf <<'SYSCTL'
# Managed by deploy/install.sh. The gateway asks for a listen backlog of 1024;
# somaxconn is the ceiling that request is clamped to.
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
SYSCTL
sysctl -q --system >/dev/null 2>&1 || true
ok "kernel accept queue raised for fleet-wide reconnects"

# --- 3. application ---------------------------------------------------------

bold "3/6  Application"

id zee >/dev/null 2>&1 || adduser --system --group --home /home/zee --shell /usr/sbin/nologin zee
ok "service user 'zee' (unprivileged, no login shell)"

if [ -d "$APP_DIR/.git" ]; then
  runuser -u zee -- git -C "$APP_DIR" pull --ff-only
  ok "repository updated"
else
  runuser -u zee -- git clone -q "$REPO" "$APP_DIR"
  ok "repository cloned"
fi

cd "$APP_DIR"
runuser -u zee -- npm install --omit=dev --silent
ok "dependencies installed"

# The decoder is tested against the vendor manual's own frames. If Node
# behaves differently here, fail now rather than mis-decode a truck's position.
if runuser -u zee -- npm test >/tmp/zee-test.log 2>&1; then
  ok "protocol test suite passes"
else
  die "test suite failed — see /tmp/zee-test.log"
fi

# Note the deliberate absence of AUTH_DISABLED: with it set, the console and
# the unlock endpoint are open to anyone who finds the URL.
umask 077
cat > "$APP_DIR/.env" <<EOF
GATEWAY_PORT=$GATEWAY_PORT
GATEWAY_HOST=0.0.0.0
DATABASE_URL=postgres://zee_app:$DB_PASSWORD@127.0.0.1:5432/zee
REQUIRE_KNOWN_DEVICE=true
# Valve sub-lock unlocking stays off: it has no confirmation path yet, so the
# platform cannot say whether a valve opened. Master unlocking is unaffected.
SUBLOCK_UNLOCK_ENABLED=false
API_PORT=$API_PORT
API_HOST=127.0.0.1
# Seeded into a named account called "operator" on first start, then unused.
# Create an account per person with: npm run user:add -- <name> <password> --unlock
AUTH_PASSWORD=$AUTH_PASSWORD
COOKIE_SECRET=$COOKIE_SECRET
LOG_LEVEL=info
TILE_CACHE_DIR=$APP_DIR/.cache/tiles
GOOGLE_MAPS_API_KEY=$GMAPS_KEY
ARCGIS_API_KEY=$ARCGIS_KEY
ARCGIS_VERSION=4.31

# Evaluation period (disclosed pilot term). After this date the platform stops
# serving until the date is updated and the services restarted. Blank = no
# limit. Nothing is ever deleted. See README "Evaluation period".
EVALUATION_EXPIRES_AT=$EVALUATION_EXPIRES_AT
EOF
umask 022
chown zee:zee "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
ok ".env written, owner zee, mode 600"

runuser -u zee -- node --env-file-if-exists=.env scripts/migrate.ts >/dev/null
ok "database migrations applied"

# Record when the evaluation period began, now that platform_meta exists.
# DO NOTHING, never DO UPDATE: the anchor is written once at first install and
# is what stops a re-run from restarting the clock. Overwriting it here would
# undo the whole point.
if [ -n "$EVALUATION_EXPIRES_AT" ]; then
  sudo -u postgres psql -qd zee -c "
    INSERT INTO platform_meta (key, value)
    VALUES ('evaluation_started_at', '$(sql_quote "$EVAL_ANCHOR")')
    ON CONFLICT (key) DO NOTHING;"
  [ $EVAL_ANCHOR_FOUND -eq 0 ] && ok "evaluation period anchored to $EVAL_ANCHOR"
fi

# Registered after the migrations, because the devices table has to exist.
# ON CONFLICT keeps the script safe to re-run.
for i in "${!DEVICE_IDS[@]}"; do
  sudo -u postgres psql -qd zee -c "
    INSERT INTO devices (device_id, name, plate_number, model, static_password)
    VALUES ('$(sql_quote "${DEVICE_IDS[$i]}")',
            '$(sql_quote "${DEVICE_NAMES[$i]}")',
            NULLIF('$(sql_quote "${DEVICE_PLATES[$i]}")', ''),
            'JT701D',
            '$(sql_quote "${DEVICE_PASSWORDS[$i]}")')
    ON CONFLICT (device_id) DO NOTHING;"
  ok "registered ${DEVICE_IDS[$i]} — ${DEVICE_NAMES[$i]}"
done

DEVICE_TOTAL=$(sudo -u postgres psql -tAd zee -c "SELECT count(*) FROM devices WHERE is_active" 2>/dev/null || echo 0)
ok "$DEVICE_TOTAL device(s) on the allowlist"
[ "$DEVICE_TOTAL" -eq 0 ] && warn "no devices registered — the gateway will refuse every connection"

# --- 4. services ------------------------------------------------------------

bold "4/6  Services"

for unit in zee-gateway zee-api; do
  sed "s#/home/zee/htdocs/locks.ahmedhammad.page#$APP_DIR#g" \
    "$APP_DIR/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
# Only stdout is discarded, never stderr. Silencing both here meant an enable
# failure passed unnoticed: the restart below starts the services for this
# session, is-active then passes, and the install reports success - but nothing
# comes back after a power cycle. On a desktop machine that is every night.
systemctl enable zee-gateway zee-api >/dev/null \
  || die "could not enable the services at boot — they would not survive a reboot"
# restart, not "enable --now": a re-run rotates the database password and
# rewrites .env, but --now leaves an already-running service holding the
# credentials it loaded at first start, which then fails to authenticate.
systemctl restart zee-gateway zee-api
sleep 2

systemctl is-active --quiet zee-gateway || die "zee-gateway did not start: journalctl -u zee-gateway -n 30"
systemctl is-active --quiet zee-api     || die "zee-api did not start: journalctl -u zee-api -n 30"
ok "zee-gateway and zee-api running, enabled at boot"

ss -lntH "sport = :$API_PORT" | grep -q '127.0.0.1' \
  || die "API is not bound to loopback — the console would be reachable over plain HTTP"
ok "API on 127.0.0.1:$API_PORT, gateway on 0.0.0.0:$GATEWAY_PORT"

# --- 5. nginx and TLS -------------------------------------------------------

bold "5/6  Web server"

cat > /etc/nginx/sites-available/zee <<EOF
server {
    listen 80;
    server_name $([ $IS_IP -eq 1 ] && echo "_" || echo "$DOMAIN");

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "same-origin" always;

    location / {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        # The live map runs over a WebSocket; these two headers carry the upgrade.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 900;
    }
}
EOF
ln -sf /etc/nginx/sites-available/zee /etc/nginx/sites-enabled/zee
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx configuration is invalid"
# reload only refreshes an already-running nginx and quietly does nothing
# useful if it is stopped, so start it explicitly and enable it at boot.
systemctl enable nginx >/dev/null || warn "could not enable nginx at boot"
systemctl restart nginx
systemctl is-active --quiet nginx || die "nginx is not running: journalctl -u nginx -n 30"

# Prove the console is actually answering rather than trusting that three
# services came up. This is the check that was missing: an install can pass
# every other step and still leave nothing listening on 80, which looks to the
# operator like the whole platform was never installed.
sleep 1
ss -lntH 'sport = :80' | grep -q . || die "nothing is listening on port 80 — the console would be unreachable"
ok "nginx proxying $DOMAIN to the application, listening on port 80"

if [ $IS_IP -eq 1 ]; then
  warn "reached by IP, so the console is plain HTTP — fine for testing, but the"
  warn "login password crosses the network unencrypted. Point a hostname here and"
  warn "re-run to get a certificate."
elif [ $SKIP_TLS -eq 1 ]; then
  warn "TLS skipped — run later: certbot --nginx -d $DOMAIN --redirect -m $EMAIL --agree-tos"
else
  RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
  PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
  if [ -n "$RESOLVED" ] && [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    warn "$DOMAIN resolves to $RESOLVED but this server is $PUBLIC_IP"
    warn "skipping certificate — point DNS here, then run:"
    warn "  certbot --nginx -d $DOMAIN --redirect -m $EMAIL --agree-tos"
  elif certbot --nginx -d "$DOMAIN" --redirect --agree-tos -m "$EMAIL" -n >/dev/null 2>&1; then
    ok "certificate issued, HTTPS redirect on, renewal timer installed"
  else
    warn "certbot failed — the site works over HTTP. Re-run manually:"
    warn "  certbot --nginx -d $DOMAIN --redirect -m $EMAIL --agree-tos"
  fi
fi

# --- 6. firewall ------------------------------------------------------------

bold "6/6  Firewall"

if [ $SKIP_FIREWALL -eq 1 ]; then
  warn "skipped by request — the server is currently unfirewalled"
else
  info "Rules to be applied:"
  info "    allow  443/tcp   console"
  info "    allow   80/tcp   certificate renewal"
  info "    allow $GATEWAY_PORT/tcp   device gateway"
  for p in $(session_ports); do info "    allow $(printf '%5s' "$p")/tcp   your current session"; done
  info "    deny   all other incoming"
  info "    outgoing left UNRESTRICTED — never touched"
  echo
  info "If applying this cuts your connection, do nothing: the firewall"
  info "switches itself off again after 10 minutes and you get back in."
  echo
  ask FWCONFIRM "Apply firewall now? (yes/no)" "no"

  if [ "$FWCONFIRM" = yes ]; then
    command -v ufw >/dev/null || die "ufw is not installed — re-run to install it"
    echo "ufw --force disable" | at now + 10 minutes 2>/dev/null
    AT_JOB=$(atq | sort -n | tail -1 | awk '{print $1}')

    ufw --force default allow outgoing >/dev/null
    ufw --force default deny incoming  >/dev/null
    ufw allow 443/tcp                  >/dev/null
    ufw allow 80/tcp                   >/dev/null
    ufw allow "$GATEWAY_PORT/tcp"      >/dev/null
    # Added before enabling, never after: the rule has to exist first.
    for p in $(session_ports); do ufw allow "$p/tcp" >/dev/null; done
    ufw --force enable                 >/dev/null

    # Oracle Cloud images ship their own iptables policy that rejects
    # everything except SSH, and it sits BEFORE ufw's chains in INPUT - so
    # ufw's rules are never evaluated and every port except 22 silently times
    # out from outside while looking perfectly correct in "ufw status".
    # Removing a REJECT only ever opens things, and the INPUT policy stays
    # DROP, so ufw remains the one deciding.
    if iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null; then
      iptables -D INPUT -j REJECT --reject-with icmp-host-prohibited
      ok "removed the provider's catch-all REJECT that was shadowing ufw"
      if command -v netfilter-persistent >/dev/null; then
        netfilter-persistent save >/dev/null 2>&1 || true
        ok "saved, so it stays removed after a reboot"
      else
        warn "could not persist that change: it is removed now, but a reboot"
        warn "would restore it and close the ports again. If that happens, run"
        warn "  sudo iptables -D INPUT -j REJECT --reject-with icmp-host-prohibited"
      fi
    fi

    ok "firewall active"

    # Answering proves the connection survived, so the rollback can be
    # cancelled here rather than left as a chore to remember.
    echo
    ask FWSTILL "Still connected? Type yes to keep the firewall" ""
    if [ "$FWSTILL" = yes ]; then
      [ -n "$AT_JOB" ] && atrm "$AT_JOB" 2>/dev/null || true
      ok "firewall made permanent"
    else
      warn "leaving the rollback armed — the firewall will disable itself shortly"
    fi
  else
    warn "firewall not applied — the server is currently unfirewalled"
  fi
fi

# --- summary ----------------------------------------------------------------

bold "Done"
info "Console    $([ $IS_IP -eq 1 ] && echo "http" || echo "https")://$DOMAIN"
info "Sign in with the password you entered."
if [ -n "$EVALUATION_EXPIRES_AT" ]; then
  echo
  # Also shown in the server's own timezone: a short evaluation is watched in
  # real time, and translating UTC in your head while waiting is a good way to
  # think the expiry has failed when it simply has not arrived yet.
  EVAL_LOCAL=$(date -d "$EVALUATION_EXPIRES_AT" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo "")
  info "Evaluation period ends $EVALUATION_EXPIRES_AT${EVAL_LOCAL:+  (local: $EVAL_LOCAL)}"
  info "After that the platform stops serving until EVALUATION_EXPIRES_AT in"
  info "$APP_DIR/.env is changed (a later date, or blank for no limit) and:"
  info "    sudo systemctl restart zee-gateway zee-api"
  info "Nothing is deleted — the locks and all data stay intact."
fi
echo
info "Check it:"
info "    systemctl is-active zee-gateway zee-api nginx postgresql"
info "    curl -s -o /dev/null -w '%{http_code}\\n' https://$DOMAIN/api/devices   # expect 401"
info "    journalctl -u zee-gateway -n 20 --no-pager"
echo
info "Still to do:"
info "  · Point the gw hostname at this server so devices move over"
[ -n "$DUMP_FILE" ] && info "  · shred -u $DUMP_FILE"
info "  · Restrict port $GATEWAY_PORT to the carrier ranges once you have them"
info "  · Rotate the device unlock password and lock the unlock channels"
echo
