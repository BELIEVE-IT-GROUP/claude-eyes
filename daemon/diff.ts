/**
 * daemon/diff.ts — pixel-level frame diff using pixelmatch + pngjs.
 *
 * Compares two PNG files representing consecutive viewport captures and
 * produces:
 *   - A diff visualisation PNG written to eyesDir
 *   - A changed_pixels_pct fraction in [0, 1]
 *   - A bbox_changed bounding box (or null when nothing changed)
 *
 * Configuration:
 *   threshold : 0.1  — per-pixel colour distance threshold (pixelmatch default)
 *   includeAA : false — anti-aliased pixels are not counted as differences
 *
 * Returned as DiffResult (see contracts/types.ts).
 * Returns null when the two frames have different dimensions and cannot be
 * compared, or when either PNG cannot be decoded.
 *
 * Usage:
 *   import { diffFrames } from "./diff.js";
 *   const result = await diffFrames({ prevPngPath, currPngPath, eyesDir, seq });
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { DiffResult, BboxChanged } from "@contracts/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffFramesOpts {
  /** Absolute path to the previous frame PNG. */
  prevPngPath: string;
  /** Absolute path to the current frame PNG. */
  currPngPath: string;
  /** Directory where the diff PNG will be written. */
  eyesDir: string;
  /**
   * Sequence number of the *current* frame — used to name the output file
   * so it sorts alongside the regular frame files.
   */
  seq: number;
}

// ---------------------------------------------------------------------------
// PNG decode helpers
// ---------------------------------------------------------------------------

/**
 * Decode a PNG file from disk into a pngjs PNG instance.
 * Rejects with a descriptive error if the file is missing or corrupted.
 */
async function decodePng(filePath: string): Promise<PNG> {
  const buf = await fsp.readFile(filePath);
  return new Promise<PNG>((resolve, reject) => {
    const png = new PNG();
    png.parse(buf, (err, data) => {
      if (err !== null) {
        reject(new Error(`Failed to decode PNG at ${filePath}: ${err.message}`));
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * Encode a pngjs PNG instance to a Buffer.
 */
function encodePng(png: PNG): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    png.pack()
      .on("data", (chunk: Buffer) => { chunks.push(chunk); })
      .on("end", () => { resolve(Buffer.concat(chunks)); })
      .on("error", (err: Error) => { reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Bounding box computation
// ---------------------------------------------------------------------------

/**
 * Walk the diff pixel data (one byte per channel, RGBA, width*height*4 bytes)
 * and return the axis-aligned bounding box of all non-zero pixels, or null
 * when no pixels differ.
 *
 * A pixel is considered "changed" when any of its RGBA channels is non-zero
 * in the diff image.
 */
function computeBbox(
  diffData: Buffer,
  width: number,
  height: number
): BboxChanged | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Check all four channels; diff image uses red for changed pixels
      const r = diffData[offset];
      const g = diffData[offset + 1];
      const b = diffData[offset + 2];
      const a = diffData[offset + 3];
      if (
        (r !== undefined && r !== 0) ||
        (g !== undefined && g !== 0) ||
        (b !== undefined && b !== 0) ||
        (a !== undefined && a !== 0)
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) {
    // No changed pixels found
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

// ---------------------------------------------------------------------------
// Core diff function
// ---------------------------------------------------------------------------

/**
 * Compute a pixel-level diff between two PNG frames.
 *
 * Returns a DiffResult on success, or null when:
 * - Either file cannot be read/decoded
 * - The two images have different dimensions (cannot be meaningfully compared)
 *
 * The diff PNG is written to `<eyesDir>/diff-<seq>.png`.
 *
 * @example
 * const result = await diffFrames({
 *   prevPngPath: "/tmp/eyes/frame-001.png",
 *   currPngPath: "/tmp/eyes/frame-002.png",
 *   eyesDir: "/tmp/eyes",
 *   seq: 2,
 * });
 * // result.changed_pixels_pct  → 0.0031 (0.31% of pixels changed)
 * // result.bbox_changed         → { x: 10, y: 20, width: 30, height: 40 }
 * // result.diff_png_path        → "/tmp/eyes/diff-000002.png"
 */
export async function diffFrames(
  opts: DiffFramesOpts
): Promise<DiffResult | null> {
  const { prevPngPath, currPngPath, eyesDir, seq } = opts;

  // Decode both PNGs in parallel
  let prev: PNG;
  let curr: PNG;
  try {
    [prev, curr] = await Promise.all([
      decodePng(prevPngPath),
      decodePng(currPngPath),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-eyes/diff] decode error — skipping diff: ${msg}`);
    return null;
  }

  // Dimension guard — pixelmatch requires identical sizes
  if (prev.width !== curr.width || prev.height !== curr.height) {
    console.warn(
      `[claude-eyes/diff] dimension mismatch ` +
        `(${prev.width}x${prev.height} vs ${curr.width}x${curr.height}) — skipping diff`
    );
    return null;
  }

  const { width, height } = prev;
  const totalPixels = width * height;

  // Allocate output buffer for the visual diff image (red diff-colour overlay on gray bg)
  const diffPng = new PNG({ width, height });

  // Run pixelmatch — produces visual diff PNG; returns count of changed pixels
  const changedPixels = pixelmatch(
    prev.data,
    curr.data,
    diffPng.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: false,
    }
  );

  const changed_pixels_pct =
    totalPixels === 0 ? 0 : changedPixels / totalPixels;

  // Compute bounding box of changed pixels.
  //
  // IMPORTANT: when changedPixels === 0, pixelmatch still writes grayed-out
  // copies of the original image into diffPng (for visual context), so we
  // cannot use diffPng.data as a mask.  Instead:
  //  - When no pixels changed: bbox is trivially null.
  //  - When pixels changed: run a second pixelmatch pass with diffMask:true
  //    so the output contains ONLY the changed pixel positions (transparent
  //    elsewhere), then derive the bbox from that mask buffer.
  let bbox_changed: BboxChanged | null = null;
  if (changedPixels > 0) {
    const maskPng = new PNG({ width, height });
    pixelmatch(prev.data, curr.data, maskPng.data, width, height, {
      threshold: 0.1,
      includeAA: false,
      diffMask: true,
    });
    bbox_changed = computeBbox(maskPng.data as unknown as Buffer, width, height);
  }

  // Write visual diff PNG to disk
  await fsp.mkdir(eyesDir, { recursive: true });
  const diffPngPath = path.join(
    eyesDir,
    `diff-${String(seq).padStart(6, "0")}.png`
  );
  const diffBuf = await encodePng(diffPng);
  await fsp.writeFile(diffPngPath, diffBuf);

  return {
    diff_png_path: diffPngPath,
    changed_pixels_pct,
    bbox_changed,
  };
}
