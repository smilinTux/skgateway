#!/usr/bin/env bash
#
# install.sh - install the SKGateway systemd user unit on a cold machine.
#
# Idempotent and safe to re-run. It:
#   1. renders scripts/skgateway.service into ~/.config/systemd/user/
#      (auto-detecting this checkout's location if it is not the fleet-standard
#      path, so ExecStart/WorkingDirectory always point at the real repo),
#   2. creates a 0600 ~/.config/skgateway/secrets.env PLACEHOLDER skeleton if one
#      does not already exist (never overwrites a real secrets file),
#   3. enables lingering so the user unit runs without an active login session,
#   4. runs `systemctl --user daemon-reload`,
#   5. enables + (re)starts the service.
#
# No real secrets are written by this script. Fill secrets.env from skvault.
#
set -euo pipefail

# --- locate this checkout (scripts/.. == repo root) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

STANDARD_DIR="${HOME}/clawd/skcapstone-repos/skgateway"

UNIT_SRC="${SCRIPT_DIR}/skgateway.service"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_DST="${UNIT_DIR}/skgateway.service"

SECRETS_DIR="${HOME}/.config/skgateway"
SECRETS_FILE="${SECRETS_DIR}/secrets.env"
STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"
STATE_DIR="${STATE_HOME}/skgateway"

log() { printf '[install] %s\n' "$*"; }

# Create only the private release-neutral destination. Migration and
# activation remain separate gated operations.
case "${STATE_HOME}" in
  /*) ;;
  *) echo "[install] ERROR: XDG_STATE_HOME must be absolute" >&2; exit 1 ;;
esac
state_component="/"
IFS='/' read -r -a state_parts <<< "${STATE_DIR#/}"
for state_part in "${state_parts[@]}"; do
  [[ -n "${state_part}" ]] || continue
  state_component="${state_component%/}/${state_part}"
  if [[ -L "${state_component}" ]]; then
    echo "[install] ERROR: state path contains a symlink: ${state_component}" >&2
    exit 1
  fi
done
if [[ -e "${STATE_DIR}" ]]; then
  state_owner="$(stat -c '%u' "${STATE_DIR}")"
  state_mode="$(stat -c '%a' "${STATE_DIR}")"
  if [[ "${state_owner}" != "$(id -u)" || "${state_mode}" != "700" ]]; then
    echo "[install] ERROR: existing state directory must be owned by this user with mode 700" >&2
    exit 1
  fi
fi
install -d -m 0700 "${STATE_DIR}" "${STATE_DIR}/semantic-cache"

# --- 1. render + install the unit ---
mkdir -p "${UNIT_DIR}"

if [[ ! -f "${UNIT_SRC}" ]]; then
  echo "[install] ERROR: unit template not found at ${UNIT_SRC}" >&2
  exit 1
fi

# The committed unit uses the fleet-standard %h/clawd/skcapstone-repos/skgateway.
# If this checkout lives elsewhere, rewrite that literal path to the real one so
# systemd (which does not know %h beyond home) points at the correct repo.
# We rewrite the path segment AFTER %h, matching the standard suffix.
if [[ "${REPO_DIR}" == "${STANDARD_DIR}" ]]; then
  log "repo at fleet-standard path; installing unit verbatim"
  install -m 0644 "${UNIT_SRC}" "${UNIT_DST}"
else
  # Express the real repo dir relative to %h when possible, else use an absolute
  # path (systemd accepts absolute paths in ExecStart/WorkingDirectory too).
  if [[ "${REPO_DIR}" == "${HOME}/"* ]]; then
    REL="${REPO_DIR#"${HOME}/"}"
    REPLACEMENT="%h/${REL}"
  else
    REPLACEMENT="${REPO_DIR}"
  fi
  log "repo at non-standard path ${REPO_DIR}; rewriting unit paths to ${REPLACEMENT}"
  sed "s#%h/clawd/skcapstone-repos/skgateway#${REPLACEMENT}#g" \
    "${UNIT_SRC}" > "${UNIT_DST}"
  chmod 0644 "${UNIT_DST}"
fi
log "installed unit -> ${UNIT_DST}"

# --- 2. secrets.env skeleton (placeholders only, never overwrite real file) ---
mkdir -p "${SECRETS_DIR}"
chmod 0700 "${SECRETS_DIR}"
if [[ -f "${SECRETS_FILE}" ]]; then
  log "secrets file already exists, leaving untouched: ${SECRETS_FILE}"
else
  umask 077
  cat > "${SECRETS_FILE}" <<'EOF'
# SKGateway secrets - 0600, sourced by systemd EnvironmentFile at start.
# PLACEHOLDERS ONLY. Fill from skvault; do NOT commit this file.
# After editing, restart to pick up changes: systemctl --user restart skgateway
#
# Upstream provider API keys (only set the ones this node actually routes to):
NVIDIA_API_KEY=REPLACE_ME
OPENROUTER_API_KEY=REPLACE_ME
# Add any other backend credentials here as KEY=VALUE, one per line.
EOF
  chmod 0600 "${SECRETS_FILE}"
  log "wrote placeholder secrets skeleton (0600): ${SECRETS_FILE}"
  log "  -> edit it with real values from skvault before relying on upstreams"
fi

# --- 3. enable lingering (user unit runs without an active login) ---
if command -v loginctl >/dev/null 2>&1; then
  if loginctl show-user "${USER}" 2>/dev/null | grep -q '^Linger=yes'; then
    log "lingering already enabled for ${USER}"
  else
    log "enabling lingering for ${USER}"
    loginctl enable-linger "${USER}" || \
      log "WARN: could not enable lingering (may need: sudo loginctl enable-linger ${USER})"
  fi
else
  log "WARN: loginctl not found; skipping linger setup"
fi

# --- 4. daemon-reload ---
log "systemctl --user daemon-reload"
systemctl --user daemon-reload

# --- 5. enable + (re)start ---
log "enabling skgateway.service"
systemctl --user enable skgateway.service

if systemctl --user is-active --quiet skgateway.service; then
  log "service already running; restarting to apply changes"
  systemctl --user restart skgateway.service
else
  log "starting skgateway.service"
  systemctl --user start skgateway.service
fi

log "done. status:"
systemctl --user --no-pager --lines=0 status skgateway.service || true
