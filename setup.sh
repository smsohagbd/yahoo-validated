#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="yahoo_validated"
INSTALL_DIR="/opt/yahoo_validated"
ENV_FILE="/etc/yahoo_validated.env"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
APP_USER="yahoo_validated"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash setup.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[setup] $*"; }

detect_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    echo apt
  elif command -v dnf >/dev/null 2>&1; then
    echo dnf
  elif command -v yum >/dev/null 2>&1; then
    echo yum
  else
    echo none
  fi
}

PKG="$(detect_pkg)"

install_base() {
  log "installing base packages"
  case "${PKG}" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg git openssl
      ;;
    dnf)
      dnf install -y ca-certificates curl git openssl
      ;;
    yum)
      yum install -y ca-certificates curl git openssl
      ;;
    *)
      log "unknown package manager; assuming curl/openssl already exist"
      ;;
  esac
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${major}" -ge 18 ]]; then
      log "node $(node -v) already installed"
      return
    fi
    log "node $(node -v) is too old; installing Node 20"
  fi

  case "${PKG}" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
      ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      dnf install -y nodejs
      ;;
    yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      yum install -y nodejs
      ;;
    *)
      echo "Install Node.js 18+ first, then re-run setup.sh"
      exit 1
      ;;
  esac
  log "node $(node -v) npm $(npm -v)"
}

create_user() {
  if id -u "${APP_USER}" >/dev/null 2>&1; then
    log "user ${APP_USER} exists"
    return
  fi
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null \
      || useradd --system --home "${INSTALL_DIR}" --shell /sbin/nologin "${APP_USER}"
  else
    echo "Cannot create system user ${APP_USER}"
    exit 1
  fi
}

sync_app() {
  log "installing app into ${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude node_modules \
      --exclude .git \
      --exclude .ms-playwright \
      --exclude .env \
      --exclude data \
      --exclude logs \
      "${SCRIPT_DIR}/" "${INSTALL_DIR}/"
  else
    find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .ms-playwright ! -name .env ! -name data ! -name logs \
      -exec rm -rf {} +
    cp -a "${SCRIPT_DIR}/." "${INSTALL_DIR}/"
    rm -rf "${INSTALL_DIR}/.git" "${INSTALL_DIR}/node_modules"
  fi
}

install_app() {
  log "npm install + playwright chromium"
  cd "${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}/.ms-playwright" "${INSTALL_DIR}/data" "${INSTALL_DIR}/logs"
  export PLAYWRIGHT_BROWSERS_PATH="${INSTALL_DIR}/.ms-playwright"
  npm install --omit=dev
  npx playwright install --with-deps chromium
}

env_get() {
  local key="$1" val=""
  if [[ -f "${ENV_FILE}" ]]; then
    val="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
    val="${val#\"}"
    val="${val%\"}"
    val="${val//\\\"/\"}"
    printf '%s' "${val}"
  fi
}

detect_server_ip() {
  local ip="" url
  for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    ip="$(curl -4 -fsS --max-time 5 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "${ip}"
      return
    fi
  done
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "${ip}"
    return
  fi
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  echo "${ip:-127.0.0.1}"
}

prompt_dashboard() {
  local current_user current_pass
  current_user="$(env_get DASHBOARD_USER)"
  current_pass="$(env_get DASHBOARD_PASS)"
  current_user="${current_user:-admin}"
  current_pass="${current_pass:-admin}"

  DASH_USER="${current_user}"
  DASH_PASS="${current_pass}"

  if [[ -t 0 ]]; then
    echo
    echo "Dashboard login (press Enter to keep the default)"
    local input_user input_pass
    read -r -p "Dashboard username [${current_user}]: " input_user || true
    if [[ -n "${input_user}" ]]; then
      DASH_USER="${input_user}"
    fi
    read -r -s -p "Dashboard password [${current_pass}]: " input_pass || true
    echo
    if [[ -n "${input_pass}" ]]; then
      DASH_PASS="${input_pass}"
    fi
  else
    log "non-interactive install: dashboard user=${DASH_USER}"
  fi
}

write_env() {
  local token secret server_ip
  token="$(env_get API_TOKEN)"
  secret="$(env_get SESSION_SECRET)"
  if [[ -z "${token}" ]]; then
    token="$(openssl rand -hex 32)"
    log "generated new API token"
  else
    log "keeping existing API token"
  fi
  if [[ -z "${secret}" ]]; then
    secret="$(openssl rand -hex 32)"
  fi

  server_ip="$(detect_server_ip)"
  log "detected server IP ${server_ip}"

  prompt_dashboard

  escape_env() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
  }

  cat > "${ENV_FILE}" <<EOF
