# Contributing to claude-eyes

Thanks for thinking about contributing. This is a small project with a focused scope.

## Scope

- **In scope:** capturing dev server previews, injecting them into Claude Code, diff visual, multi-viewport, external tab capture, cmux bridge integration.
- **Out of scope:** general AI orchestration, Claude Code plugins unrelated to visual context, support for IDEs other than Claude Code.

## Dev setup

```bash
git clone https://github.com/BELIEVE-IT-GROUP/claude-eyes
cd claude-eyes
npm install
npx tsc --noEmit  # type-check
npm test
```

## Code style

- TypeScript strict. No `any` except for genuinely opaque payloads (commented).
- Discriminated unions over untyped variants.
- No swallowed errors. Either propagate or log with context.
- No emojis in code or comments unless they carry semantic weight.
- Function comments only when the why is non-obvious.

## PRs

1. Open an issue first if the change is bigger than a one-file fix.
2. Branch off `main`. Name like `fix/diff-gc-race` or `feat/external-tab-figma`.
3. Update `CHANGELOG.md` under `## Unreleased`.
4. `npm test` and `npx tsc --noEmit` must pass.
5. Squash commits before merge if you have more than 3.

## Reporting bugs

Use the [issue templates](.github/ISSUE_TEMPLATE/). Attach:

- Daemon log (`/tmp/claude-eyes-daemon.log`)
- `.claude/eyes/last.json` (redact paths if you must)
- macOS version, Node version, cmux version
- Whether `CLAUDE_EYES_FORK` or `CLAUDE_EYES_PLAYWRIGHT` was set

## Security issues

Don't open public issues for security. See [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree your code ships under GPL-3.0-or-later.
