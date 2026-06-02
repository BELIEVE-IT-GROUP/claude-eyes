/**
 * tests/multi-viewport.test.ts
 *
 * F5 E-1 self-check: exercises captureMultiViewport with a stub bridge.
 *
 * Verifies:
 *  - All 3 viewports (mobile 375x812, tablet 768x1024, desktop 1280x800)
 *    are walked sequentially in order on the *same* bridge instance.
 *  - set_viewport is called before snapshot for each tier.
 *  - One PNG + sidecar JSON is written per viewport, suffixed by tier name.
 *  - viewports[] is populated with 3 entries (no `error`) when all succeed.
 *  - primary pngBuffer = the desktop buffer.
 *  - A single failure in one tier degrades only that entry, others still
 *    succeed, and aggregateError captures the cause.
 *  - Total failure surfaces an empty pngBuffer + non-null error.
 *
 * Pure unit test — no cmux process, no network, no real WKWebView.
 * Run via: `npm test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureMultiViewport,
  VIEWPORT_PROFILES,
  type ViewportCaptureBridge,
} from "../daemon/multi-viewport.js";

// ---------------------------------------------------------------------------
// Stub bridge — records calls + returns deterministic PNG buffers per tier.
// ---------------------------------------------------------------------------

interface CallLog {
  method: "set_viewport" | "snapshot";
  width?: number;
  height?: number;
}

function makeStubBridge(opts: {
  failViewport?: "mobile" | "tablet" | "desktop";
  failSnapshot?: "mobile" | "tablet" | "desktop";
  failAll?: boolean;
} = {}): { bridge: ViewportCaptureBridge; calls: CallLog[] } {
  const calls: CallLog[] = [];
  let lastWidth = 0;
  let lastHeight = 0;
  let currentTier: string = "unknown";

  // Synthesize a tiny but valid 1×1 PNG. We don't care about pixel content —
  // only that the buffer round-trips through writeFile. Bytes lifted from the
  // canonical "tiny PNG" example (RFC-compliant header + IDAT + IEND).
  const tinyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x6f, 0xa3, 0xc0, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const bridge: ViewportCaptureBridge = {
    async setViewport(width, height) {
      calls.push({ method: "set_viewport", width, height });
      lastWidth = width;
      lastHeight = height;
      // Resolve which tier this corresponds to.
      const tier = VIEWPORT_PROFILES.find(
        (v) => v.width === width && v.height === height
      );
      currentTier = tier?.name ?? "unknown";

      if (opts.failAll || opts.failViewport === currentTier) {
        return { ok: false, error: `stub: refused ${currentTier}` };
      }
      return { ok: true };
    },
    async snapshot() {
      calls.push({ method: "snapshot" });
      if (opts.failAll || opts.failSnapshot === currentTier) {
        return { ok: false, error: `stub: snapshot fail ${currentTier}` };
      }
      return {
        ok: true,
        pngBuffer: tinyPng,
        width: lastWidth,
        height: lastHeight,
      };
    },
  };

  return { bridge, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTmpDir(
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "claude-eyes-mv-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("F5 E-1: captureMultiViewport — happy path", () => {
  it("walks 3 viewports sequentially: mobile → tablet → desktop", async () => {
    await withTmpDir(async (dir) => {
      const { bridge, calls } = makeStubBridge();
      const out = await captureMultiViewport({
        bridge,
        eyesDir: dir,
        repoRoot: dir,
        seq: 1,
        capturedAt: "2026-06-02T12:00:00.000Z",
      });

      // 3 viewports × (set_viewport + snapshot) = 6 calls, in exact order.
      assert.equal(calls.length, 6, `expected 6 calls, got ${calls.length}`);
      assert.deepEqual(
        calls[0],
        { method: "set_viewport", width: 375, height: 812 },
        "first set_viewport must be mobile"
      );
      assert.deepEqual(calls[1], { method: "snapshot" });
      assert.deepEqual(
        calls[2],
        { method: "set_viewport", width: 768, height: 1024 },
        "second set_viewport must be tablet"
      );
      assert.deepEqual(calls[3], { method: "snapshot" });
      assert.deepEqual(
        calls[4],
        { method: "set_viewport", width: 1280, height: 800 },
        "third set_viewport must be desktop"
      );
      assert.deepEqual(calls[5], { method: "snapshot" });

      // viewports[] reflects all 3 successful captures.
      assert.equal(out.viewports.length, 3);
      assert.equal(out.viewports[0]?.name, "mobile");
      assert.equal(out.viewports[1]?.name, "tablet");
      assert.equal(out.viewports[2]?.name, "desktop");
      assert.equal(out.viewports[0]?.error, null);
      assert.equal(out.viewports[1]?.error, null);
      assert.equal(out.viewports[2]?.error, null);

      // Each viewport wrote a PNG + JSON to disk with the tier suffix.
      for (const v of out.viewports) {
        assert.ok(
          v.pngPath.endsWith(`.${v.name}.png`),
          `pngPath should end with .${v.name}.png — got ${v.pngPath}`
        );
        assert.ok(
          v.jsonPath.endsWith(`.${v.name}.json`),
          `jsonPath should end with .${v.name}.json — got ${v.jsonPath}`
        );
        const pngStat = await fsp.stat(v.pngPath);
        assert.ok(pngStat.size > 0, `viewport ${v.name} PNG empty`);
        const sidecar = JSON.parse(await fsp.readFile(v.jsonPath, "utf8")) as {
          viewport: string;
          width: number;
          height: number;
        };
        assert.equal(sidecar.viewport, v.name);
        assert.equal(sidecar.width, v.width);
        assert.equal(sidecar.height, v.height);
      }

      // Primary buffer = desktop tier.
      assert.ok(out.pngBuffer.length > 0, "primary buffer must be non-empty");
      assert.equal(out.width, 1280);
      assert.equal(out.height, 800);
      assert.equal(out.error, null);
    });
  });
});

describe("F5 E-1: captureMultiViewport — partial failure", () => {
  it("records error on the failing tier but keeps the rest", async () => {
    await withTmpDir(async (dir) => {
      const { bridge, calls } = makeStubBridge({ failSnapshot: "tablet" });
      const out = await captureMultiViewport({
        bridge,
        eyesDir: dir,
        repoRoot: dir,
        seq: 7,
        capturedAt: "2026-06-02T12:01:00.000Z",
      });

      // All 6 calls still issued (we don't abort the loop on per-tier failures).
      assert.equal(calls.length, 6);

      assert.equal(out.viewports.length, 3);
      assert.equal(out.viewports[0]?.error, null, "mobile should succeed");
      assert.ok(
        out.viewports[1]?.error?.includes("snapshot(tablet)"),
        `tablet error should mention snapshot: ${out.viewports[1]?.error}`
      );
      assert.equal(out.viewports[2]?.error, null, "desktop should succeed");

      // Aggregate error includes the tablet failure.
      assert.ok(out.error !== null);
      assert.ok(out.error.includes("tablet"));

      // Primary buffer should still come from desktop (preferred even when
      // an earlier tier failed).
      assert.ok(out.pngBuffer.length > 0);
      assert.equal(out.width, 1280);
      assert.equal(out.height, 800);
    });
  });

  it("first-success fallback when desktop fails", async () => {
    await withTmpDir(async (dir) => {
      const { bridge } = makeStubBridge({ failViewport: "desktop" });
      const out = await captureMultiViewport({
        bridge,
        eyesDir: dir,
        repoRoot: dir,
        seq: 8,
        capturedAt: "2026-06-02T12:02:00.000Z",
      });

      // Desktop set_viewport failed, so primary falls back to first success
      // (mobile, since the stub registers it as the first success).
      assert.equal(out.viewports[2]?.name, "desktop");
      assert.ok(out.viewports[2]?.error?.includes("set_viewport(desktop)"));
      assert.ok(out.pngBuffer.length > 0, "primary should fall back to mobile");
      assert.equal(out.width, 375, "primary width should fall back to mobile");
      assert.equal(out.height, 812, "primary height should fall back to mobile");
    });
  });
});

describe("F5 E-1: captureMultiViewport — total failure", () => {
  it("returns empty buffer + non-null aggregate error", async () => {
    await withTmpDir(async (dir) => {
      const { bridge } = makeStubBridge({ failAll: true });
      const out = await captureMultiViewport({
        bridge,
        eyesDir: dir,
        repoRoot: dir,
        seq: 9,
        capturedAt: "2026-06-02T12:03:00.000Z",
      });

      assert.equal(out.pngBuffer.length, 0);
      assert.equal(out.width, 0);
      assert.equal(out.height, 0);
      assert.ok(out.error !== null);
      // All 3 viewports recorded, each with an error.
      assert.equal(out.viewports.length, 3);
      for (const v of out.viewports) {
        assert.ok(v.error !== null, `viewport ${v.name} should have error`);
      }
    });
  });
});
