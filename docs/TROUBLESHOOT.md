# Troubleshooting

Top 5 failure modes seen in audits and recon, with fast triage and fixes. Run these in order if a capture isn't landing.

## Quick triage

```bash
# Is the daemon alive?
curl -s http://127.0.0.1:14242/healthz | jq .

# What does it think the last frame was?
curl -s http://127.0.0.1:14242/latest | jq .

# Force a capture and read the error field
curl -s -X POST http://127.0.0.1:14242/snapshot | jq '{error, httpStatus: .seq, captureMethod}'

# Inspect the most recent frame on disk
cat .claude/eyes/last.json | jq .
ls -la .claude/eyes/ | head
```

If `WorkerOutput.error` is non-null, jump to the matching failure mode below.

---

## 1. Bridge mode: `FORK=true` but cmux socket not reachable

**Symptom**

```
[claude-eyes] bridge.snapshot failed: ENOENT /tmp/cmux.sock — falling back to screencapturer
```

`EyeFrame.captureMethod` ends up `"screencapturer"` even though you set `FORK=true`. Pixels no longer come from the cmux WKWebView.

**Why it happens**

- `CMUX_SOCKET_PATH` (or `CMUX_SOCKET`) is unset, or points to a stale path from a previous cmux run.
- cmux isn't running, or the socket access mode rejected the loopback connection.
- macOS file-permissions: the socket is `0700` and the daemon runs as a different uid (rare, happens when daemon was launched via `sudo`).

**Fix**

```bash
# Confirm cmux is running and find the live socket
lsof -U | grep cmux | head

# Export the path the daemon expects
export CMUX_SOCKET_PATH=/tmp/cmux.sock      # or whatever lsof showed
export CMUX_SURFACE_ID=<the surface id of the browser panel you want>
export FORK=true

# Restart the daemon
npm run daemon
```

If `lsof` shows no socket, cmux isn't up or hasn't created its `TerminalController` socket listener yet — open the cmux app, switch focus to the browser panel once, then retry.

---

## 2. Headless mode: dev URL unreachable / wrong port

**Symptom**

```json
{
  "error": "ECONNREFUSED 127.0.0.1:5173",
  "httpStatus": null,
  "captureMethod": "screencapturer",
  "width": 0,
  "height": 0
}
```

PNG is 0 bytes; `last.png` exists but is empty.

**Why it happens**

- Default `CLAUDE_EYES_DEV_URL` is `http://localhost:5173`. If your dev server runs on `:3000`, `:5174`, etc., probes return ECONNREFUSED.
- The dev server binds `127.0.0.1` but you set `CLAUDE_EYES_DEV_URL=http://0.0.0.0:5173` (or vice versa) and `localhost` resolves to `::1` first on macOS — IPv6 mismatch.
- The dev server is starting up; the first capture races it.

**Fix**

```bash
# Find what's actually listening
lsof -iTCP -sTCP:LISTEN -P | grep node

# Set the right URL and restart
export CLAUDE_EYES_DEV_URL=http://127.0.0.1:3000
npm run daemon

# Sanity-check by hand
curl -I $CLAUDE_EYES_DEV_URL
```

If you want screenshots of the *rendered* page (not just an HTTP probe), enable the Playwright path:

```bash
export CLAUDE_EYES_PLAYWRIGHT=true
npx playwright install chromium   # one-time
npm run daemon
```

---

## 3. Playwright path: missing browser binary

**Symptom**

```
Error: browserType.launch: Executable doesn't exist at /Users/…/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium
╔══════════════════════════════════════════════════════════╗
║ Looks like Playwright Test or Playwright was just installed
║ Please run the following command to download new browsers:
║     npx playwright install
╚══════════════════════════════════════════════════════════╝
```

`captureMethod` flips back to `screencapturer` and `error` carries the Playwright message. `npm install` installs the `playwright` package but **not** the browser binaries.

**Fix**

