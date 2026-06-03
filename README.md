# 👁 claude-eyes

> **Give Claude Code eyes on your dev server. No Lovable. No Cursor. Your stack, your terminal.**

A live UI feedback loop for [Claude Code](https://docs.claude.com/claude-code) that captures your dev server preview after every edit and feeds it back to the model as multimodal context. Built as a side-car daemon today, with a native [cmux](https://github.com/manaflow-ai/cmux) WKWebView bridge coming next.

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Status: v0.1 alpha](https://img.shields.io/badge/status-v0.1%20alpha-orange.svg)](#status)
[![Node 20+](https://img.shields.io/badge/node-20%2B-green.svg)](#configuration)

![claude-eyes demo](docs/demo-readme.gif)

> Left pane: cmux WKWebView showing the live dev preview.
> Right pane: a Claude Code session reading the PNG that the daemon just captured, then critiquing the actual pixels — not the DOM, not a guess.

---

## What you get

After 4 design fixes the model said unprompted:

> *"The footer is now better designed than the main content. The chips of code have more visual detail than the `<h2>` of the cards. That tells you something about how undercrafted the cards were."*

That's regression critique you can't get from a model without eyes. That's claude-eyes.

---

## TL;DR

```bash
# 1. Clone + install (installs hooks + global `claude-eyes` command)
git clone https://github.com/BELIEVE-IT-GROUP/claude-eyes ~/Developer/claude-eyes
cd ~/Developer/claude-eyes && bash install.sh

# 2. In any frontend project, start the daemon
cd ~/Developer/<your-project>
CLAUDE_EYES_PLAYWRIGHT=true CLAUDE_EYES_DEV_URL=http://localhost:5173 claude-eyes start &
```

Three commands to remember:

```bash
claude-eyes start     # boot the daemon (use env vars above)
claude-eyes status    # health + latest capture metadata
claude-eyes stop      # graceful shutdown
```

Then open Claude Code in the same project. Every `Edit`/`Write` triggers a screenshot. Every prompt injects it as `<image>` context. Claude sees your UI.

---

## What it does

1. **Watch** — `chokidar` debounces file changes on `*.{tsx,jsx,ts,css,html,vue,svelte}`.
2. **Capture** — Playwright (today) or cmux WKWebView bridge (next) screenshots your dev server.
3. **Diff** — `pixelmatch` highlights what changed since the last frame, with a tight bounding box.
4. **Inject** — A `UserPromptSubmit` hook attaches the latest PNG to Claude Code's next turn.

Multi-viewport (mobile/tablet/desktop), external tab capture (Figma/Notion/Linear preview side-by-side with your dev server), and a tiny HTTP API for headless control are all in scope.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────┐
│  Claude Code    │  hooks  │  claude-eyes daemon      │
│  (cmux tab)     │ ◄─────► │  127.0.0.1:14242         │
└─────────────────┘  HTTP   │   • chokidar watcher     │
                            │   • Playwright capturer  │
                            │   • pixelmatch diff      │
                            │   • multi-viewport       │
                            └────────────┬─────────────┘
                                         │ writes
                                         ▼
                            .claude/eyes/last.{png,json}
                                         │
                                         ▼
                            Next prompt → <image> in context
```

Two capture modes:

| Mode | When | Cost | Latency |
|---|---|---|---|
| **Playwright** (today) | `CLAUDE_EYES_PLAYWRIGHT=true` | ~300 MB Chromium + spawn | 150–250 ms |
| **cmux bridge** (next) | `CLAUDE_EYES_FORK=true` | None (uses your existing cmux tab) | 50–80 ms |

The cmux bridge requires the [BELIEVE-IT-GROUP/cmux-eyes-bridge](https://github.com/BELIEVE-IT-GROUP/cmux-eyes-bridge) fork until upstream merges the `browser.bridge.*` namespace.

---

## Comparison

| | claude-eyes | Lovable | Cursor | Continue |
|---|---|---|---|---|
| Live UI feedback to AI | ✅ | ✅ | ❌ | ❌ |
| Use your own IDE | ✅ Claude Code | ❌ web app only | ✅ VS Code fork | ✅ VS Code ext |
| Use your own stack | ✅ any | ❌ React+Tailwind+shadcn | ✅ | ✅ |
| Self-hosted | ✅ all local | ❌ SaaS | partial | ✅ |
| Free of subscription | ✅ | ❌ | ❌ | ✅ |
| Visual diff between turns | ✅ | ❌ | ❌ | ❌ |
| Multi-viewport autocapture | ✅ | partial | ❌ | ❌ |
| External tab capture (Figma) | ✅ | ❌ | ❌ | ❌ |

Detailed breakdown in [`docs/COMPARISON.md`](docs/COMPARISON.md).

---

## Configuration

All env vars are optional. Defaults assume a Vite dev server on `localhost:5173`.

| Variable | Default | What |
|---|---|---|
| `CLAUDE_EYES_DEV_URL` | `http://localhost:5173` | Dev server to screenshot. **Must be loopback** unless `CLAUDE_EYES_ALLOW_REMOTE=true`. |
| `CLAUDE_EYES_PORT` | `14242` | Daemon HTTP port |
| `CLAUDE_EYES_PLAYWRIGHT` | `false` | Use Playwright for capture |
| `CLAUDE_EYES_FORK` | `false` | Use cmux WKWebView bridge (requires fork) |
| `CLAUDE_EYES_GC_KEEP` | `20` | How many frames to retain on disk |
| `CLAUDE_EYES_DEBOUNCE` | `250` | Debounce ms for file watcher |
| `CLAUDE_EYES_ALLOW_REMOTE` | `false` | Allow non-loopback dev URL (use with caution) |
| `CMUX_SOCKET_PATH` | auto | Path to cmux socket |
| `CMUX_PASSWORD` | unset | Send `auth.login` with this password before any cmux command |

Per-project config in `.claude-eyes.json`:

```json
{
  "devUrl": "http://localhost:3000",
  "watched_external_tabs": [
    { "tab_label": "figma",     "url": "https://figma.com/file/..." },
    { "tab_label": "storybook", "url": "http://localhost:6006" }
  ]
}
```

---

## Security

- HTTP API authenticated with `X-Eyes-Key` header. Key auto-generated on first daemon start at `~/.claude-eyes/key` (chmod 600). Validated with constant-time comparison.
- Dev URL validation: parsed and rejected unless loopback (`localhost`, `127.x`, `::1`, `*.localhost`).
- Playwright contexts: `serviceWorkers: 'block'`, `permissions: []`. JS stays enabled because SPAs need it.
- cmux bridge `browser.bridge.evaluate` defaults to `WKContentWorld.defaultClient` (isolated). `WKContentWorld.page` is opt-in only.

Full threat model in [`SECURITY.md`](SECURITY.md).

---

## Status

- ✅ **Side-car (Playwright mode):** v0.1 alpha, validated end-to-end against a Vite + React pilot.
- ⏳ **cmux bridge (fork mode):** code complete, build verified, runtime smoke pending. Maintained at [BELIEVE-IT-GROUP/cmux-eyes-bridge](https://github.com/BELIEVE-IT-GROUP/cmux-eyes-bridge). PR to manaflow-ai/cmux planned after smoke validation.
- ⏳ **Skill `/cmux-eyes start`:** orchestrator that auto-arranges split + browser tab + daemon. Planned for v0.2.

### Honest limitations today

- macOS only for the bridge mode (cmux is macOS-only). The side-car works on Linux but the bridge does not.
- Build process for the cmux fork requires `zig 0.15.2` + `scripts/setup.sh` from cmux upstream.
- `captureMethod` field in `last.json` is mislabeled in some edge cases (cosmetic).
- The `PostToolUse` hook can collide with other Claude Code hooks that invoke bare `python`. Logged as non-blocking.

---

## Roadmap

- **v0.1** — Side-car prod-ready (current).
- **v0.1.x** — `/cmux-eyes start` skill: auto-split + browser tab + daemon orchestration.
- **v0.2** — cmux bridge default. Playwright deprecated to fallback.
- **v0.3** — External tab capture: Figma, Linear, Notion preview side-by-side with dev server in the same `<image>` injection.
- **v0.4** — Region capture: tell Claude to inspect a specific bounding box, not the whole page.

---

## Try it on the included pilot

A minimal Vite + React example lives in `docs/examples/vite-pilot/`. To run end-to-end without your own project:

```bash
# Terminal 1: pilot dev server
cd docs/examples/vite-pilot && npm install && npm run dev

# Terminal 2: claude-eyes daemon pointed at it
cd docs/examples/vite-pilot
CLAUDE_EYES_PLAYWRIGHT=true \
  npx tsx ../../../daemon/cli.ts

# Terminal 3: claude code in that directory
cd docs/examples/vite-pilot && claude
# now ask: "make the button red, larger, and add a fire emoji"
# then ask: "how does the button look?"
# the model will describe what it sees in the screenshot
```

---

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md). The code respects GPL-3.0; if you ship a derivative, it has to stay open.

For the cmux Swift fork, see the companion repo [BELIEVE-IT-GROUP/cmux-eyes-bridge](https://github.com/BELIEVE-IT-GROUP/cmux-eyes-bridge).

---

## Credits

Built by [Believe Global](https://github.com/BELIEVE-IT-GROUP) as part of a multiagent harness experiment. The harness itself (auditors that reject, contracts that bind workers, resume points on failure) is what built most of this code. Humans designed the strategy; agents wrote the implementation.

cmux by [@manaflow-ai](https://github.com/manaflow-ai) — without their socket API + WKWebView embedding, none of this is possible.

---

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
