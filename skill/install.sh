#!/usr/bin/env bash
# install.sh — symlink the cmux-eyes skill into ~/.claude/skills/
#
# Creates ~/.claude/skills/cmux-eyes -> /Users/mac/Developer/claude-eyes/skill
# so Claude Code discovers SKILL.md and the cmux-eyes entrypoint.
#
# Also drops a symlink for the executable at ~/.claude/skills/cmux-eyes/cmux-eyes
# (handled automatically because we symlink the whole directory).
#
# Flags:
#   --dry-run   print what would happen, don't touch anything
#   --force     replace an existing target (file, dir, or symlink)
#   --help      this message
#
# Exit codes:
#   0  success
#   1  internal error
#   2  bad arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_NAME="cmux-eyes"
TARGET_DIR="$HOME/.claude/skills/$SKILL_NAME"

DRY_RUN=0
FORCE=0

usage() {
    cat <<EOF
install.sh — symlink the cmux-eyes skill into ~/.claude/skills/

Usage:
  install.sh [--dry-run] [--force]
  install.sh --help

Options:
  --dry-run   show what would happen, change nothing
  --force     replace existing target at $TARGET_DIR
  --help      this message
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --force)   FORCE=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "error: unknown arg: $1" >&2; usage >&2; exit 2 ;;
    esac
done

# Ensure SKILL.md is present in source.
if [ ! -f "$SCRIPT_DIR/SKILL.md" ]; then
    echo "error: missing $SCRIPT_DIR/SKILL.md" >&2
    exit 1
fi

# Make entrypoint executable.
if [ -f "$SCRIPT_DIR/cmux-eyes" ]; then
    chmod +x "$SCRIPT_DIR/cmux-eyes" 2>/dev/null || true
fi

PARENT="$(dirname "$TARGET_DIR")"

if [ "$DRY_RUN" = "1" ]; then
    echo "would: mkdir -p $PARENT"
    if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
        if [ "$FORCE" = "1" ]; then
            echo "would: rm -rf $TARGET_DIR"
        else
            echo "would: SKIP (target exists, use --force to replace): $TARGET_DIR"
            exit 0
        fi
    fi
    echo "would: ln -s $SCRIPT_DIR $TARGET_DIR"
    exit 0
fi

mkdir -p "$PARENT"

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    # If it's already a symlink pointing where we want, nothing to do.
    if [ -L "$TARGET_DIR" ]; then
        current_target="$(readlink "$TARGET_DIR")"
        if [ "$current_target" = "$SCRIPT_DIR" ]; then
            echo "already installed: $TARGET_DIR -> $SCRIPT_DIR"
            exit 0
        fi
    fi
    if [ "$FORCE" != "1" ]; then
        echo "error: $TARGET_DIR already exists; pass --force to replace" >&2
        exit 1
    fi
    rm -rf "$TARGET_DIR"
fi

ln -s "$SCRIPT_DIR" "$TARGET_DIR"
echo "installed: $TARGET_DIR -> $SCRIPT_DIR"
echo
echo "Verify: ls -la $TARGET_DIR"
echo "Then in Claude Code, the skill 'cmux-eyes' is available."