```bash
npx playwright install chromium
# Or, for full set: npx playwright install
```

If you're in CI, add `npx playwright install --with-deps chromium` to your image build step. Confirm by running `node -e "require('playwright').chromium.executablePath() |> console.log"` (mentally — Playwright is ESM-only in newer versions, use `import` instead).

---

## 4. Frames written but Claude Code never sees them

**Symptom**

Daemon logs show successful captures; `.claude/eyes/last.png` updates; but the model keeps acting like it has no screenshot. `UserPromptSubmit` hook is not injecting the path.

**Why it happens**

- Hooks aren't installed in the active Claude Code settings (`~/.claude/settings.json` or the project's `.claude/settings.json`). `bash hooks/install.sh` was never run, or it patched a different settings file than the one Claude Code actually reads.
- Hook is installed but uses `set -e` and exits non-zero when the daemon is down — Claude Code suppresses the injection.
- The injected line goes to stderr, not stdout. Only stdout is fed into context.

**Fix**

```bash
# Check which settings file Claude Code is actually using
ls -la ~/.claude/settings.json .claude/settings.json 2>/dev/null

# Inspect the hooks block — UserPromptSubmit must reference userpromptsubmit-inject.sh
jq '.hooks' ~/.claude/settings.json

# Re-run the installer (idempotent)
bash hooks/install.sh

# Manually test the injection
bash hooks/userpromptsubmit-inject.sh
# Expected stdout: "eyes: /Users/…/.claude/eyes/last.png seq=37"
```

If `bash hooks/userpromptsubmit-inject.sh` prints nothing, the script is silencing errors. Run it with `bash -x` to see where it bails.

---

## 5. `seq` skipping / stale `last.png` / GC nuking active frames

**Symptom**

- `last.png` is from 10 minutes ago even though `seq` keeps incrementing.
- Two daemon processes are running and `seq` resets unexpectedly.
- The PNG opens fine but Claude Code reads zeros (race on partial write).

**Why it happens**

- Two daemons are bound to different ports (or one died and another took over) — `seq` is per-process, not persisted across restarts, so the second process starts at 1 and overwrites `00001.png`.
- `CLAUDE_EYES_GC_KEEP` is too low for the rate of captures (e.g. set to 5 with file-watcher firing on every keystroke).
- `last.png` symlink rewrite was interrupted (rare — only happens on hard process kill mid-`rename`).
- Two captures arrived simultaneously and the `capturing` flag wasn't honored (bug, file an issue with the timestamps).

**Fix**

```bash
# Find rogue daemons
lsof -iTCP:14242 -sTCP:LISTEN
pgrep -fl 'daemon/index.ts'

# Kill all and restart one cleanly
pkill -f 'daemon/index.ts'
rm -f .claude/eyes/last.png .claude/eyes/last.json   # clear stale symlinks
npm run daemon

# Bump GC if you're losing recent frames
export CLAUDE_EYES_GC_KEEP=50
```

If `last.png` is a dangling symlink (target deleted by GC), the daemon's next capture re-creates it correctly — just trigger one:

```bash
curl -X POST http://127.0.0.1:14242/snapshot
```

---

## Escalation

If none of the above explains it, capture full diagnostic context and share it:

```bash
{
  echo "=== healthz ==="
  curl -s http://127.0.0.1:14242/healthz
  echo
  echo "=== latest ==="
  curl -s http://127.0.0.1:14242/latest
  echo
  echo "=== env ==="
  env | grep -E '^(CLAUDE_EYES|CMUX|FORK)' | sort
  echo "=== eyes dir ==="
  ls -la .claude/eyes/ 2>/dev/null
  echo "=== processes ==="
  pgrep -fl 'daemon/index.ts|bridge/index.ts'
  echo "=== ports ==="
  lsof -iTCP:14242 -sTCP:LISTEN 2>/dev/null
} > /tmp/claude-eyes-diag.txt
```
