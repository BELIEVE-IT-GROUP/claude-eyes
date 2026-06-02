#!/usr/bin/env bash
# claude-eyes :: uninstall hooks from ~/.claude/settings.json
#
# Removes any hook entries tagged with the claude-eyes marker (or whose
# command path points at the scripts in this repo). Always backs up the
# existing settings before writing. Safe to run multiple times.
#
# Flags:
#   --settings PATH    target settings file (default ~/.claude/settings.json)
#   --dry-run          print resulting JSON, do not write
#   --help             print usage
#
# Exit codes:
#   0  success (including "nothing to remove")
#   1  internal error
#   2  bad arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_POSTTOOLUSE="$SCRIPT_DIR/posttooluse-snapshot.sh"
HOOK_USERPROMPTSUBMIT="$SCRIPT_DIR/userpromptsubmit-inject.sh"

DEFAULT_SETTINGS="$HOME/.claude/settings.json"
SETTINGS_PATH="$DEFAULT_SETTINGS"
DRY_RUN="0"

usage() {
    cat <<'EOF'
claude-eyes uninstall: remove hooks from Claude Code settings.

Usage:
  uninstall.sh [--settings PATH] [--dry-run]
  uninstall.sh --help

Options:
  --settings PATH   target settings.json (default: ~/.claude/settings.json)
  --dry-run         print resulting JSON to stdout, do not modify any file
  --help            this message
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --settings)
            shift
            if [ "$#" -eq 0 ]; then
                echo "error: --settings requires a path" >&2
                exit 2
            fi
            SETTINGS_PATH="$1"
            shift
            ;;
        --settings=*)
            SETTINGS_PATH="${1#--settings=}"
            shift
            ;;
        --dry-run)
            DRY_RUN="1"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [ ! -f "$SETTINGS_PATH" ]; then
    echo "no settings file at: $SETTINGS_PATH (nothing to uninstall)"
    exit 0
fi

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required for safe JSON edit (install Node.js >=18)" >&2
    exit 1
fi

EXISTING_JSON="$(cat "$SETTINGS_PATH")"
MARKER="claude-eyes:v1"

MERGED_JSON="$(
    EXISTING_JSON="$EXISTING_JSON" \
    HOOK_POST="$HOOK_POSTTOOLUSE" \
    HOOK_PROMPT="$HOOK_USERPROMPTSUBMIT" \
    MARKER="$MARKER" \
    node --input-type=module -e '
        const existingRaw = process.env.EXISTING_JSON ?? "{}";
        const hookPost = process.env.HOOK_POST;
        const hookPrompt = process.env.HOOK_PROMPT;
        const marker = process.env.MARKER;
        const ourCommands = new Set([hookPost, hookPrompt]);

        let settings;
        try {
            settings = existingRaw.trim() === "" ? {} : JSON.parse(existingRaw);
        } catch (err) {
            console.error("error: existing settings is not valid JSON:", err.message);
            process.exit(1);
        }
        if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
            console.error("error: existing settings must be a JSON object");
            process.exit(1);
        }

        if (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) {
            for (const event of Object.keys(settings.hooks)) {
                const arr = settings.hooks[event];
                if (!Array.isArray(arr)) continue;
                const kept = arr.filter((entry) => {
                    if (!entry || typeof entry !== "object") return true;
                    if (entry._marker === marker) return false;
                    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
                    const isOurs = hooks.some((h) => h && typeof h.command === "string" && ourCommands.has(h.command));
                    return !isOurs;
                });
                if (kept.length === 0) {
                    delete settings.hooks[event];
                } else {
                    settings.hooks[event] = kept;
                }
            }
            if (Object.keys(settings.hooks).length === 0) {
                delete settings.hooks;
            }
        }

        process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
    '
)"

if [ "$DRY_RUN" = "1" ]; then
    printf '%s' "$MERGED_JSON"
    exit 0
fi

# Backup before writing.
ts="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${SETTINGS_PATH}.bak.${ts}"
cp -p "$SETTINGS_PATH" "$backup"
echo "backed up existing settings to: $backup"

tmp_file="${SETTINGS_PATH}.tmp.$$"
printf '%s' "$MERGED_JSON" >"$tmp_file"
mv "$tmp_file" "$SETTINGS_PATH"
echo "uninstalled claude-eyes hooks from: $SETTINGS_PATH"
exit 0
