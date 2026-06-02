# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha] — 2026-06-02

### Added
- Side-car daemon (`daemon/cli.ts`) with chokidar file watcher, debounce, and HTTP server on `127.0.0.1:14242`.
- Playwright-based capture (`daemon/playwright-capturer.ts`) with reused Chromium instance.
- macOS `screencapture -R` fallback (`daemon/screencapturer.ts`) when Playwright is not available.
- `EyeFrame` contract (`contracts/eye-frame.ts`) with viewports, diff, and external-context support.
- `pixelmatch`-based visual diff (`daemon/diff.ts`) with bounding box of changes.
- Multi-viewport capture (`daemon/multi-viewport.ts`) for mobile/tablet/desktop.
- External tab capture (`daemon/external-tabs.ts`) for Figma/Linear/Notion side-by-side.
- Claude Code hooks: `posttooluse-snapshot.sh` and `userpromptsubmit-inject.sh`.
- Hook installer (`hooks/install.sh`) merges into `~/.claude/settings.json` with timestamped backup.
- `/cmux-eyes` skill scaffold under `skill/` for `start|stop|status|doctor|install-hooks|uninstall-hooks`.
- cmux socket client (`bridge/cmux-client.ts`) with V2 JSON-RPC, CLI fallback, 5s timeout, and `auth.login` support.
- Types for the 4 fork-mode endpoints (`browser.bridge.snapshot`, `.evaluate`, `.dom`, `.set_viewport`), gated by `CLAUDE_EYES_FORK=true`.
- Vite + React pilot example in `docs/examples/vite-pilot/`.

### Security
- HTTP API authenticated with `X-Eyes-Key` header sourced from `~/.claude-eyes/key` (chmod 600), validated constant-time.
- Dev URL `assertSafeDevUrl()` validation rejects non-loopback hosts unless `CLAUDE_EYES_ALLOW_REMOTE=true`.
- Playwright contexts created with `serviceWorkers: 'block'` and `permissions: []`.
- cmux bridge `browser.bridge.evaluate` defaults to isolated world; `browser.bridge.dom` always isolated.

### Known limitations
- macOS only for the cmux bridge mode. Side-car works on Linux but cmux does not.
- cmux fork build requires `zig 0.15.2` + `scripts/setup.sh` from upstream.
- `last.json.captureMethod` field is mislabeled as `"screencapturer"` when Playwright is actually used.
- `PostToolUse` hook may emit non-blocking errors when other Claude Code hook integrations invoke bare `python` (mostly affects vibeyard users on modern macOS without Python 2).
