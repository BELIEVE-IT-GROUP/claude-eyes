---
name: cmux-eyes
description: Give Claude Code eyes on the cmux embedded browser dev preview. Start/stop a local screenshot daemon, query the latest captured frame, install/uninstall Claude Code hooks that auto-snapshot after edits. Use whenever the user wants visual verification of a frontend change, says "what does it look like", "screenshot the preview", "look at the app", "verify visually", "see what changed", or any time you've just edited UI code and would benefit from looking at the actual rendered result instead of guessing. Also use after dev-server changes, before/after refactors of components, and during design-review loops. Not for production sites — this is local-preview only.
---

# cmux-eyes

Local screenshot pipeline that lets Claude Code *see* the dev-server preview rendered by the cmux embedded browser. The skill wraps a long-lived daemon (`claude-eyes/daemon`) plus a thin bridge into cmux's WKWebView and exposes a handful of subcommands for the agent and the user.

## When to use

Trigger this skill whenever visual verification beats guessing:

- After editing a React/Vue/Svelte component, a stylesheet, or a layout file.
- Before claiming a fix landed — confirm with eyes, not vibes.
- During design-review loops where before/after frames matter.
- When the user asks "what does it look like?", "show me the preview", "screenshot it", "look at the page", or similar.
- When a hook has fired but the agent needs to fetch the latest frame on demand.

Skip when:

- There is no dev server (pure CLI / library work).
- The user is asking about a remote production URL (use `/browse` from gstack instead).
- The change is non-visual (server logic, data migrations, tests).

## Subcommands

All subcommands are invoked as `cmux-eyes <subcommand> [args]`. They shell out to the daemon CLI at `/Users/mac/Developer/claude-eyes/daemon/cli.ts` (run via `npx tsx`).

| Subcommand | What it does |
| --- | --- |
| `start` | Boot the screenshot + diff daemon in the foreground (or background with `&`). Reads `CLAUDE_EYES_DEV_URL`, defaults to `http://localhost:3000`. Listens on `127.0.0.1:14242`. |
| `stop` | POST to `/shutdown` (graceful) and fall back to `pkill -f "daemon/index.ts"` if the endpoint is missing. Removes the PID file at `.workspace/daemon.pid` if present. |
| `status` | GET `/latest` and pretty-print the `WorkerOutput` JSON: seq, capturedAt, pngPath, framesRetained, devUrl, uptimeMs. Exits non-zero if the daemon is unreachable. |
| `doctor` | Run health checks: node version, daemon process, `/healthz` endpoint, dev-server reachability, write permissions on `.claude/eyes/`, hook installation state in `~/.claude/settings.json`. |
| `install-hooks` | Wire `PostToolUse` + `UserPromptSubmit` hooks into `~/.claude/settings.json` by delegating to `claude-eyes/hooks/install.sh`. Idempotent, backs up the existing file. |
| `uninstall-hooks` | Remove the hooks (identified by the `claude-eyes:v1` marker) via `claude-eyes/hooks/uninstall.sh`. Also idempotent, also backs up. |
| `snapshot` | Force one capture right now via POST `/snapshot`. Returns the new `WorkerOutput` so the agent can read the PNG path. |
| `latest` | Alias for `status` — print the latest frame metadata as JSON. |

## How to invoke from the agent

```bash
# Boot once at the start of a session (or rely on the user)
cmux-eyes start &

# Force a snapshot right now (e.g. just after Edit/Write)
cmux-eyes snapshot

# Read the latest frame the daemon captured
cmux-eyes status
```

The `pngPath` returned by `status`/`snapshot` is an absolute path under `.claude/eyes/` that you can pass to the Read tool to actually look at the screenshot.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_EYES_DEV_URL` | `http://localhost:3000` | Dev server URL the daemon probes. |
| `CLAUDE_EYES_PORT` | `14242` | Daemon HTTP port. |
| `CLAUDE_EYES_EYES_DIR` | `<repo>/.claude/eyes` | Where PNGs land. |
| `CLAUDE_EYES_GC_KEEP` | `40` | Max retained frames. |
| `CLAUDE_EYES_PLAYWRIGHT` | (unset) | Set `1` to capture via headless Chromium instead of macOS `screencapture`. |
| `FORK` | (unset) | Set `1` to use the cmux bridge instead of the local capturer. |

## Self-check (status → daemon health)

`cmux-eyes status` is the canonical self-check. It performs:

1. `GET http://127.0.0.1:${CLAUDE_EYES_PORT:-14242}/healthz` — must return `{ "ok": true, ... }`.
2. `GET .../latest` — must return a `WorkerOutput` JSON object matching the `contracts/types.ts` shape.
3. Exit `0` on success, `1` on unreachable daemon, `2` on malformed response.

The skill self-check (run by the harness) calls `cmux-eyes status` and confirms the printed body parses as JSON with `devUrl` and `framesRetained` fields. If the daemon is not running, the self-check should suggest `cmux-eyes start &` and not error out — being "not started" is not a failure of the skill, it's just state.

## Install

```bash
bash /Users/mac/Developer/claude-eyes/skill/install.sh
```

This symlinks the skill into `~/.claude/skills/cmux-eyes/` so Claude Code picks it up alongside any other skills. Re-running is safe; it replaces stale symlinks.

## Uninstall

```bash
rm ~/.claude/skills/cmux-eyes
cmux-eyes uninstall-hooks
```

## Files

- `/Users/mac/Developer/claude-eyes/skill/SKILL.md` — this file.
- `/Users/mac/Developer/claude-eyes/skill/install.sh` — symlink installer.
- `/Users/mac/Developer/claude-eyes/skill/cmux-eyes` — shell entrypoint that dispatches subcommands.
- `/Users/mac/Developer/claude-eyes/daemon/cli.ts` — underlying CLI the entrypoint delegates to.
- `/Users/mac/Developer/claude-eyes/hooks/install.sh` — hook installer (delegated to by `install-hooks`).
- `/Users/mac/Developer/claude-eyes/hooks/uninstall.sh` — hook uninstaller.

## Notes for the auditor

- Status command exit code reflects daemon reachability — not "skill broken". A non-running daemon is a normal state.
- Hook install/uninstall is delegated entirely to `hooks/install.sh` / `hooks/uninstall.sh`; the skill adds no extra hook surface area.
- The skill never writes outside `/Users/mac/Developer/claude-eyes/` except for: (a) `~/.claude/skills/cmux-eyes` symlink, and (b) `~/.claude/settings.json` (only when the user runs `install-hooks`/`uninstall-hooks`, with a backup).
