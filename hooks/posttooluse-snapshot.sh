#!/usr/bin/env bash
# claude-eyes :: PostToolUse hook
#
# Fires after Claude Code runs a tool. Asks the local claude-eyes daemon to
# capture a snapshot of the cmux embedded browser preview. Designed to be
# fast and non-blocking from Claude's POV: never fails the tool call.
#
# Exit code: always 0. The hook must never break the agent loop.
#
# Inputs (env, optional):
#   CLAUDE_EYES_DAEMON_URL  base URL of the daemon (default http://127.0.0.1:14242)
#   CLAUDE_EYES_TIMEOUT     curl --max-time seconds (default 2)
#   CLAUDE_EYES_LOG         path to append log lines (default unset = no log)
#   CLAUDE_EYES_KEY_FILE    path to the daemon auth key (default ~/.claude-eyes/key)
#
# Reads the Claude Code hook payload from stdin (JSON) but does not require
# any particular field; the daemon decides what to capture from its own state.

set -u

DAEMON_URL="${CLAUDE_EYES_DAEMON_URL:-http://127.0.0.1:14242}"
TIMEOUT="${CLAUDE_EYES_TIMEOUT:-2}"
LOG_FILE="${CLAUDE_EYES_LOG:-}"
KEY_FILE="${CLAUDE_EYES_KEY_FILE:-$HOME/.claude-eyes/key}"

log() {
    if [ -n "$LOG_FILE" ]; then
        printf '%s posttooluse-snapshot: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true
    fi
}

# Drain stdin so the caller does not block on a pipe. We do not use the body,
# but Claude Code may send a JSON payload.
payload=""
if [ ! -t 0 ]; then
    payload="$(cat 2>/dev/null || true)"
fi
log "received payload bytes=${#payload}"

# Fire the snapshot request. Background it so we never block the agent.
# If curl is missing we just exit clean.
if ! command -v curl >/dev/null 2>&1; then
    log "curl not found, skipping"
    exit 0
fi

# Read auth key (SECURITY FIX: daemon now requires X-Eyes-Key header).
EYES_KEY=""
if [ -r "$KEY_FILE" ]; then
    EYES_KEY="$(tr -d '\n\r ' <"$KEY_FILE" 2>/dev/null || true)"
fi
if [ -z "$EYES_KEY" ]; then
    log "auth key missing at $KEY_FILE — daemon may reject. Start daemon once to provision."
fi

(
    curl \
        --silent \
        --show-error \
        --max-time "$TIMEOUT" \
        --request POST \
        --header 'content-type: application/json' \
        --header "x-eyes-key: ${EYES_KEY}" \
        --data '{"source":"posttooluse"}' \
        "${DAEMON_URL%/}/snapshot" \
        >/dev/null 2>&1 || true
) &

# Detach so the hook returns immediately.
disown 2>/dev/null || true

log "snapshot dispatched to ${DAEMON_URL%/}/snapshot"
exit 0
