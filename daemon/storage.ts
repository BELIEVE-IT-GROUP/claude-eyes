/**
 * daemon/storage.ts — frame persistence helpers.
 *
 * Writes EyeFrame JSON + PNG pairs into eyesDir, maintains last.json / last.png
 * symlinks (replaced atomically), and garbage-collects old frames.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { EyeFrame } from "@contracts/index.js";

// ---------------------------------------------------------------------------
// Frame writer
// ---------------------------------------------------------------------------

/**
 * Compute the filesystem stem used for a frame's PNG + JSON files.
 * Exported so callers (e.g. external-tabs capture) can share the prefix.
 */
export function frameStem(capturedAt: string, seq: number): string {
  const ts = new Date(capturedAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return `${ts}-${String(seq).padStart(6, "0")}`;
}

/**
 * Write a captured frame to disk.
 * - Creates `<eyesDir>/<timestamp>-<seq>.png` and `<timestamp>-<seq>.json`
 * - Atomically replaces `<eyesDir>/last.png` and `<eyesDir>/last.json`
 * - Runs GC to keep at most `gcKeep` frames.
 */
export async function writeFrame(opts: {
  eyesDir: string;
  repoRoot: string;
  seq: number;
  pngBuffer: Buffer;
  frame: Omit<EyeFrame, "pngPath" | "pngRelative" | "jsonPath">;
  gcKeep: number;
}): Promise<EyeFrame> {
  const { eyesDir, repoRoot, seq, pngBuffer, frame, gcKeep } = opts;

  // Ensure output directory exists
  await fsp.mkdir(eyesDir, { recursive: true });

  const stem = frameStem(frame.capturedAt, seq);

  const pngPath = path.join(eyesDir, `${stem}.png`);
  const jsonPath = path.join(eyesDir, `${stem}.json`);
  const pngRelative = path.relative(repoRoot, pngPath);

  const eyeFrame: EyeFrame = {
    ...frame,
    seq,
    pngPath,
    pngRelative,
    jsonPath,
  };

  // Write PNG
  await fsp.writeFile(pngPath, pngBuffer);
  // Write JSON metadata
  await fsp.writeFile(jsonPath, JSON.stringify(eyeFrame, null, 2));

  // Atomic symlink replacement for last.png and last.json
  await replaceSymlink(pngPath, path.join(eyesDir, "last.png"));
  await replaceSymlink(jsonPath, path.join(eyesDir, "last.json"));

  // Garbage-collect old frames
  await gcFrames(eyesDir, gcKeep);

  return eyeFrame;
}

// ---------------------------------------------------------------------------
// Symlink helpers
// ---------------------------------------------------------------------------

/**
 * Replace `linkPath` to point to `targetPath`.
 * Uses a tmp-rename pattern for atomicity on macOS.
 */
async function replaceSymlink(targetPath: string, linkPath: string): Promise<void> {
  const tmpLink = `${linkPath}.tmp.${process.pid}`;
  // Remove stale tmp if it exists
  try {
    await fsp.unlink(tmpLink);
  } catch {
    /* ignore */
  }
  await fsp.symlink(targetPath, tmpLink);
  await fsp.rename(tmpLink, linkPath);
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Remove the oldest PNG + JSON pairs from eyesDir, keeping at most `keep` frames.
 * "last.png" and "last.json" are symlinks and are never deleted here.
 */
export async function gcFrames(eyesDir: string, keep: number): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(eyesDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Collect all timestamped PNGs (not the symlinks)
  const pngs = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".png") &&
        e.name !== "last.png"
    )
    .map((e) => e.name)
    .sort(); // ISO timestamp prefix sorts chronologically

  const excess = pngs.length - keep;
  if (excess <= 0) return;

  const toDelete = pngs.slice(0, excess);
  await Promise.all(
    toDelete.flatMap((png) => {
      const stem = png.slice(0, -4); // remove .png
      const pngFile = path.join(eyesDir, png);
      const jsonFile = path.join(eyesDir, `${stem}.json`);
      return [
        fsp.unlink(pngFile).catch(() => { /* already gone */ }),
        fsp.unlink(jsonFile).catch(() => { /* already gone */ }),
      ];
    })
  );
}

// ---------------------------------------------------------------------------
// Reader: count retained frames
// ---------------------------------------------------------------------------

/** Count how many timestamped PNG frames currently exist in eyesDir. */
export async function countFrames(eyesDir: string): Promise<number> {
  try {
    const entries = await fsp.readdir(eyesDir, { withFileTypes: true });
    return entries.filter(
      (e) => e.isFile() && e.name.endsWith(".png") && e.name !== "last.png"
    ).length;
  } catch {
    return 0;
  }
}

/** Read the last.json symlink target content, or null if none. */
export async function readLastFrame(eyesDir: string): Promise<EyeFrame | null> {
  const lastJson = path.join(eyesDir, "last.json");
  try {
    const raw = await fsp.readFile(lastJson, "utf8");
    return JSON.parse(raw) as EyeFrame;
  } catch {
    return null;
  }
}
