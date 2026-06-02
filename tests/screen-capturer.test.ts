/**
 * tests/screen-capturer.test.ts
 *
 * Exercises bridge/screen-capturer.ts against a known geometry on the
 * primary display. We don't assert pixel content — just that the pipeline
 * (rect → screencapture → PNG → metadata) completes in under 2s and the
 * resulting PNG is well-formed.
 *
 * If `screencapture` is not authorized for Screen Recording, the test will
 * still pass the file existence check but produce a black PNG. We don't
 * fail for that — TCC is a system-level concern.
 *
 * Run with: `npm test` (or `node --test --import tsx tests/*.test.ts`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { capture, CaptureError, type Rect } from "../bridge/screen-capturer.js";

/**
 * Detect whether the current process actually has Screen Recording TCC
 * permission. macOS only grants this to apps the user has approved in
 * System Settings → Privacy & Security → Screen Recording. CI/sandbox
 * runs almost always lack it, in which case `screencapture` exits 1 with
 * "could not create image from rect" regardless of the rect.
 */
function hasScreenRecordingPermission(): boolean {
  try {
    const out = execFileSync(
      "/usr/sbin/screencapture",
      ["-x", "-t", "png", "-R", "0,0,2,2", "/tmp/.cap-tcc-probe.png"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    void out;
    return true;
  } catch {
    return false;
  }
}

const TCC_OK = hasScreenRecordingPermission();
const SKIP_REASON = "Screen Recording TCC permission unavailable in this environment";

test("capture(rect) succeeds within 2s budget and returns valid PNG metadata", { skip: !TCC_OK && SKIP_REASON }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-eyes-test-"));
  try {
    const rect: Rect = { x: 0, y: 0, width: 320, height: 200 };
    const t0 = Date.now();
    const res = await capture({
      rect,
      outDir: dir,
      filename: "rect-320x200.png",
      timeoutMs: 2000,
    });
    const elapsed = Date.now() - t0;

    assert.ok(res.png_path.endsWith("rect-320x200.png"), "png_path filename");
    assert.equal(res.source, "rect", "source should be 'rect'");
    assert.ok(res.bytes > 0, "PNG must be non-empty");
    assert.ok(res.width > 0 && res.height > 0, "PNG must have dimensions");
    // Allow the OS to map the rect at 1x or 2x (Retina): width should be a
    // multiple of the rect width within the standard scaling factors.
    assert.ok(
      [rect.width, rect.width * 2, rect.width * 3].includes(res.width),
      `unexpected width ${res.width}`,
    );
    assert.match(res.sha256, /^[0-9a-f]{64}$/, "sha256 hex");
    assert.ok(res.durationMs < 2000, `durationMs ${res.durationMs} >= 2000`);
    assert.ok(elapsed < 2500, `wall-clock ${elapsed}ms exceeded test budget`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture() rejects invalid rect (zero size)", async () => {
  await assert.rejects(
    () => capture({ rect: { x: 0, y: 0, width: 0, height: 100 } }),
    (err) => err instanceof CaptureError && /invalid rect size/.test(err.message),
  );
});

test("capture() rejects absurd rect (too large)", async () => {
  await assert.rejects(
    () => capture({ rect: { x: 0, y: 0, width: 99999, height: 100 } }),
    (err) => err instanceof CaptureError && /exceeds 16384/.test(err.message),
  );
});

test("capture() prefers explicit rect over getGeometry()", { skip: !TCC_OK && SKIP_REASON }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-eyes-test-"));
  try {
    let geomCalled = false;
    const res = await capture({
      rect: { x: 0, y: 0, width: 100, height: 100 },
      getGeometry: async () => {
        geomCalled = true;
        return { x: 0, y: 0, width: 50, height: 50 };
      },
      outDir: dir,
      timeoutMs: 2000,
    });
    assert.equal(geomCalled, false, "getGeometry must not be called when rect supplied");
    assert.equal(res.source, "rect");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture() uses bridge getGeometry when no rect supplied", { skip: !TCC_OK && SKIP_REASON }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-eyes-test-"));
  try {
    const res = await capture({
      getGeometry: async () => ({ x: 0, y: 0, width: 100, height: 100 }),
      outDir: dir,
      timeoutMs: 2000,
    });
    assert.equal(res.source, "bridge");
    assert.equal(res.rect.width, 100);
    assert.equal(res.rect.height, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
