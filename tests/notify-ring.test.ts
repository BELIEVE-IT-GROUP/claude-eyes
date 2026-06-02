/**
 * notify-ring.test.ts — verifies the desktop notification ring contract.
 *
 * Run: npm test  (node --test --import tsx ./tests/*.test.ts)
 *
 * These tests are platform-agnostic: cmux is disabled and osascript is
 * disabled so the ring degrades to the stdout transport, which we capture.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import type { EyeFrame } from "../contracts/index.js";
import {
  createNotifyRing,
  renderNotifyBody,
} from "../daemon/notify-ring.js";

function makeFrame(seq: number, overrides: Partial<EyeFrame> = {}): EyeFrame {
  return {
    seq,
    capturedAt: new Date(0).toISOString(),
    pngPath: `/tmp/frame-${seq}.png`,
    pngRelative: `.claude/eyes/frame-${seq}.png`,
    jsonPath: `/tmp/frame-${seq}.json`,
    sourceUrl: "http://localhost:5173/",
    httpStatus: 200,
    width: 1280,
    height: 800,
    captureMethod: "screencapturer",
    error: null,
    viewports: [
      {
        name: "mobile",
        width: 375,
        height: 812,
        pngPath: `/tmp/frame-${seq}-mobile.png`,
        pngRelative: `.claude/eyes/frame-${seq}-mobile.png`,
        jsonPath: `/tmp/frame-${seq}-mobile.json`,
        error: null,
      },
      {
        name: "tablet",
        width: 768,
        height: 1024,
        pngPath: `/tmp/frame-${seq}-tablet.png`,
        pngRelative: `.claude/eyes/frame-${seq}-tablet.png`,
        jsonPath: `/tmp/frame-${seq}-tablet.json`,
        error: null,
      },
      {
        name: "desktop",
        width: 1280,
        height: 800,
        pngPath: `/tmp/frame-${seq}-desktop.png`,
        pngRelative: `.claude/eyes/frame-${seq}-desktop.png`,
        jsonPath: `/tmp/frame-${seq}-desktop.json`,
        error: null,
      },
    ],
    ...overrides,
  };
}

describe("renderNotifyBody", () => {
  it("formats the canonical message with integer diff", () => {
    const body = renderNotifyBody(makeFrame(1), { viewports: 3, diffPercent: 42 });
    assert.equal(body, "👁 frame captured (3 viewports, 42% changed)");
  });

  it("uses 1-decimal precision for sub-10% diffs", () => {
    const body = renderNotifyBody(makeFrame(1), { viewports: 3, diffPercent: 3.4 });
    assert.equal(body, "👁 frame captured (3 viewports, 3.4% changed)");
  });

  it("renders em-dash when diff is unknown", () => {
    const body = renderNotifyBody(makeFrame(1), { viewports: 3, diffPercent: null });
    assert.equal(body, "👁 frame captured (3 viewports, —% changed)");
  });

  it("defaults viewports to 3 when not provided", () => {
    const body = renderNotifyBody(makeFrame(1), { diffPercent: 0 });
    assert.match(body, /3 viewports/);
  });

  it("clamps diff to [0,100] and tolerates Infinity", () => {
    assert.match(
      renderNotifyBody(makeFrame(1), { diffPercent: 999 }),
      /100% changed/,
    );
    assert.match(
      renderNotifyBody(makeFrame(1), { diffPercent: Number.POSITIVE_INFINITY }),
      /—% changed/,
    );
  });

  it("appends truncated error suffix when frame failed", () => {
    const frame = makeFrame(1, { error: "ECONNREFUSED localhost:5173" });
    const body = renderNotifyBody(frame, { viewports: 3, diffPercent: 0 });
    assert.match(body, /err: ECONNREFUSED/);
  });
});

describe("createNotifyRing", () => {
  it("delivers 3 sequential frames via stdout fallback", async () => {
    const ring = createNotifyRing({
      disableCmux: true,
      disableOsascript: true,
    });
    try {
      const r1 = await ring.notify(makeFrame(1), { viewports: 3, diffPercent: 0 });
      const r2 = await ring.notify(makeFrame(2), { viewports: 3, diffPercent: 3.4 });
      const r3 = await ring.notify(makeFrame(3), { viewports: 3, diffPercent: 42 });

      for (const r of [r1, r2, r3]) {
        assert.equal(r.delivered, true, `delivered: ${JSON.stringify(r)}`);
        assert.equal(r.transport, "stdout");
        assert.equal(r.error, null);
        assert.ok(r.elapsedMs < 1500);
      }
      assert.match(r2.body, /3.4% changed/);
    } finally {
      await ring.close();
    }
  });

  it("suppresses duplicate notifications within dedupe window", async () => {
    const ring = createNotifyRing({
      disableCmux: true,
      disableOsascript: true,
    });
    try {
      const frame = makeFrame(7);
      const first = await ring.notify(frame, { viewports: 3, diffPercent: 10 });
      const second = await ring.notify(frame, { viewports: 3, diffPercent: 10 });

      assert.equal(first.delivered, true);
      assert.equal(first.transport, "stdout");
      assert.equal(second.delivered, false);
      assert.equal(second.transport, "none");
      assert.match(second.error ?? "", /suppressed/);
    } finally {
      await ring.close();
    }
  });

  it("forced non-darwin platform skips osascript and lands on stdout", async () => {
    const ring = createNotifyRing({
      disableCmux: true,
      forcePlatform: "linux",
    });
    try {
      const r = await ring.notify(makeFrame(99), { viewports: 3, diffPercent: 50 });
      assert.equal(r.transport, "stdout");
      assert.equal(r.delivered, true);
    } finally {
      await ring.close();
    }
  });
});
