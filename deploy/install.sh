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
#   --skip-firewall   deploy the application but leave ufw alone
#   --skip-tls        deploy without requesting a certificate (DNS not ready yet)
#
# Safe to re-run: every stage checks whether its work is already done.
# Secrets are read silently and never printed.

set -euo pipefail

# Prompts must come from the terminal even if the script itself was piped in.
exec 3</dev/tty || exec 3</dev/stdin

SKIP_FIREWALL=0
SKIP_TLS=0
for arg in "$@"; do
  case "$arg" in
    --skip-firewall) SKIP_FIREWALL=1 ;;
    --skip-tls)      SKIP_TLS=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

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
    ss -Hltn 2>/dev/null              | awk '{ sub(/.*:/, "", $4); print "L", $4 }'
    ss -Htn state established 2>/dev/null | awk '{ sub(/.*:/, "", $3); print "E", $3 }'
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
ask DUMP_FILE  "Path to database dump from the old server (blank for empty DB)" ""

if [ -n "$DUMP_FILE" ] && [ ! -r "$DUMP_FILE" ]; then
  die "cannot read dump file: $DUMP_FILE"
fi

# With no dump, the schema comes from the migrations and the database starts
# empty — so the locks have to be registered here. The gateway rejects any
# device that is not on this list, which is the only barrier against forged
# telemetry in a protocol that has no authentication of its own.
DEVICE_IDS=(); DEVICE_NAMES=(); DEVICE_PLATES=(); DEVICE_PASSWORDS=()
if [ -z "$DUMP_FILE" ]; then
  echo
  info "Register your locks. The 10-digit device ID is printed on the label"
  info "underneath each unit. Leave the ID blank when you have finished."
  while :; do
    echo
    ask DEV_ID "Device ID (blank to finish)" ""
    [ -z "$DEV_ID" ] && break
    if ! printf '%s' "$DEV_ID" | grep -qE '^[0-9]{10}$'; then
      warn "must be exactly 10 digits"; continue
    fi
    ask DEV_NAME  "  Vehicle name"            "Truck $(( ${#DEVICE_IDS[@]} + 1 ))"
    ask DEV_PLATE "  Plate number (optional)" ""
    ask DEV_PASS  "  Unlock password"         "123456"
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
info "Maps         ${GMAPS_KEY:+Google}${GMAPS_KEY:-OpenStreetMap}"
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

apt-get install -y -qq postgresql postgresql-contrib nginx certbot python3-certbot-nginx git at curl
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
API_PORT=$API_PORT
API_HOST=127.0.0.1
AUTH_PASSWORD=$AUTH_PASSWORD
COOKIE_SECRET=$COOKIE_SECRET
LOG_LEVEL=info
TILE_CACHE_DIR=$APP_DIR/.cache/tiles
GOOGLE_MAPS_API_KEY=$GMAPS_KEY
EOF
umask 022
chown zee:zee "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
ok ".env written, owner zee, mode 600"

runuser -u zee -- node --env-file-if-exists=.env scripts/migrate.ts >/dev/null
ok "database migrations applied"

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
systemctl enable --now zee-gateway zee-api >/dev/null 2>&1
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
systemctl reload nginx
ok "nginx proxying $DOMAIN to the application"

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
