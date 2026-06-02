/**
 * daemon/screencapturer.ts — adapter around bridge/screen-capturer.ts.
 *
 * Provides a uniform interface for the daemon to call:
 *   - ScreenCapturer.capture() uses `screencapture(1)` via bridge/screen-capturer.ts
 *   - The ScreenCapturer also exposes probeDevServer for HTTP status checks.
 *
 * Separation rationale: the daemon owns the "what URL to probe" and "where to
 * write frames" concerns; bridge/screen-capturer.ts owns "how to take a
 * screenshot with macOS's screencapture".
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import { capture as captureRect, type Rect } from "../bridge/screen-capturer.js";
import type { BridgeSnapshotResult } from "@contracts/index.js";

export { type Rect };

/** Result of a dev-server HTTP probe. */
export interface ProbeResult {
  reachable: boolean;
  status: number | null;
  /** Latency in ms, null if not reached. */
  latencyMs: number | null;
}

/**
 * Probe the dev server and return status without a full capture.
 * Uses a 5-second timeout.
 */
export async function probeDevServer(devUrl: string): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let parsed: URL;
    try {
      parsed = new URL(devUrl);
    } catch {
      settle({ reachable: false, status: null, latencyMs: null });
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      devUrl,
      { method: "HEAD", timeout: 5000 },
      (res) => {
        settle({
          reachable: true,
          status: res.statusCode ?? null,
          latencyMs: Date.now() - start,
        });
        res.resume();
      }
    );

    req.on("timeout", () => {
      req.destroy();
      settle({ reachable: false, status: null, latencyMs: null });
    });

    req.on("error", () => {
      settle({ reachable: false, status: null, latencyMs: null });
    });

    req.end();
  });
}

/**
 * ScreenCapturer — captures a rectangle of the macOS desktop that corresponds
 * to the cmux embedded browser surface.
 *
 * Delegates to bridge/screen-capturer.ts (`capture()`) with a bridge geometry
 * resolver or rect override. When the bridge is unavailable and no rect is
 * supplied it falls back to the Accessibility API query built into
 * bridge/screen-capturer.ts.
 */
/**
 * Parse CLAUDE_EYES_RECT="x,y,w,h" from env.
 * Returns null if the env var is absent or malformed.
 */
function parseRectEnv(): Rect | null {
  const raw = process.env["CLAUDE_EYES_RECT"];
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export class ScreenCapturer {
  private readonly devUrl: string;
  private readonly eyesDir: string;
  /** Geometry resolver injected by the daemon for the FORK=true path. */
  private readonly getGeometry?: () => Promise<Rect | null>;

  constructor(opts: {
    devUrl: string;
    eyesDir: string;
    getGeometry?: () => Promise<Rect | null>;
  }) {
    this.devUrl = opts.devUrl;
    this.eyesDir = opts.eyesDir;
    // If CLAUDE_EYES_RECT is set, wire it as the geometry source so the
    // accessibility fallback (which requires a running cmux app) is bypassed.
    const envRect = parseRectEnv();
    if (envRect !== null && opts.getGeometry === undefined) {
      const r = envRect;
      this.getGeometry = async (): Promise<Rect | null> => r;
    } else {
      this.getGeometry = opts.getGeometry;
    }
  }

  /**
   * Capture a screenshot of the cmux browser surface.
   * Returns a BridgeSnapshotResult so the daemon can treat both paths uniformly.
   * Also returns httpStatus from a parallel dev-server probe.
   */
  async capture(): Promise<BridgeSnapshotResult & { httpStatus: number | null }> {
    // Probe dev server in parallel with screenshot for status metadata
    const probePromise = probeDevServer(this.devUrl);

    try {
      const result = await captureRect({
        getGeometry: this.getGeometry,
        outDir: this.eyesDir,
        filename: `screencap-${Date.now()}.png`,
        timeoutMs: 2000,
      });

      const probe = await probePromise;

      // Read back the PNG from disk
      const { readFile } = await import("node:fs/promises");
      const pngBuffer = await readFile(result.png_path);

      // Clean up the temp file (daemon writes its own versioned copies)
      const { unlink } = await import("node:fs/promises");
      await unlink(result.png_path).catch(() => { /* ignore */ });

      return {
        ok: true,
        pngBuffer,
        width: result.width,
        height: result.height,
        httpStatus: probe.status,
      };
    } catch (err: unknown) {
      const probe = await probePromise.catch(() => ({
        reachable: false,
        status: null,
        latencyMs: null,
      }));
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, httpStatus: probe.status };
    }
  }
}
