# Architecture

Claude Eyes is three small Node.js processes (bridge, daemon, hooks) that turn the cmux embedded browser into a screenshot oracle for Claude Code. This doc walks the data flow from agent prompt to PNG on disk and back to the model, then enumerates the contracts every process agrees on.

## 1. Processes and responsibilities

| Process | Lives | Owns |
| --- | --- | --- |
| **bridge** (`bridge/`) | Spawned by daemon when `FORK=true`, otherwise dormant. | The cmux socket adapter. Single method: `snapshot() → BridgeSnapshotResult`. Stateless. |
| **daemon** (`daemon/`) | One long-lived process per workspace, bound to `127.0.0.1:14242`. | Capture pipeline, file watcher, frame storage, GC, HTTP API, fallback chain. |
| **hooks** (`hooks/`) | Short-lived bash scripts spawned by Claude Code. | Triggering captures on tool events (`PostToolUse`) and injecting the latest frame path into the model context (`UserPromptSubmit`). |

State of record lives in `.workspace/state.json`. Frames live in `.claude/eyes/`. Everything else is ephemeral.

## 2. Data flow — happy path

```
1.  User runs Claude Code in the repo.
2.  Claude Code edits a file (Edit/Write tool).
3.  PostToolUse hook fires:
      hooks/posttooluse-snapshot.sh
        → curl -X POST http://127.0.0.1:14242/snapshot
4.  Daemon receives POST /snapshot:
      a.  Bumps state.seq
      b.  Picks capture path:
            - FORK=true && bridge alive  → BridgeClient.snapshot()
            - CLAUDE_EYES_PLAYWRIGHT=true → PlaywrightCapturer.capture()
            - else                        → ScreenCapturer.capture()
      c.  Probes dev URL for HTTP status (separate probe in bridge mode).
      d.  Writes:
            .claude/eyes/00037.png
            .claude/eyes/00037.json   (EyeFrame, matches contracts/types.ts)
            .claude/eyes/last.png     (symlink → 00037.png)
            .claude/eyes/last.json    (symlink → 00037.json)
      e.  GC: deletes frames older than CLAUDE_EYES_GC_KEEP (default 20).
      f.  Returns WorkerOutput JSON in the HTTP response.
5.  Daemon also watches the workspace (chokidar, 250 ms debounce).
    A file change triggers steps 4a–e independently of the hook —
    so a `vite` HMR cycle captures itself without help.
6.  Next user prompt fires UserPromptSubmit hook:
      hooks/userpromptsubmit-inject.sh
        → curl http://127.0.0.1:14242/latest
        → echoes "eyes: <pngPath> seq=<n>" into Claude Code context
7.  Claude Code reads .claude/eyes/last.png (or the seq'd one) directly.
```

## 3. Capture pipeline (3-tier fallback)

The daemon never gives up on a capture. It tries the configured path first, then degrades:

```
        ┌─────────────────────────┐
        │ POST /snapshot received │
        └────────────┬────────────┘
                     ▼
        ┌─────────────────────────┐
        │ FORK=true?              │──no──┐
        └────────────┬────────────┘      │
                    yes                  │
                     ▼                   │
        ┌─────────────────────────┐      │
        │ BridgeClient.snapshot() │      │
        │ → cmux browser.snapshot │      │
        └────────────┬────────────┘      │
              ok ────┼──── err           │
                     │      │            │
                     │      ▼            ▼
                     │  ┌──────────────────────────┐
                     │  │ CLAUDE_EYES_PLAYWRIGHT?  │──no──┐
                     │  └────────────┬─────────────┘      │
                     │              yes                    │
                     │               ▼                     │
                     │  ┌──────────────────────────┐       │
                     │  │ PlaywrightCapturer       │       │
                     │  │ (headless Chromium)      │       │
                     │  └────────────┬─────────────┘       │
                     │         ok ───┼─── err              │
                     │               │     │               │
                     │               │     ▼               ▼
                     │               │  ┌─────────────────────┐
                     │               │  │ ScreenCapturer      │
                     │               │  │ (HTTP probe only)   │
                     │               │  └────────────┬────────┘
                     ▼               ▼               ▼
                  ┌────────────────────────────────────┐
                  │ writeFrame() → EyeFrame on disk    │
                  │ error field populated if all       │
                  │ paths failed                       │
                  └────────────────────────────────────┘
```

