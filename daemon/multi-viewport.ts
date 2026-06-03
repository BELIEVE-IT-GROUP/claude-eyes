/**
 * daemon/multi-viewport.ts — F5 E-1 viewport-walking helper.
 *
 * When the cmux bridge is active (CLAUDE_EYES_FORK=true) the daemon takes
 * three sequential snapshots of the same WKWebView at distinct CSS viewport
 * sizes: mobile (375×812), tablet (768×1024), desktop (1280×800).
 *
 * This module is isolated from daemon/index.ts so unit tests can import it
 * without triggering the daemon's top-level `main()`.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  ViewportCapture,
  ViewportName,
} from "@contracts/index.js";
import { frameStem } from "./storage.js";

/**
 * Three logical viewport tiers walked on the same WKWebView when the bridge
 * is active. Order is small → large so the primary `width/height` produced
 * by the surrounding daemon ends on the desktop tier.
 */
export const VIEWPORT_PROFILES: ReadonlyArray<{
  name: ViewportName;
  width: number;
  height: number;
}> = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * Minimal interface the multi-viewport routine needs from the bridge.
 * Real callers pass a BridgeClient; tests pass a stub.
 */
export interface ViewportCaptureBridge {
  setViewport(
    width: number,
    height: number
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  snapshot(): Promise<
    | { ok: true; pngBuffer: Buffer; width: number; height: number }
    | { ok: false; error: string }
  >;
}

export interface CaptureMultiViewportResult {
  /** Primary PNG buffer: desktop tier if successful, else first-success tier. */
  pngBuffer: Buffer;
  /** Primary width matching `pngBuffer`. */
  width: number;
  /** Primary height matching `pngBuffer`. */
  height: number;
  /** Per-viewport captures, always 3 entries (one per VIEWPORT_PROFILES). */
  viewports: ViewportCapture[];
  /** Concatenated error string if any tier failed; null when all succeeded. */
  error: string | null;
}

/**
 * Walk the 3 viewport profiles sequentially (set_viewport + snapshot per tier),
 * writing each PNG + sidecar JSON to disk. Single-viewport failures are
 * recorded in that viewport's `error` field without aborting the cycle.
 */
export async function captureMultiViewport(opts: {
  bridge: ViewportCaptureBridge;
  eyesDir: string;
  repoRoot: string;
  seq: number;
  capturedAt: string;
}): Promise<CaptureMultiViewportResult> {
  const { bridge, eyesDir, repoRoot, seq, capturedAt } = opts;
  const stem = frameStem(capturedAt, seq);

  const viewports: ViewportCapture[] = [];
  let aggregateError: string | null = null;
  let primaryBuffer: Buffer | null = null;
  let primaryWidth = 0;
  let primaryHeight = 0;

  await fsp.mkdir(eyesDir, { recursive: true });

  for (const profile of VIEWPORT_PROFILES) {
    const pngPath = path.join(eyesDir, `${stem}.${profile.name}.png`);
    const jsonPath = path.join(eyesDir, `${stem}.${profile.name}.json`);
    const pngRelative = path.relative(repoRoot, pngPath);

    // 1) set_viewport — sequential per spec (same WKWebView, no reload).
    const sv = await bridge.setViewport(profile.width, profile.height);
    if (!sv.ok) {
      const err = `set_viewport(${profile.name}): ${sv.error}`;
      aggregateError =
        aggregateError === null ? err : `${aggregateError}; ${err}`;
      viewports.push({
        name: profile.name,
        width: profile.width,
        height: profile.height,
        pngPath,
        pngRelative,
        jsonPath,
        error: err,
      });
      continue;
    }

    // 2) snapshot.
    const shot = await bridge.snapshot();
    if (!shot.ok) {
      const err = `snapshot(${profile.name}): ${shot.error}`;
      aggregateError =
        aggregateError === null ? err : `${aggregateError}; ${err}`;
      viewports.push({
        name: profile.name,
        width: profile.width,
        height: profile.height,
        pngPath,
        pngRelative,
        jsonPath,
        error: err,
      });
      continue;
    }

    // 3) write the PNG + small sidecar JSON for this viewport.
    await fsp.writeFile(pngPath, shot.pngBuffer);
    await fsp.writeFile(
      jsonPath,
      JSON.stringify(
        {
          seq,
          capturedAt,
          viewport: profile.name,
          width: profile.width,
          height: profile.height,
          actualWidth: shot.width,
          actualHeight: shot.height,
          pngPath,
        },
        null,
        2
      )
    );

    viewports.push({
      name: profile.name,
      width: profile.width,
      height: profile.height,
      pngPath,
      pngRelative,
      jsonPath,
      error: null,
    });

    // Prefer desktop as the primary; otherwise the first successful tier.
    if (primaryBuffer === null || profile.name === "desktop") {
      primaryBuffer = shot.pngBuffer;
      primaryWidth = shot.width || profile.width;
      primaryHeight = shot.height || profile.height;
    }
  }

  if (primaryBuffer === null) {
    return {
      pngBuffer: Buffer.alloc(0),
      width: 0,
      height: 0,
      viewports,
      error: aggregateError ?? "all viewports failed",
    };
  }

  return {
    pngBuffer: primaryBuffer,
    width: primaryWidth,
    height: primaryHeight,
    viewports,
    error: aggregateError,
  };
}
