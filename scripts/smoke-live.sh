#!/usr/bin/env bash
# scripts/smoke-live.sh — one-shot validation of the cmux fork (CLAUDE_EYES_FORK mode)
#
# Uses a TAGGED debug build (bundle id com.cmuxterm.app.debug.<tag>, socket
# /tmp/cmux-debug-<tag>.sock) so it never conflicts with the user's real cmux.
# Untagged DEV launches are blocked by SocketControlSettings.shouldBlockUntaggedDebugLaunch().
#
# Prerequisite: build the tagged DEV first, from the cmux fork:
#   cd ~/Developer/claude-eyes/.recon/cmux-src
#   ./scripts/reload.sh --tag claude-eyes-smoke
#
# What this script does:
#   1. Verifies the tagged cmux DEV.app exists at the expected derivedData path.
#   2. Backups the user's real cmux state as paranoia (we don't touch it).
#   3. Launches the tagged DEV (own bundle id, own socket — no clash with real cmux).
#   4. Waits for the tagged DEV socket /tmp/cmux-debug-<tag>.sock to appear.
#   5. Starts a Vite pilot dev server on :5174 (off-default to avoid clashes).
#   6. Runs the claude-eyes daemon in CLAUDE_EYES_FORK=true mode against the tagged socket.
#   7. Forces 3 snapshots via the daemon HTTP API and asserts PNG bytes > 5000.
#   8. Prints a verdict: PASS or FAIL.
#
# Tear-down: kills daemon + dev server + tagged cmux DEV. Real cmux is untouched.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TAG="${1:-claude-eyes-smoke}"

# -----------------------------------------------------------------------------
# 0. Pre-flight
# -----------------------------------------------------------------------------
APP="$HOME/Library/Developer/Xcode/DerivedData/cmux-$TAG/Build/Products/Debug/cmux DEV $TAG.app"
if [ ! -d "$APP" ]; then
  echo "❌ tagged cmux DEV.app not found at:"
  echo "   $APP"
  echo ""
  echo "   Build it first:"
  echo "     cd ~/Developer/claude-eyes/.recon/cmux-src"
  echo "     ./scripts/reload.sh --tag $TAG"
  exit 1
fi
echo "✅ tagged cmux DEV.app present ($TAG)"

# -----------------------------------------------------------------------------
# 1. Backup real cmux state (paranoid, even though we use an isolated tag)
# -----------------------------------------------------------------------------
BACKUP="$HOME/Developer/cmux-backups/snapshot-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$(dirname "$BACKUP")"
cp -R "$HOME/Library/Application Support/cmux" "$BACKUP-app-support" 2>/dev/null || true
cp -R "$HOME/.cmuxterm" "$BACKUP-cmuxterm" 2>/dev/null || true
echo "✅ backup at $BACKUP-*"
echo "   to restore: cp -R \"$BACKUP-app-support/cmux\" \"\$HOME/Library/Application Support/cmux\""

# -----------------------------------------------------------------------------
# 2. Launch tagged DEV
# -----------------------------------------------------------------------------
DEV_SOCKET="/tmp/cmux-debug-$TAG.sock"
rm -f "$DEV_SOCKET" 2>/dev/null || true
echo "🚀 launching tagged cmux DEV.app..."
open -n "$APP"
echo "   waiting up to 30s for socket at $DEV_SOCKET..."
for i in $(seq 1 30); do
  if [ -S "$DEV_SOCKET" ]; then
    break
  fi
  sleep 1
done

if [ ! -S "$DEV_SOCKET" ]; then
  echo "❌ tagged DEV socket not found at $DEV_SOCKET after 30s."
  echo "   Check ~/Library/Logs/cmux/startup-com.cmuxterm.app.debug.$TAG.log"
  exit 1
fi
echo "✅ tagged DEV socket at $DEV_SOCKET"

# -----------------------------------------------------------------------------
# 3. Start pilot dev server on :5174
# -----------------------------------------------------------------------------
PILOT="$ROOT/docs/examples/vite-pilot"
if [ ! -d "$PILOT/node_modules" ]; then
  echo "   installing pilot deps..."
  (cd "$PILOT" && npm install --silent)
fi
echo "🚀 launching pilot Vite on :5174..."
(cd "$PILOT" && nohup npm run dev -- --port 5174 > /tmp/smoke-vite.log 2>&1) &
VITE_PID=$!
echo "   VITE_PID=$VITE_PID, waiting for :5174..."
for i in {1..15}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:5174 | grep -q 200; then
    echo "✅ pilot up at http://localhost:5174"
    break
  fi
  sleep 1