`EyeFrame.captureMethod` records which path actually produced the bytes, and `EyeFrame.error` is non-null if every tier failed (the frame is still written so the agent gets a deterministic file to read).

## 4. Storage layout

```
.claude/eyes/
├── 00001.png        ← seq-numbered, never reused within a run
├── 00001.json       ← matches contracts/types.ts → EyeFrame
├── 00002.png
├── 00002.json
├── …
├── 00037.png
├── 00037.json
├── last.png         → symlink to 00037.png (always the newest)
└── last.json        → symlink to 00037.json
```

GC keeps the most recent `CLAUDE_EYES_GC_KEEP` frames (default 20) and unlinks the rest. The symlinks `last.png` / `last.json` are rewritten atomically on every successful write so a concurrent reader is never racing a half-written frame.

## 5. HTTP API (daemon)

| Endpoint | Method | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| `/healthz` | GET | — | `HealthResponse` | Always 200 while the process is alive. |
| `/latest` | GET | — | `WorkerOutput` | Returns the most recent capture (may be null fields if no capture yet). |
| `/snapshot` | POST | `SnapshotRequest` (optional) | `WorkerOutput` | Triggers an immediate capture. Body lets you override the dev URL for this one shot. |

The server binds to `127.0.0.1` only — never accept off-machine traffic, because the snapshot endpoint can be abused to point the bridge at arbitrary URLs.

## 6. Contracts

All inter-process types live in [`contracts/types.ts`](../contracts/types.ts) and are re-exported via [`contracts/index.ts`](../contracts/index.ts). The path alias `@contracts/*` is wired in `tsconfig.json`. The processes import types only — there are zero runtime exports from `contracts/`, so the file is safe to load from any process.

Key types:

- **`EyeFrame`** — on-disk JSON for every captured frame. `seq`, `capturedAt`, `pngPath`, `pngRelative`, `jsonPath`, `sourceUrl`, `httpStatus`, `width`, `height`, `captureMethod` (`"bridge" | "screencapturer"`), `error`.
- **`WorkerOutput`** — HTTP response shape for `GET /latest` and `POST /snapshot`. Mirrors the latest `EyeFrame` plus daemon-level fields (`framesRetained`, `devUrl`, `uptimeMs`).
- **`SnapshotRequest`** — optional body for `POST /snapshot` (`{ url?: string }`).
- **`HealthResponse`** — `{ ok: true, uptimeMs, devUrl, framesRetained }`.
- **`BridgeSnapshotResult`** — discriminated union returned by `bridge.snapshot()`: `{ ok: true, pngBuffer, width, height }` or `{ ok: false, error }`.
- **`DaemonConfig`** — fully-resolved env state at startup.

Wire-compatibility rule: changing a field on `EyeFrame` or `WorkerOutput` is a breaking change for hooks and for any agent reading frames. Add new optional fields; never remove or rename.

## 7. Hook integration

Hooks are dumb bash scripts; all logic lives in the daemon. They never block Claude Code for more than the HTTP call:

- `posttooluse-snapshot.sh` — fires on `PostToolUse` for Edit/Write tools. POSTs `/snapshot` with a 2 s timeout. Failures are swallowed (no point blocking the agent on a flaky bridge).
- `userpromptsubmit-inject.sh` — fires on `UserPromptSubmit`. GETs `/latest`, prints `eyes: <pngPath> seq=<n>` to stdout so the hook framework injects it into the model context.
- `install.sh` / `uninstall.sh` — patch `~/.claude/settings.json` (or the project-local one) to register the two hooks.

## 8. Concurrency model

- The daemon serializes captures via the `capturing` flag on `DaemonState`. A second `POST /snapshot` arriving mid-capture waits for the in-flight one to finish, then runs its own. This bounds disk writes and prevents `seq` reuse.
- The file watcher uses a 250 ms debounce so an editor save burst (e.g. format-on-save writing 8 files) coalesces into one capture.
- The bridge owns no state. If the cmux socket drops, the bridge errors on next call, the daemon catches it and falls back to the next tier — no reconnect logic in the bridge.

## 9. Non-goals

- No diffing in this phase. `pixelmatch` is installed but only ad-hoc tests use it; the planned next phase wires it into `WorkerOutput`.
- No multi-surface support. Bridge mode targets exactly one cmux surface (`CMUX_SURFACE_ID`).
- No Linux/Windows bridge. Headless mode works everywhere Node + Playwright run.
- No remote daemon. The HTTP server binds `127.0.0.1` on purpose.
