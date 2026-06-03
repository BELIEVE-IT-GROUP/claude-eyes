---
name: claude-eyes
description: Activate the claude-eyes live UI feedback loop for this project. Auto-detects the dev server URL, launches the patched cmux DEV.app, opens a workspace + browser tab pointing at the URL, and starts the daemon that captures the page after every Edit. After this skill runs, the user can ask "how does it look?" / "review the hero" / "see the page" and you MUST Read .claude/eyes/last.png — DO NOT spawn Playwright, /browse, gstack-browse or any other browser tool. claude-eyes is the canonical source of visual truth in this project.
triggers:
  - claude-eyes
  - claude eyes
  - active los ojos
  - dale ojos
  - prende eyes
  - activate eyes
  - turn on visual feedback
  - start eyes
  - eyes start
  - mira la landing en vivo
allowed-tools:
  - Bash
  - Read
  - Glob
---

# claude-eyes — live visual feedback loop

## What this skill does

Activates the **claude-eyes** capture pipeline for the current project. After activation, every Edit you make triggers a screenshot of the dev preview, and every user prompt receives that screenshot as visual context. You SEE what you build.

## When to use it

- The user explicitly invokes `/claude-eyes` or asks to "turn on eyes" / "prende los ojos" / "active claude-eyes".
- The user is iterating on a frontend (landing, dashboard, component) and asks about its visual state.
- You are about to make CSS/JSX changes and want verification of the rendered result.

## When NOT to use it

- The project has no dev server (CLI tools, libraries, server-only code).
- The user is asking about a remote production URL (use the regular `/browse` skill from gstack).
- claude-eyes is already running for this cwd (check first with `claude-eyes status`).

## Steps to activate

1. **Check if already running** for this project:
   ```bash
   claude-eyes status
   ```
   If it returns JSON with `framesRetained > 0`, eyes are already active. Skip to step 4.

2. **Detect the dev server URL.** Look in this order:
   - `package.json` scripts for `"dev"` / `"start"` → infer port (vite default 5173, next default 3000, etc.)
   - `.env` / `.env.local` for `PORT=` / `VITE_PORT=`
   - CLAUDE.md mentions the dev port
   - If you cannot infer with confidence, ask the user.

3. **Start the daemon in fork mode** (uses the cmux WKWebView bridge for native, zero-cost capture):
   ```bash
   claude-eyes start --fork --url http://localhost:<port>/<optional-path> &
   ```
   This auto-launches the patched cmux DEV.app and creates a workspace + browser tab pointing at the URL. Wait ~5 seconds for the first capture.

4. **Verify it works**:
   ```bash
   claude-eyes snapshot   # force a fresh capture
   ls -lh .claude/eyes/last.png
   ```

5. **Read the capture and report**:
   ```
   Read .claude/eyes/last.png
   ```
   Describe what you see to the user. From this point on, every subsequent user prompt will inject the latest capture automatically — you will already see the page on the next turn without any extra step.

## Hard rules

- **The PNG at `.claude/eyes/last.png` IS the live preview.** When the user asks "how does it look?", you Read that file. You do NOT spawn `/browse`, `playwright`, `gstack browse`, or `npm run dev` to take your own screenshot. claude-eyes is already doing that work, and going around it wastes the user's tokens.
- **If the capture looks inadequate** (page too long, hero compressed, wrong viewport), use `claude-eyes snapshot` to refresh — do NOT switch to a different tool. The desktop capture is 1440×900 by default, which matches what a designer sees.
- **Stop on `claude-eyes stop`**, status with `claude-eyes status`. Three commands. That's the whole UX.

## Three-command cheat sheet

```bash
claude-eyes start --fork --url http://localhost:5173    # boot
claude-eyes status                                       # health
claude-eyes stop                                         # shutdown
```

## More context

- Repo: https://github.com/BELIEVE-IT-GROUP/claude-eyes
- Daemon source: `/Users/mac/Developer/claude-eyes/daemon/`
- Hook scripts (already installed at `~/.claude/settings.json`): `/Users/mac/Developer/claude-eyes/hooks/`
- Capture key for HTTP API: `~/.claude-eyes/key`
