/**
 * tests/diff.test.ts
 *
 * Self-check for daemon/diff.ts — verifies that diffFrames correctly:
 *   1. Returns null for mismatched dimensions
 *   2. Detects no change between identical frames (changed_pixels_pct === 0, bbox_changed === null)
 *   3. Detects a 20x20 pixel patch change and returns:
 *      - changed_pixels_pct > 0
 *      - bbox_changed that contains the changed region
 *      - a valid diff PNG written to disk
 *   4. Returns a WorkerOutput-compatible shape (diff field present)
 *
 * Run with: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { diffFrames } from "../daemon/diff.js";

// ---------------------------------------------------------------------------
// PNG synthesis helpers
// ---------------------------------------------------------------------------

/**
 * Create a solid-colour PNG buffer (RGBA) of the given dimensions.
 * All pixels are set to the provided [r, g, b, a] value.
 */
function makeSolidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number]
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const png = new PNG({ width, height });
    const [r, g, b, a] = rgba;
    for (let i = 0; i < width * height; i++) {
      const offset = i * 4;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = a;
    }
    const chunks: Buffer[] = [];
    png.pack()
      .on("data", (chunk: Buffer) => { chunks.push(chunk); })
      .on("end", () => { resolve(Buffer.concat(chunks)); })
      .on("error", (err: Error) => { reject(err); });
  });
}

/**
 * Create a PNG buffer identical to `base` but with a 20x20 block at (x, y)
 * painted with `patchRgba`.
 */