done

# -----------------------------------------------------------------------------
# 3b. Open a workspace + browser tab in cmux DEV pointing at the pilot
# -----------------------------------------------------------------------------
CMUX_CLI_HELPER="$HOME/Developer/claude-eyes/.recon/cmux-src/scripts/cmux-debug-cli.sh"
echo "🚀 creating workspace + browser tab in cmux DEV..."
WS_OUT=$(CMUX_TAG="$TAG" "$CMUX_CLI_HELPER" new-workspace --name claude-eyes-smoke --cwd "$PILOT" --focus true 2>&1) || true
echo "$WS_OUT" | sed 's/^/   workspace: /'
SURF_OUT=$(CMUX_TAG="$TAG" "$CMUX_CLI_HELPER" new-surface --type browser --url "http://localhost:5174" --focus true 2>&1) || true
echo "$SURF_OUT" | sed 's/^/   surface: /'
# Capture surface:N ref so the daemon can target it directly without relying on
# system.identify (which returns null when cmux DEV runs in background).
SURFACE_REF=$(echo "$SURF_OUT" | grep -oE 'surface:[0-9]+' | head -1)
if [ -z "$SURFACE_REF" ]; then
  echo "❌ failed to capture surface ref from new-surface output"
  exit 1
fi
echo "✅ targeting CMUX_SURFACE_ID=$SURFACE_REF"
sleep 3

# -----------------------------------------------------------------------------
# 4. Launch daemon in FORK mode
# -----------------------------------------------------------------------------
echo "🚀 launching daemon in FORK=true mode (cwd=$PILOT)..."
(cd "$PILOT" && \
  FORK=true \
  CLAUDE_EYES_DEV_URL=http://localhost:5174 \
  CLAUDE_EYES_GC_KEEP=100 \
  CLAUDE_EYES_PORT=14243 \
  CMUX_SOCKET_PATH="$DEV_SOCKET" \
  CMUX_SURFACE_ID="$SURFACE_REF" \
  nohup npx tsx "$ROOT/daemon/cli.ts" > /tmp/smoke-daemon.log 2>&1) &
DAEMON_PID=$!
sleep 5

# -----------------------------------------------------------------------------
# 5. Trigger 3 snapshots + assert PNG bytes
# -----------------------------------------------------------------------------
KEY=$(cat "$HOME/.claude-eyes/key")
PASS=0
FAIL=0
for i in 1 2 3; do
  curl -s -X POST -H "x-eyes-key: $KEY" http://127.0.0.1:14243/snapshot > /dev/null
  sleep 2
  LAST="$PILOT/.claude/eyes/last.png"
  if [ -f "$LAST" ]; then
    BYTES=$(stat -f%z -L "$LAST" 2>/dev/null || stat -c%s -L "$LAST" 2>/dev/null)
    if [ "$BYTES" -gt 5000 ]; then
      echo "✅ snapshot #$i — $BYTES bytes"
      PASS=$((PASS + 1))
    else
      echo "❌ snapshot #$i — only $BYTES bytes (likely blank)"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "❌ snapshot #$i — no file at $LAST"
    FAIL=$((FAIL + 1))
  fi
done

# -----------------------------------------------------------------------------
# 6. Tear down
# -----------------------------------------------------------------------------
echo ""
echo "🧹 tear-down..."
kill "$DAEMON_PID" 2>/dev/null || true
kill "$VITE_PID" 2>/dev/null || true
osascript -e "tell application \"cmux DEV $TAG\" to quit" 2>/dev/null || true
pkill -f "cmux DEV $TAG.app" 2>/dev/null || true
sleep 2

# -----------------------------------------------------------------------------
# 7. Verdict
# -----------------------------------------------------------------------------
echo ""
echo "==============================="
if [ "$PASS" -ge 2 ] && [ "$FAIL" -le 1 ]; then
  echo "🎉 SMOKE TEST: PASS ($PASS/3 captures > 5KB)"
  echo "   The cmux bridge works. Daemon log: /tmp/smoke-daemon.log"
  echo "   Ready to record demo GIF and push v0.1 public."
  exit 0
else
  echo "❌ SMOKE TEST: FAIL ($PASS/3 captures OK)"
  echo "   Inspect: /tmp/smoke-daemon.log, /tmp/smoke-vite.log"
  echo "   The fork code is present but runtime did not deliver a real PNG."
  exit 1
fi
