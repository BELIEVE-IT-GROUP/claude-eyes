# Security

## Threat model

claude-eyes runs locally on your Mac and screenshots a dev server you control. The threats it defends against are:

1. **Same-machine, different-process exfiltration.** A process running as your UID could otherwise read frames from the daemon and learn what UI you are working on.
2. **SSRF via dev URL.** An attacker who can write to your `.env` or env vars could otherwise point the daemon at an internal-network or internet target.
3. **Hostile dev server JS.** If your local dev server is somehow serving content from an untrusted source, isolating the capture surface limits blast radius.

The threats it does **not** defend against:

- Malware running as your UID with read access to your home directory. Such malware can already read your code, your shell history, your keys. Defending the daemon against that is moot.
- Network attackers. The daemon binds only to `127.0.0.1`.

## Mitigations in place

| Layer | Mitigation |
|---|---|
| HTTP API | `X-Eyes-Key` header required on `/latest` and `/snapshot`. Key generated on first start at `~/.claude-eyes/key`, `chmod 600`. Validated with `crypto.timingSafeEqual`. |
| HTTP API | `/healthz` is public for liveness checks. It returns no frames. |
| Dev URL | Parsed with `new URL()`. Rejected unless `http(s)` + loopback hostname. Override available via `CLAUDE_EYES_ALLOW_REMOTE=true`. |
| Playwright | `serviceWorkers: 'block'`, `permissions: []`. JS stays enabled (SPAs require it; the dev URL loopback rule covers the real risk). |
| cmux bridge | `browser.bridge.evaluate` defaults to `WKContentWorld.defaultClient` (isolated). `WKContentWorld.page` is opt-in via `params.world = "page"`. `browser.bridge.dom` always uses isolated world. |
| cmux socket | Inherits cmux's own per-UID Unix socket permissions. If you enable cmux password auth, set `CMUX_PASSWORD` and the daemon will `auth.login` before commands. |

## Reporting a vulnerability

**Please do not open a public GitHub issue.**

Email security@believe-global.com with:

- Description of the vulnerability
- Reproduction steps
- Affected version
- Your assessment of severity

You will get an acknowledgement within 72 hours. Critical issues get a patch within 7 days; lower severity within 30.

## Out of scope

- Reports that require user-installed malware.
- Reports against the `CLAUDE_EYES_ALLOW_REMOTE=true` escape hatch when explicitly enabled by the user.
- Reports against the cmux upstream (please file those at `github.com/manaflow-ai/cmux`).