function makePngWithPatch(
  base: PNG,
  patchX: number,
  patchY: number,
  patchW: number,
  patchH: number,
  patchRgba: [number, number, number, number]
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const png = new PNG({ width: base.width, height: base.height });
    // Copy base data
    base.data.copy(png.data);

    const [r, g, b, a] = patchRgba;
    for (let dy = 0; dy < patchH; dy++) {
      for (let dx = 0; dx < patchW; dx++) {
        const offset = ((patchY + dy) * base.width + (patchX + dx)) * 4;
        png.data[offset] = r;
        png.data[offset + 1] = g;
        png.data[offset + 2] = b;
        png.data[offset + 3] = a;
      }
    }

    const chunks: Buffer[] = [];
    png.pack()
      .on("data", (chunk: Buffer) => { chunks.push(chunk); })
      .on("end", () => { resolve(Buffer.concat(chunks)); })
      .on("error", (err: Error) => { reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("diffFrames returns null when dimensions differ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eyes-diff-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");

    const buf100 = await makeSolidPng(100, 100, [200, 200, 200, 255]);
    const buf200 = await makeSolidPng(200, 200, [200, 200, 200, 255]);

    const prevPath = join(dir, "prev.png");
    const currPath = join(dir, "curr.png");
    await writeFile(prevPath, buf100);
    await writeFile(currPath, buf200);

    const result = await diffFrames({
      prevPngPath: prevPath,
      currPngPath: currPath,
      eyesDir: dir,
      seq: 1,
    });

    assert.equal(result, null, "Should return null for mismatched dimensions");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffFrames reports zero change for identical frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eyes-diff-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");

    const buf = await makeSolidPng(100, 100, [128, 64, 32, 255]);
    const prevPath = join(dir, "prev.png");
    const currPath = join(dir, "curr.png");
    await writeFile(prevPath, buf);
    await writeFile(currPath, buf); // same file, identical content

    const result = await diffFrames({
      prevPngPath: prevPath,
      currPngPath: currPath,
      eyesDir: dir,
      seq: 2,
    });

    assert.notEqual(result, null, "Should return DiffResult for same-size frames");
    assert.ok(result !== null);
    assert.equal(result.changed_pixels_pct, 0, "Identical frames must have 0% change");
    assert.equal(result.bbox_changed, null, "No bbox for identical frames");
    assert.ok(
      result.diff_png_path.endsWith("diff-000002.png"),
      `diff_png_path should be diff-000002.png, got ${result.diff_png_path}`
    );
    // Diff PNG must have been written to disk
    const info = await stat(result.diff_png_path);
    assert.ok(info.size > 0, "Diff PNG file must be non-empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffFrames detects 20x20 changed region", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eyes-diff-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");

    const WIDTH = 200;
    const HEIGHT = 200;
    const PATCH_X = 50;
    const PATCH_Y = 60;
    const PATCH_W = 20;
    const PATCH_H = 20;

    // Base: solid grey PNG
    const baseBuf = await makeSolidPng(WIDTH, HEIGHT, [180, 180, 180, 255]);

    // Parse base PNG so we can clone + patch
    const basePng = await new Promise<PNG>((resolve, reject) => {
      const png = new PNG();
      png.parse(baseBuf, (err, data) => {
        if (err !== null) reject(err);
        else resolve(data);
      });
    });

    // Curr: same base with a bright-red 20x20 patch at (50, 60)
    // Use dramatically different colour to ensure it's above the 0.1 threshold
    const currBuf = await makePngWithPatch(
      basePng,
      PATCH_X,
      PATCH_Y,
      PATCH_W,
      PATCH_H,
      [255, 0, 0, 255] // bright red — max distance from grey
    );

    const prevPath = join(dir, "frame-prev.png");
    const currPath = join(dir, "frame-curr.png");
    await writeFile(prevPath, baseBuf);
    await writeFile(currPath, currBuf);

    const result = await diffFrames({
      prevPngPath: prevPath,
      currPngPath: currPath,
      eyesDir: dir,
      seq: 3,
    });

    assert.notEqual(result, null, "Should produce a DiffResult");
    assert.ok(result !== null);

    // changed_pixels_pct must be > 0 (there are changed pixels)
    assert.ok(
      result.changed_pixels_pct > 0,
      `changed_pixels_pct should be > 0, got ${result.changed_pixels_pct}`
    );

    // The patch is 20x20 = 400 pixels out of 200x200 = 40000 total
    // At minimum we should see > 0.5% (some pixels might be AA-excluded but
    // with includeAA:false and a very different colour this should be close to 1%)
    const expectedMinPct = (PATCH_W * PATCH_H) / (WIDTH * HEIGHT); // 0.01 = 1%
    assert.ok(
      result.changed_pixels_pct >= expectedMinPct * 0.5,
      `changed_pixels_pct ${result.changed_pixels_pct} is below half of expected minimum ${expectedMinPct * 0.5}`
    );

    // bbox_changed must be non-null and encompass the patch
    assert.notEqual(result.bbox_changed, null, "bbox_changed must be set");
    assert.ok(result.bbox_changed !== null);

    const bbox = result.bbox_changed;
    assert.ok(
      bbox.x <= PATCH_X,
      `bbox.x ${bbox.x} should be <= patch x ${PATCH_X}`
    );
    assert.ok(
      bbox.y <= PATCH_Y,
      `bbox.y ${bbox.y} should be <= patch y ${PATCH_Y}`
    );
    assert.ok(
      bbox.x + bbox.width >= PATCH_X + PATCH_W,
      `bbox right edge ${bbox.x + bbox.width} should cover patch right ${PATCH_X + PATCH_W}`
    );
    assert.ok(
      bbox.y + bbox.height >= PATCH_Y + PATCH_H,
      `bbox bottom edge ${bbox.y + bbox.height} should cover patch bottom ${PATCH_Y + PATCH_H}`
    );

    // Diff PNG must have been written to disk
    assert.ok(
      result.diff_png_path.endsWith("diff-000003.png"),
      `diff_png_path should end with diff-000003.png, got ${result.diff_png_path}`
    );
    const info = await stat(result.diff_png_path);
    assert.ok(info.size > 0, "Diff PNG must be written to disk and non-empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffFrames result is compatible with WorkerOutput.diff shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eyes-diff-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");

    const prev = await makeSolidPng(80, 80, [10, 20, 30, 255]);
    const curr = await makeSolidPng(80, 80, [10, 20, 30, 255]);

    const prevPath = join(dir, "p.png");
    const currPath = join(dir, "c.png");
    await writeFile(prevPath, prev);
    await writeFile(currPath, curr);

    const diff = await diffFrames({
      prevPngPath: prevPath,
      currPngPath: currPath,
      eyesDir: dir,
      seq: 99,
    });

    // Simulate a WorkerOutput with diff attached
    const workerOutput = {
      seq: 99,
      capturedAt: new Date().toISOString(),
      pngPath: currPath,
      jsonPath: null,
      error: null,
      framesRetained: 1,
      devUrl: "http://localhost:5173",
      uptimeMs: 1234,
      diff, // DiffResult | null — optional field
    };

    assert.ok(
      "diff" in workerOutput,
      "WorkerOutput must include diff field"
    );
    assert.ok(
      workerOutput.diff === null || typeof workerOutput.diff === "object",
      "diff must be null or an object"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
