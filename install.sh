#!/usr/bin/env bash
# claude-eyes :: one-shot installer
#
# Runs from a fresh `git clone`. Verifies prerequisites, installs npm deps,
# and wires Claude Code hooks into ~/.claude/settings.json. Idempotent — safe
# to re-run after pulling updates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" 1>&2; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

cyan "👁  claude-eyes installer"
echo

# ---------------------------------------------------------------------------
# 1. Node version check
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is required (>= 20). Install from https://nodejs.org or:"
  red "  brew install node"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Node $NODE_MAJOR detected. claude-eyes requires Node 20+."
  exit 1
fi
green "✓ node $(node -v)"

# ---------------------------------------------------------------------------
# 2. npm install
# ---------------------------------------------------------------------------
if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
  cyan "→ installing npm dependencies..."
  npm install --silent
fi
green "✓ npm dependencies installed"

# ---------------------------------------------------------------------------
# 3. Hooks
# ---------------------------------------------------------------------------
cyan "→ wiring Claude Code hooks into ~/.claude/settings.json"
bash "$SCRIPT_DIR/hooks/install.sh"
green "✓ hooks installed"

# ---------------------------------------------------------------------------
# 4. Per-user state dir + capture key
# ---------------------------------------------------------------------------
EYES_DIR="$HOME/.claude-eyes"
mkdir -p "$EYES_DIR"
KEY_FILE="$EYES_DIR/key"
if [ ! -s "$KEY_FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi
green "✓ capture key at $KEY_FILE"

# ---------------------------------------------------------------------------
# 5. Next steps
# ---------------------------------------------------------------------------
echo
cyan "🎉  Done. Now use it from any frontend project:"
cat <<EOF

  cd ~/Developer/<your-project>
  CLAUDE_EYES_PLAYWRIGHT=true \\
  CLAUDE_EYES_DEV_URL=http://localhost:5173 \\
    npx tsx $SCRIPT_DIR/daemon/cli.ts &

  # then open Claude Code in the same project — every Edit captures a PNG
  # and the next prompt is injected with it as <image> context.

EOF

yellow "Optional native bridge mode (when cmux fork is available):"
echo "  FORK=true CMUX_SOCKET_PATH=/tmp/cmux-debug-<tag>.sock CMUX_SURFACE_ID=surface:N ..."
echo
yellow "Health check:"
echo "  curl -s -H \"x-eyes-key: \$(cat $KEY_FILE)\" http://127.0.0.1:14242/healthz"
echo
