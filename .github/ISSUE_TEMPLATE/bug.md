---
name: Bug report
about: Something's broken in claude-eyes itself
title: '[BUG] '
labels: bug
assignees: ''
---

## What happened

A clear, concise description of the actual behavior.

## What you expected

A clear, concise description of the expected behavior.

## Reproduction

1. Run `...`
2. Edit `...`
3. See error in `...`

## Environment

- macOS version:
- Node version: (`node --version`)
- claude-eyes version: (`cat package.json | grep version`)
- cmux version (if applicable):
- Capture mode: `CLAUDE_EYES_PLAYWRIGHT` / `CLAUDE_EYES_FORK` / neither

## Attached

- [ ] Daemon log (`/tmp/claude-eyes-daemon.log` — redact paths if sensitive)
- [ ] `.claude/eyes/last.json` (redact `sourceUrl` if private)
- [ ] Screenshot of the bad capture if visual

## Additional context

Anything else worth knowing — recent updates, parallel hooks installed (vibeyard, etc.), unusual project setup.