PORT=6100
HOST=0.0.0.0
SERVER_IP="$(escape_env "${server_ip}")"
API_TOKEN="$(escape_env "${token}")"
MIN_WORKERS=2
MAX_WORKERS=5
HEADLESS=true
REQUEST_TIMEOUT_MS=25000
LOG_LEVEL=info
PLAYWRIGHT_BROWSERS_PATH=${INSTALL_DIR}/.ms-playwright
DATA_DIR=${INSTALL_DIR}/data
LOGS_DIR=${INSTALL_DIR}/logs
NODE_ENV=production
DASHBOARD_USER="$(escape_env "${DASH_USER}")"
DASHBOARD_PASS="$(escape_env "${DASH_PASS}")"
SESSION_SECRET="$(escape_env "${secret}")"
RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_MS=60000
PROXY_MIN_INTERVAL_MS=2000
PROXY_MAX_PER_MIN=20
PROXY_ROTATION=round_robin
EOF
  chmod 640 "${ENV_FILE}"
  chown "root:${APP_USER}" "${ENV_FILE}"
}

write_service() {
  local node_bin
  node_bin="$(command -v node)"
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Yahoo Validated email checker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${node_bin} ${INSTALL_DIR}/src/server.js
Restart=always
RestartSec=4
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
}

fix_perms() {
  chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}"
  chmod 750 "${INSTALL_DIR}"
}

open_firewall() {
  local port
  port="$(env_get PORT)"
  port="${port:-6100}"
  log "opening TCP port ${port} on host firewall"

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
    ufw allow "${port}/tcp" || true
    return
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -qi running; then
    firewall-cmd --permanent --add-port="${port}/tcp" || true
    firewall-cmd --reload || true
    return
  fi

  if command -v iptables >/dev/null 2>&1; then
    if ! iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT 2>/dev/null; then
      iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT || true
    fi
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save || true
    elif [[ -d /etc/iptables ]]; then
      iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    fi
  fi
}

start_service() {
  log "enabling systemd service ${SERVICE_NAME}"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"

  local listen_port ready=0 i
  listen_port="$(env_get PORT)"
  listen_port="${listen_port:-6100}"

  for i in $(seq 1 45); do
    if curl -sf "http://127.0.0.1:${listen_port}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  systemctl --no-pager --full status "${SERVICE_NAME}" || true
  if [[ "${ready}" -ne 1 ]] || ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo
    echo "Service failed to become ready. Logs:"
    journalctl -u "${SERVICE_NAME}" -n 80 --no-pager || true
    exit 1
  fi
}

print_token() {
  local token user pass port ip
  token="$(env_get API_TOKEN)"
  user="$(env_get DASHBOARD_USER)"
  pass="$(env_get DASHBOARD_PASS)"
  port="$(env_get PORT)"
  port="${port:-6100}"
  ip="$(env_get SERVER_IP)"
  ip="${ip:-127.0.0.1}"
  echo
  echo "============================================================"
  echo " yahoo_validated is installed and active"
  echo " Detected IP: ${ip}"
  echo " API:         http://${ip}:${port}/verify"
  echo " Dashboard:   http://${ip}:${port}/dashboard"
  echo " Local test:  http://127.0.0.1:${port}/health"
  echo
  echo " API TOKEN (required on every /verify request):"
  echo " ${token}"
  echo
  echo " DASHBOARD LOGIN:"
  echo " user: ${user}"
  echo " pass: ${pass}"
  echo
  echo " Example:"
  echo " curl -s -X POST http://${ip}:${port}/verify \\"
  echo "   -H 'Authorization: Bearer ${token}' \\"
  echo "   -H 'Content-Type: application/json' \\"
  echo "   -d '{\"email\":\"someone@yahoo.com\"}'"
  echo
  echo " Chrome blocks port 6000; this service uses ${port}."
  echo " If the dashboard fails from another PC, open ${port}/tcp in"
  echo " the VPS/cloud security group as well as the host firewall."
  echo "============================================================"
}

install_base
install_node
create_user
sync_app
install_app
write_env
write_service
fix_perms
open_firewall
start_service
print_token
