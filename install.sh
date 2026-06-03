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
# 3b. Symlink `claude-eyes` into PATH
# ---------------------------------------------------------------------------
BIN_TARGET=""
for d in "/usr/local/bin" "$HOME/.local/bin" "$HOME/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    BIN_TARGET="$d"; break
  fi
done
if [ -z "$BIN_TARGET" ]; then
  mkdir -p "$HOME/.local/bin" && BIN_TARGET="$HOME/.local/bin"
fi
ln -sf "$SCRIPT_DIR/bin/claude-eyes" "$BIN_TARGET/claude-eyes"
green "✓ claude-eyes command at $BIN_TARGET/claude-eyes"
if ! echo ":$PATH:" | grep -q ":$BIN_TARGET:"; then
  yellow "  add to your shell rc:    export PATH=\"$BIN_TARGET:\$PATH\""
fi

# ---------------------------------------------------------------------------
# 3c. Register /claude-eyes as a Claude Code skill
# ---------------------------------------------------------------------------
SKILLS_DIR="$HOME/.claude/skills/claude-eyes"
mkdir -p "$SKILLS_DIR"
cp -f "$SCRIPT_DIR/skill/SKILL.md" "$SKILLS_DIR/SKILL.md"
green "✓ /claude-eyes skill at $SKILLS_DIR"

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
cyan "🎉  Done. Three commands to remember:"
cat <<EOF

  # In your frontend project (dev server already running on :5173)
  cd ~/Developer/<your-project>
  CLAUDE_EYES_PLAYWRIGHT=true CLAUDE_EYES_DEV_URL=http://localhost:5173 claude-eyes start &

  claude-eyes status    # health + latest capture metadata
  claude-eyes stop      # graceful shutdown

EOF

yellow "Optional native bridge mode (when the cmux fork is available):"
echo "  FORK=true CMUX_SOCKET_PATH=/tmp/cmux-debug-<tag>.sock CMUX_SURFACE_ID=surface:N claude-eyes start"
echo
yellow "Per-project capture key:"
echo "  $KEY_FILE"
echo
