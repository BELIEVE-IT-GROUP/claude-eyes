#!/usr/bin/env bash
# claude-eyes :: install hooks into ~/.claude/settings.json
#
# Merges (does not clobber) PostToolUse + UserPromptSubmit hook entries into
# the user's Claude Code settings, pointing at the absolute paths of the
# scripts in this repo. Idempotent. Always creates a timestamped backup of
# the existing settings before writing.
#
# Flags:
#   --settings PATH    target settings file (default ~/.claude/settings.json)
#   --dry-run          print resulting JSON, do not write
#   --uninstall        forward to uninstall.sh (convenience)
#   --help             print usage
#
# Exit codes:
#   0  success
#   1  internal error (missing node, malformed JSON, etc.)
#   2  bad arguments
#
# Requires: node (>=18). We use node for safe JSON merging.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_POSTTOOLUSE="$SCRIPT_DIR/posttooluse-snapshot.sh"
HOOK_USERPROMPTSUBMIT="$SCRIPT_DIR/userpromptsubmit-inject.sh"

DEFAULT_SETTINGS="$HOME/.claude/settings.json"
SETTINGS_PATH="$DEFAULT_SETTINGS"
DRY_RUN="0"

usage() {
    cat <<'EOF'
claude-eyes install: wire hooks into Claude Code settings.

Usage:
  install.sh [--settings PATH] [--dry-run]
  install.sh --uninstall [...]
  install.sh --help

Options:
  --settings PATH   target settings.json (default: ~/.claude/settings.json)
  --dry-run         print merged JSON to stdout, do not modify any file
  --uninstall       forward to uninstall.sh
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
        --uninstall)
            shift
            exec "$SCRIPT_DIR/uninstall.sh" "$@"
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

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required for safe JSON merge (install Node.js >=18)" >&2
    exit 1
fi

if [ ! -f "$HOOK_POSTTOOLUSE" ]; then
    echo "error: missing hook script: $HOOK_POSTTOOLUSE" >&2
    exit 1
fi
if [ ! -f "$HOOK_USERPROMPTSUBMIT" ]; then
    echo "error: missing hook script: $HOOK_USERPROMPTSUBMIT" >&2
    exit 1
fi

# Ensure hooks are executable.
chmod +x "$HOOK_POSTTOOLUSE" "$HOOK_USERPROMPTSUBMIT" 2>/dev/null || true

# Ensure parent dir for settings exists (only if we are going to write).
SETTINGS_DIR="$(dirname "$SETTINGS_PATH")"
if [ "$DRY_RUN" != "1" ]; then
    mkdir -p "$SETTINGS_DIR"
fi

# Read existing settings if present, else default to "{}".
EXISTING_JSON="{}"
if [ -f "$SETTINGS_PATH" ]; then
    EXISTING_JSON="$(cat "$SETTINGS_PATH")"
fi

# Marker used to identify our hook entries on uninstall.
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

        if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
            settings.hooks = {};
        }

        function upsert(eventName, command) {
            const arr = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
            // Drop any prior claude-eyes entry for this event (idempotent).
            const filtered = arr.filter((entry) => {
                if (!entry || typeof entry !== "object") return true;
                if (entry._marker === marker) return false;
                const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
                const isOurs = hooks.some((h) => h && typeof h.command === "string" && h.command === command);
                return !isOurs;
            });
            filtered.push({
                _marker: marker,
                matcher: "*",
                hooks: [
                    {
                        type: "command",
                        command,
                    },
                ],
            });
            settings.hooks[eventName] = filtered;
        }

        upsert("PostToolUse", hookPost);
        upsert("UserPromptSubmit", hookPrompt);

        process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
    '
)"

if [ "$DRY_RUN" = "1" ]; then
    printf '%s' "$MERGED_JSON"
    exit 0
fi

# Backup existing file (if any) before overwriting.
if [ -f "$SETTINGS_PATH" ]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    backup="${SETTINGS_PATH}.bak.${ts}"
    cp -p "$SETTINGS_PATH" "$backup"
    echo "backed up existing settings to: $backup"
fi

# Atomic write via tmp + mv.
tmp_file="${SETTINGS_PATH}.tmp.$$"
printf '%s' "$MERGED_JSON" >"$tmp_file"
mv "$tmp_file" "$SETTINGS_PATH"
echo "installed claude-eyes hooks into: $SETTINGS_PATH"
echo "  PostToolUse      -> $HOOK_POSTTOOLUSE"
echo "  UserPromptSubmit -> $HOOK_USERPROMPTSUBMIT"
exit 0
