#!/usr/bin/env bash
# scripts/smoke-live.sh — one-shot validation of the cmux fork (CLAUDE_EYES_FORK mode)
#
# Run this AFTER closing your real cmux normally (⌘Q, NOT force-quit) so the
# state snapshot at ~/Library/Application Support/cmux/session-com.cmuxterm.app.json
# is fresh. Re-open cmux when done to restore your 9+ workspaces.
#
# What this script does:
#   1. Verifies cmux DEV.app exists at the expected derivedData path.
#   2. Backups your real cmux state to ~/Developer/cmux-backups/.
#   3. Launches cmux DEV.app (uses bundle ID com.cmuxterm.app.debug, no conflict).
#   4. Waits for the DEV socket to come up.
#   5. Starts a Vite pilot dev server on :5174 (off-default to avoid clashes).
#   6. Launches a browser tab in cmux DEV pointed at the pilot.
#   7. Runs the claude-eyes daemon in CLAUDE_EYES_FORK=true mode against the DEV socket.
#   8. Forces 3 snapshots via the daemon HTTP API and asserts PNG bytes > 5000.
#   9. Prints a verdict: PASS or FAIL.
#
# Tear-down: kills daemon + dev server + cmux DEV. Your real cmux is unaffected.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# -----------------------------------------------------------------------------
# 0. Pre-flight
# -----------------------------------------------------------------------------
APP="/tmp/cmux-dd/Build/Products/Debug/cmux DEV.app"
if [ ! -d "$APP" ]; then
  echo "❌ cmux DEV.app not found at $APP"
  echo "   Build it first: cd .recon/cmux-src && xcodebuild ..."
  exit 1
fi
echo "✅ cmux DEV.app present"

# -----------------------------------------------------------------------------
# 1. Backup real cmux state (paranoid restore path)
# -----------------------------------------------------------------------------
BACKUP="$HOME/Developer/cmux-backups/snapshot-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$(dirname "$BACKUP")"
cp -R "$HOME/Library/Application Support/cmux" "$BACKUP-app-support" 2>/dev/null || true
cp -R "$HOME/.cmuxterm" "$BACKUP-cmuxterm" 2>/dev/null || true
echo "✅ backup at $BACKUP-*"
echo "   to restore: cp -R \"$BACKUP-app-support/cmux\" \"\$HOME/Library/Application Support/cmux\""

# -----------------------------------------------------------------------------
# 2. Launch DEV
# -----------------------------------------------------------------------------
echo "🚀 launching cmux DEV.app..."
open "$APP"
echo "   waiting 8s for socket to come up..."
sleep 8

DEV_SOCKET="$HOME/Library/Application Support/cmux/cmux-501-debug.sock"
if [ ! -S "$DEV_SOCKET" ]; then
  # try the default socket path used by the debug build
  DEV_SOCKET="$(cat "$HOME/Library/Application Support/cmux/last-socket-path" 2>/dev/null || echo)"
fi
if [ -z "$DEV_SOCKET" ] || [ ! -S "$DEV_SOCKET" ]; then
  echo "❌ DEV socket not found. cmux DEV may not have started. Check ~/Library/Logs/cmux/."
  exit 1
fi
echo "✅ DEV socket at $DEV_SOCKET"

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
# 4. Launch daemon in FORK mode
# -----------------------------------------------------------------------------
echo "🚀 launching daemon in CLAUDE_EYES_FORK=true mode..."
CLAUDE_EYES_FORK=true \
CLAUDE_EYES_DEV_URL=http://localhost:5174 \
CLAUDE_EYES_GC_KEEP=100 \
CLAUDE_EYES_PORT=14243 \
CMUX_SOCKET_PATH="$DEV_SOCKET" \
nohup npx tsx "$ROOT/daemon/cli.ts" > /tmp/smoke-daemon.log 2>&1 &
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
    BYTES=$(stat -f%z "$LAST" 2>/dev/null || stat -c%s "$LAST" 2>/dev/null)
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
osascript -e 'tell application "cmux DEV" to quit' 2>/dev/null || true
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
