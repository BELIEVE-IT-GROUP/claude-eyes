#!/usr/bin/env bash
# claude-eyes :: UserPromptSubmit hook
#
# Fires when the user submits a prompt. If we have a fresh capture from the
# daemon (<30s old), emit a Claude Code hook JSON payload that injects an
# image tag pointing at the latest PNG, so Claude can "see" the preview.
#
# Stdout (when fresh capture exists):
#   {
#     "hookSpecificOutput": {
#       "hookEventName": "UserPromptSubmit",
#       "additionalContext": "<image path=\".claude/eyes/last.png\" />\n..."
#     }
#   }
#
# Stdout (when stale / missing): nothing. Exit 0 so Claude proceeds normally.
# Exit code: always 0. Hook must never block the user.
#
# Inputs (env, optional):
#   CLAUDE_EYES_DIR     directory containing last.json + last.png
#                       (default: $CLAUDE_PROJECT_DIR/.claude/eyes
#                        or $PWD/.claude/eyes)
#   CLAUDE_EYES_TTL     freshness window in seconds (default 30)
#   CLAUDE_EYES_LOG     append log path (default unset = no log)

set -u

# Resolve the eyes directory.
if [ -n "${CLAUDE_EYES_DIR:-}" ]; then
    EYES_DIR="$CLAUDE_EYES_DIR"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    EYES_DIR="$CLAUDE_PROJECT_DIR/.claude/eyes"
else
    EYES_DIR="$PWD/.claude/eyes"
fi

TTL="${CLAUDE_EYES_TTL:-30}"
LOG_FILE="${CLAUDE_EYES_LOG:-}"

log() {
    if [ -n "$LOG_FILE" ]; then
        printf '%s userpromptsubmit-inject: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true
    fi
}

# Drain stdin so we never block on a pipe.
if [ ! -t 0 ]; then
    cat >/dev/null 2>&1 || true
fi

LAST_JSON="$EYES_DIR/last.json"
LAST_PNG="$EYES_DIR/last.png"

if [ ! -f "$LAST_JSON" ] || [ ! -f "$LAST_PNG" ]; then
    log "no capture at $EYES_DIR"
    exit 0
fi

# Age of last.json in seconds. mtime via stat. macOS and Linux differ.
now_epoch="$(date -u +%s)"
mtime_epoch=""
if stat -f %m "$LAST_JSON" >/dev/null 2>&1; then
    # BSD stat (macOS)
    mtime_epoch="$(stat -f %m "$LAST_JSON" 2>/dev/null || echo "")"
else
    # GNU stat (Linux)
    mtime_epoch="$(stat -c %Y "$LAST_JSON" 2>/dev/null || echo "")"
fi

if [ -z "$mtime_epoch" ]; then
    log "could not stat $LAST_JSON"
    exit 0
fi

age=$(( now_epoch - mtime_epoch ))
if [ "$age" -lt 0 ]; then
    age=0
fi

if [ "$age" -gt "$TTL" ]; then
    log "capture stale age=${age}s ttl=${TTL}s"
    exit 0
fi

# Compose absolute paths for the image tag.
abs_png=""
if command -v python3 >/dev/null 2>&1; then
    abs_png="$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$LAST_PNG" 2>/dev/null || echo "")"
fi
if [ -z "$abs_png" ]; then
    case "$LAST_PNG" in
        /*) abs_png="$LAST_PNG" ;;
        *)  abs_png="$PWD/$LAST_PNG" ;;
    esac
fi

# Read optional metadata from last.json. We do NOT require jq; we extract a
# couple of common fields with pure POSIX tools, best-effort.
url_line=""
ts_line=""
if [ -r "$LAST_JSON" ]; then
    # Grep for "url":"..." and "capturedAt":"..."
    url_val="$(grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' "$LAST_JSON" 2>/dev/null | head -n1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
    ts_val="$(grep -o '"capturedAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$LAST_JSON" 2>/dev/null | head -n1 | sed 's/.*"capturedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
    if [ -n "$url_val" ]; then
        url_line="preview url: $url_val"
    fi
    if [ -n "$ts_val" ]; then
        ts_line="captured at: $ts_val"
    fi
fi

# Build additionalContext as a JSON string body. We hand the raw multi-line
# text to node, which is already a hard dep elsewhere in the project, but we
# also fall back to a pure-awk encoder so this hook works without node.
context_body="$(printf '%s\n%s\n\n%s\n%s\n%s\n\n%s\n%s\n%s\n%s\n' \
"👁 claude-eyes — a live screenshot of the user's dev preview is available." \
"" \
"  path:        $abs_png" \
"  $url_line" \
"  $ts_line (${age}s ago)" \
"BEFORE answering any question about UI / design / layout / what the page looks like, you MUST use the Read tool on that path to actually see the current rendered state. The PNG is the source of truth — not the DOM, not the source files, not your memory of previous edits." \
"DO NOT spawn a new browser via playwright, gstack/browse, or any other tool to capture this page — claude-eyes already did, the file above is fresh." \
"" \
"If you just edited code in this project, the capture will refresh on next prompt automatically — no manual snapshot needed.")"

if command -v node >/dev/null 2>&1; then
    payload="$(CTX="$context_body" node -e '
        const ctx = process.env.CTX ?? "";
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: ctx,
            },
        }));
    ')"
    printf '%s\n' "$payload"
else
    # Pure-awk fallback: read all of stdin (the body) as one string, escape
    # every control character, emit a single JSON-safe quoted string body.
    escaped="$(printf '%s' "$context_body" | awk '
        BEGIN{
            for(i=0;i<256;i++) ord[sprintf("%c",i)]=i
            RS="\0"
            out=""
        }
        {
            s=$0
            n=length(s)
            for(i=1;i<=n;i++){
                c=substr(s,i,1)
                if(c=="\\") out=out "\\\\"
                else if(c=="\"") out=out "\\\""
                else if(c=="\b") out=out "\\b"
                else if(c=="\f") out=out "\\f"
                else if(c=="\n") out=out "\\n"
                else if(c=="\r") out=out "\\r"
                else if(c=="\t") out=out "\\t"
                else {
                    v=ord[c]
                    if(v<32) out=out sprintf("\\u%04x",v)
                    else out=out c
                }
            }
        }
        END{ printf "%s", out }
    ')"
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$escaped"
fi

log "injected capture age=${age}s png=$abs_png"
exit 0
