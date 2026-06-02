/**
 * daemon/playwright-capturer.ts — Playwright-based screenshot capture.
 *
 * Used when CLAUDE_EYES_PLAYWRIGHT=true so that E2E tests (and headless CI
 * environments where screencapture lacks Screen Recording permissions) can
 * still produce real PNG captures of the dev server.
 *
 * This is intentionally a lightweight wrapper: it launches a headless
 * Chromium page, navigates to devUrl, and takes a fullPage screenshot.
 * The browser is kept alive between calls and reused for subsequent captures.
 */

import type { BridgeSnapshotResult } from "@contracts/index.js";
import { probeDevServer } from "./screencapturer.js";

/**
 * Thin lazy-import wrapper so the file can be imported even when
 * the `playwright` package is absent — the error surfaces only on first use.
 */
async function lazyPlaywright() {
  // dynamic import so daemon boots without playwright when PLAYWRIGHT!=true
  const pw = await import("playwright");
  return pw;
}

/**
 * PlaywrightCapturer — wraps a headless Chromium instance to screenshot a URL.
 * Call `.capture()` to take a screenshot.
 * Call `.close()` during shutdown.
 */
export class PlaywrightCapturer {
  private readonly devUrl: string;
  private browserPromise: Promise<import("playwright").Browser> | null = null;

  constructor(opts: { devUrl: string }) {
    this.devUrl = opts.devUrl;
  }

  /**
   * Emit a one-time deprecation notice to stderr when the cmux bridge is
   * active (CLAUDE_EYES_FORK=true / useBridge=true). In bridge mode Playwright
   * is no longer the primary capture path; it remains available as a fallback
   * only. Call this once at daemon startup when config.useBridge is true.
   */
  static emitBridgeDeprecationWarning(): void {
    process.stderr.write(
      "[claude-eyes] DEPRECATION: Playwright is now optional when CLAUDE_EYES_FORK=true.\n" +
      "[claude-eyes]   The daemon routes captures through the cmux bridge" +
      " (browser.bridge.snapshot).\n" +
      "[claude-eyes]   Playwright will only be used as a fallback when the bridge fails.\n" +
      "[claude-eyes]   Set CLAUDE_EYES_PLAYWRIGHT=false (or omit the flag) to suppress this.\n"
    );
  }

  /** Lazy-init the Playwright browser (reused between calls). */
  private getBrowser(): Promise<import("playwright").Browser> {
    if (this.browserPromise === null) {
      this.browserPromise = (async () => {
        const { chromium } = await lazyPlaywright();
        const browser = await chromium.launch({ headless: true });
        return browser;
      })();
    }
    return this.browserPromise;
  }

  /**
   * Capture a screenshot of devUrl.
   * Returns BridgeSnapshotResult + httpStatus (probed in parallel).
   */
  async capture(): Promise<BridgeSnapshotResult & { httpStatus: number | null }> {
    const probePromise = probeDevServer(this.devUrl);

    try {
      const browser = await this.getBrowser();
      // SECURITY: JS stays enabled because SPAs (Vite/Next/etc.) need it to
      // render. The threat model of "hostile dev server JS" is already mitigated
      // by assertSafeDevUrl() in daemon/index.ts which enforces loopback-only.
      // We still block serviceWorkers (no persistent state) and grant no
      // permissions (no geo/camera/clipboard/notifications).
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        permissions: [],
      });
      const page = await context.newPage();

      try {
        await page.goto(this.devUrl, { waitUntil: "networkidle", timeout: 10000 });
        const pngBuffer = await page.screenshot({ fullPage: false });
        const width = 1280;
        const height = 800;

        const probe = await probePromise;
        return {
          ok: true,
          pngBuffer: Buffer.from(pngBuffer),
          width,
          height,
          httpStatus: probe.status,
        };
      } finally {
        await context.close();
      }
    } catch (err: unknown) {
      const probe = await probePromise.catch(() => ({
        reachable: false,
        status: null as number | null,
        latencyMs: null as number | null,
      }));
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, httpStatus: probe.status };
    }
  }

  /**
   * Capture a screenshot of an arbitrary URL (not the configured devUrl).
   * Used for external/auxiliary tabs declared in `.claude-eyes.json`.
   * Returns BridgeSnapshotResult — without httpStatus (the caller probes).
   */
  async captureUrl(url: string): Promise<BridgeSnapshotResult> {
    try {
      const browser = await this.getBrowser();
      // SECURITY: JS stays enabled because SPAs (Vite/Next/etc.) need it to
      // render. The threat model of "hostile dev server JS" is already mitigated
      // by assertSafeDevUrl() in daemon/index.ts which enforces loopback-only.
      // We still block serviceWorkers (no persistent state) and grant no
      // permissions (no geo/camera/clipboard/notifications).
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        permissions: [],
      });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 10000 });
        const pngBuffer = await page.screenshot({ fullPage: false });
        return {
          ok: true,
          pngBuffer: Buffer.from(pngBuffer),
          width: 1280,
          height: 800,
        };
      } finally {
        await context.close();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /** Close the underlying Playwright browser. */
  async close(): Promise<void> {
    if (this.browserPromise !== null) {
      try {
        const browser = await this.browserPromise;
        await browser.close();
      } catch {
        // ignore close errors
      }
      this.browserPromise = null;
    }
  }
}
