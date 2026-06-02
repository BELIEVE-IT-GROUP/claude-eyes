/**
 * daemon/index.ts — long-lived screenshot + diff worker.
 *
 * Lifecycle:
 *  1. Resolve DaemonConfig from environment.
 *  2. Start chokidar file-watcher (250ms debounce).
 *  3. Run initial capture.
 *  4. Serve HTTP on 127.0.0.1:14242  (GET /healthz, GET /latest, POST /snapshot).
 *  5. On file-change event → capture new frame, write .claude/eyes/last.{json,png}.
 *  6. GC: keep ≤ 20 frames.
 *
 * Environment variables:
 *   CLAUDE_EYES_DEV_URL   Dev server URL to probe (default: http://localhost:5173)
 *   CLAUDE_EYES_PORT      HTTP port (default: 14242)
 *   CLAUDE_EYES_GC_KEEP   Frame retention limit (default: 20)
 *   CLAUDE_EYES_DEBOUNCE  Debounce ms (default: 250)
 *   CLAUDE_EYES_EYES_DIR  Output dir (default: <cwd>/.claude/eyes)
 *   FORK                  "true" → use bridge.snapshot via cmux socket
 *   CMUX_SOCKET_PATH      cmux socket path (default: /tmp/cmux.sock)
 *   CMUX_SOCKET           alias for CMUX_SOCKET_PATH
 *   CMUX_SURFACE_ID       cmux surface to target for browser.screenshot
 *
 * Optional file config: `.claude-eyes.json` at the repo root.
 *   {
 *     "devUrl": "http://localhost:5173",
 *     "watched_external_tabs": [
 *       { "tab_label": "docs",     "url": "http://localhost:3000/docs" },
 *       { "tab_label": "storybook","url": "http://localhost:6006" }
 *     ]
 *   }
 *   When `watched_external_tabs` is non-empty, each capture cycle snapshots
 *   the listed URLs in addition to the primary devUrl and embeds the results
 *   into EyeFrame.external_context.
 */
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type {
  DaemonConfig,
  EyeFrame,
  WorkerOutput,
  HealthResponse,
  ViewportCapture,
} from "@contracts/index.js";
import { FileWatcher } from "./watcher.js";
import { ScreenCapturer, probeDevServer } from "./screencapturer.js";
import { PlaywrightCapturer } from "./playwright-capturer.js";
import { writeFrame, countFrames, readLastFrame, frameStem } from "./storage.js";
import { createDaemonServer } from "./server.js";
import { BridgeClient } from "../bridge/index.js";
import { loadEyesFileConfig } from "./config-file.js";
import { captureExternalTabs } from "./external-tabs.js";
import { diffFrames } from "./diff.js";
import type { DiffResult } from "@contracts/index.js";
import { captureMultiViewport } from "./multi-viewport.js";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * SECURITY FIX (F4 audit major #3): validate dev URL is loopback + http(s).
 * Prevents SSRF if an attacker controls .env or env vars.
 */
function assertSafeDevUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[claude-eyes] invalid dev URL "${raw}": not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[claude-eyes] dev URL must be http(s), got "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const ok =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.endsWith(".localhost");
  if (!ok) {
    throw new Error(
      `[claude-eyes] dev URL host "${host}" is not loopback. Set CLAUDE_EYES_ALLOW_REMOTE=true to override.`
    );
  }
  return raw;
}

function resolveConfig(): DaemonConfig {
  const rawDevUrl =
    process.env["CLAUDE_EYES_DEV_URL"] ?? "http://localhost:5173";
  const allowRemote = process.env["CLAUDE_EYES_ALLOW_REMOTE"] === "true";
  const devUrl = allowRemote ? rawDevUrl : assertSafeDevUrl(rawDevUrl);
  const repoRoot = process.cwd();
  const eyesDir =
    process.env["CLAUDE_EYES_EYES_DIR"] ??
    path.join(repoRoot, ".claude", "eyes");
  const httpPort = Number(process.env["CLAUDE_EYES_PORT"] ?? "14242");
  const gcKeep = Number(process.env["CLAUDE_EYES_GC_KEEP"] ?? "20");
  const debounceMs = Number(process.env["CLAUDE_EYES_DEBOUNCE"] ?? "250");
  const useBridge =
    (process.env["FORK"] ?? "").toLowerCase() === "true";
  const cmuxSocket =
    process.env["CMUX_SOCKET_PATH"] ??
    process.env["CMUX_SOCKET"] ??
    null;
  const cmuxSurface = process.env["CMUX_SURFACE_ID"] ?? null;

  // Layer .claude-eyes.json over env defaults (file > env > built-in).
  const fileCfg = loadEyesFileConfig(repoRoot);
  const effectiveDevUrl = fileCfg.devUrl ?? devUrl;
  const watchedExternalTabs = fileCfg.watched_external_tabs ?? [];

  return {
    devUrl: effectiveDevUrl,
    eyesDir,
    repoRoot,
    httpPort,
    httpHost: "127.0.0.1",
    gcKeep,
    debounceMs,
    useBridge,
    cmuxSocket,
    cmuxSurface,
    usePlaywright: (process.env["CLAUDE_EYES_PLAYWRIGHT"] ?? "").toLowerCase() === "true",
    watchedExternalTabs,
  };
}

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

interface DaemonState {
  seq: number;
  lastFrame: EyeFrame | null;
  lastError: string | null;
  /** Most recent diff result; null if no prev frame or diff failed. */
  lastDiff: DiffResult | null;
  startedAt: number;
  config: DaemonConfig;
  capturing: boolean;
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

async function captureFrame(
  state: DaemonState,
  bridge: BridgeClient | null,
  screencapturer: ScreenCapturer,
  playwrightCapturer: PlaywrightCapturer | null
): Promise<EyeFrame> {
  const { config } = state;
  const seq = ++state.seq;
  const capturedAt = new Date().toISOString();

  let pngBuffer: Buffer;
  let width: number;
  let height: number;
  let captureMethod: "bridge" | "screencapturer";
  let captureError: string | null = null;
  let httpStatus: number | null = null;
  let viewports: ViewportCapture[] = [];

  if (config.useBridge && bridge !== null) {
    // CLAUDE_EYES_FORK=true: walk 3 viewport profiles sequentially on the same
    // WKWebView via the browser.bridge.set_viewport + browser.bridge.snapshot
    // endpoints added in sprint 2. Playwright is bypassed entirely.
    const multi = await captureMultiViewport({
      bridge,
      eyesDir: config.eyesDir,
      repoRoot: config.repoRoot,
      seq,
      capturedAt,
    });

    if (multi.pngBuffer.length > 0) {
      pngBuffer = multi.pngBuffer;
      width = multi.width;
      height = multi.height;
      captureMethod = "bridge";
      captureError = multi.error;
      viewports = multi.viewports;

      const probe = await probeDevServer(config.devUrl).catch(() => ({
        reachable: false,
        status: null,
        latencyMs: null,
      }));
      httpStatus = probe.status;
    } else {
      // Every bridge viewport failed — fall back to ScreenCapturer or Playwright.
      console.warn(
        `[claude-eyes] bridge multi-viewport failed: ${multi.error} — falling back to screencapturer`
      );
      const fallback =
        playwrightCapturer !== null
          ? await playwrightCapturer.capture()
          : await screencapturer.capture();
      captureError = multi.error;
      httpStatus = fallback.httpStatus;
      if (fallback.ok) {
        pngBuffer = fallback.pngBuffer;
        width = fallback.width;
        height = fallback.height;
      } else {
        pngBuffer = Buffer.alloc(0);
        width = 0;
        height = 0;
        captureError = `bridge: ${multi.error}; screencapturer: ${fallback.error}`;
      }
      captureMethod = "screencapturer";
      // Preserve per-viewport error rows so callers can see what tried.
      viewports = multi.viewports;
    }
  } else if (config.usePlaywright && playwrightCapturer !== null) {
    // CLAUDE_EYES_PLAYWRIGHT=true: use Playwright headless Chromium
    const result = await playwrightCapturer.capture();
    httpStatus = result.httpStatus;
    if (result.ok) {
      pngBuffer = result.pngBuffer;
      width = result.width;
      height = result.height;
    } else {
      pngBuffer = Buffer.alloc(0);
      width = 0;
      height = 0;
      captureError = result.error;
    }
    captureMethod = "screencapturer"; // bridge not used; fits existing captureMethod type
  } else {
    // FORK=false (or no bridge configured): use ScreenCapturer
    const result = await screencapturer.capture();
    httpStatus = result.httpStatus;
    if (result.ok) {
      pngBuffer = result.pngBuffer;
      width = result.width;
      height = result.height;
    } else {
      pngBuffer = Buffer.alloc(0);
      width = 0;
      height = 0;
      captureError = result.error;
    }
    captureMethod = "screencapturer";
  }

  // F5 E-6 bonus: capture auxiliary tabs declared in .claude-eyes.json before
  // we serialize the primary frame so external_context lands in the JSON.
  const stem = frameStem(capturedAt, seq);
  const externalContext = await captureExternalTabs({
    tabs: config.watchedExternalTabs,
    bridge,
    playwright: playwrightCapturer,
    eyesDir: config.eyesDir,
    stem,
  });

  // Non-bridge paths emit a single-entry viewports array reflecting whatever
  // was captured (desktop tier). The bridge path populated viewports above.
  // We use placeholder paths now — they're patched after writeFrame so they
  // point at the real, just-written PNG/JSON the primary frame uses.
  if (viewports.length === 0) {
    viewports = [
      {
        name: "desktop",
        width: width || 1280,
        height: height || 800,
        pngPath: "",
        pngRelative: "",
        jsonPath: "",
        error: captureError,
      },
    ];
  }

  const frameMeta: Omit<EyeFrame, "pngPath" | "pngRelative" | "jsonPath"> = {
    seq,
    capturedAt,
    sourceUrl: config.devUrl,
    httpStatus,
    width,
    height,
    captureMethod,
    error: captureError,
    viewports,
    ...(externalContext.length > 0 ? { external_context: externalContext } : {}),
  };

  const frame = await writeFrame({
    eyesDir: config.eyesDir,
    repoRoot: config.repoRoot,
    seq,
    pngBuffer,
    frame: frameMeta,
    gcKeep: config.gcKeep,
  });

  // Patch the non-bridge single-entry viewport with the just-written paths so
  // consumers always see meaningful pngPath values.
  if (
    frame.viewports.length === 1 &&
    frame.viewports[0]!.pngPath === ""
  ) {
    frame.viewports[0] = {
      ...frame.viewports[0]!,
      pngPath: frame.pngPath,
      pngRelative: frame.pngRelative,
      jsonPath: frame.jsonPath,
    };
  }

  state.lastFrame = frame;
  state.lastError = captureError;
  return frame;
}

// ---------------------------------------------------------------------------
// WorkerOutput builder
// ---------------------------------------------------------------------------

async function buildWorkerOutput(state: DaemonState): Promise<WorkerOutput> {
  const { config, lastFrame, lastError, startedAt } = state;
  const retained = await countFrames(config.eyesDir);
  return {
    seq: lastFrame?.seq ?? null,
    capturedAt: lastFrame?.capturedAt ?? null,
    pngPath: lastFrame?.pngPath ?? null,
    jsonPath: lastFrame?.jsonPath ?? null,
    error: lastError,
    framesRetained: retained,
    devUrl: config.devUrl,
    uptimeMs: Date.now() - startedAt,
    diff: state.lastDiff,
  };
}

function buildWorkerOutputSync(
  state: DaemonState,
  framesRetained: number
): WorkerOutput {
  const { config, lastFrame, lastError, startedAt } = state;
  return {
    seq: lastFrame?.seq ?? null,
    capturedAt: lastFrame?.capturedAt ?? null,
    pngPath: lastFrame?.pngPath ?? null,
    jsonPath: lastFrame?.jsonPath ?? null,
    error: lastError,
    framesRetained,
    devUrl: config.devUrl,
    uptimeMs: Date.now() - startedAt,
    diff: state.lastDiff,
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = resolveConfig();
  const startedAt = Date.now();

  console.log("[claude-eyes] daemon starting");
  console.log(`[claude-eyes]   devUrl       : ${config.devUrl}`);
  console.log(`[claude-eyes]   eyesDir      : ${config.eyesDir}`);
  console.log(`[claude-eyes]   httpPort     : ${config.httpPort}`);
  console.log(`[claude-eyes]   gcKeep       : ${config.gcKeep}`);
  console.log(`[claude-eyes]   debounce     : ${config.debounceMs}ms`);
  console.log(`[claude-eyes]   useBridge    : ${config.useBridge}`);
  console.log(`[claude-eyes]   usePlaywright: ${config.usePlaywright}`);
  console.log(
    `[claude-eyes]   externalTabs : ${
      config.watchedExternalTabs.length === 0
        ? "<none>"
        : config.watchedExternalTabs
            .map((t) => `${t.tab_label}=${t.url}`)
            .join(", ")
    }`
  );

  // When bridge is active, Playwright is optional — warn at startup so the
  // user knows they can remove the CLAUDE_EYES_PLAYWRIGHT env var.
  if (config.useBridge && config.usePlaywright) {
    PlaywrightCapturer.emitBridgeDeprecationWarning();
  }

  // Ensure output dir exists
  await fsp.mkdir(config.eyesDir, { recursive: true });

  // Seed from pre-existing last.json
  const seedFrame = await readLastFrame(config.eyesDir);

  const state: DaemonState = {
    seq: seedFrame?.seq ?? 0,
    lastFrame: seedFrame,
    lastError: null,
    lastDiff: null,
    startedAt,
    config,
    capturing: false,
  };

  // Build capture tools
  const bridge =
    config.useBridge
      ? new BridgeClient({
          socketPath: config.cmuxSocket ?? "/tmp/cmux.sock",
          surfaceId: config.cmuxSurface ?? undefined,
        })
      : null;

  const screencapturer = new ScreenCapturer({
    devUrl: config.devUrl,
    eyesDir: config.eyesDir,
    // When bridge is available, inject its geometry resolver for better rect
    getGeometry:
      bridge !== null
        ? async () => {
            const surfaceId = await bridge.resolveFocusedSurface();
            // We don't have a geometry API yet — return null to fall back to AX
            void surfaceId;
            return null;
          }
        : undefined,
  });

  const playwrightCapturer = config.usePlaywright
    ? new PlaywrightCapturer({ devUrl: config.devUrl })
    : null;

  // Capture helper with lock guard
  const runCapture = async (): Promise<WorkerOutput> => {
    if (state.capturing) {
      const retained = await countFrames(config.eyesDir);
      return buildWorkerOutputSync(state, retained);
    }
    state.capturing = true;
    // Save reference to the previous frame before overwriting state
    const prevFrame = state.lastFrame;
    try {
      const frame = await captureFrame(state, bridge, screencapturer, playwrightCapturer);
      console.log(
        `[claude-eyes] captured frame #${frame.seq} → ${frame.pngPath}`
      );
      // Compute pixel diff against the previous frame (same viewport only)
      if (
        prevFrame !== null &&
        prevFrame.width === frame.width &&
        prevFrame.height === frame.height &&
        prevFrame.width > 0 &&
        prevFrame.height > 0
      ) {
        state.lastDiff = await diffFrames({
          prevPngPath: prevFrame.pngPath,
          currPngPath: frame.pngPath,
          eyesDir: config.eyesDir,
          seq: frame.seq,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[claude-eyes] diff error (non-fatal): ${msg}`);
          return null;
        });
        if (state.lastDiff !== null) {
          const pct = (state.lastDiff.changed_pixels_pct * 100).toFixed(2);
          console.log(
            `[claude-eyes] diff #${frame.seq}: ${pct}% changed` +
            (state.lastDiff.bbox_changed !== null
              ? ` bbox=${JSON.stringify(state.lastDiff.bbox_changed)}`
              : " (no change)")
          );
        }
      } else {
        state.lastDiff = null;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastError = msg;
      state.lastDiff = null;
      console.error(`[claude-eyes] capture error: ${msg}`);
    } finally {
      state.capturing = false;
    }
    return buildWorkerOutput(state);
  };

  // File watcher
  const watcher = new FileWatcher(config.repoRoot, config.debounceMs);
  watcher.on("change", () => {
    void runCapture();
  });
  watcher.start();
  console.log("[claude-eyes] file watcher started");

  // Frame count cache for synchronous health/latest responses
  let cachedFrameCount = seedFrame !== null ? 1 : 0;
  void countFrames(config.eyesDir).then((n) => {
    cachedFrameCount = n;
  });

  // HTTP server
  const server = createDaemonServer({
    host: config.httpHost,
    port: config.httpPort,

    onHealth: (): HealthResponse => ({
      ok: true,
      uptimeMs: Date.now() - startedAt,
      devUrl: config.devUrl,
      framesRetained: cachedFrameCount,
    }),

    onLatest: (): WorkerOutput =>
      buildWorkerOutputSync(state, cachedFrameCount),

    onSnapshot: async (): Promise<WorkerOutput> => {
      const result = await runCapture();
      cachedFrameCount = result.framesRetained;
      return result;
    },
  });

  server.on("listening", () => {
    console.log(
      `[claude-eyes] HTTP server listening on ${config.httpHost}:${config.httpPort}`
    );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[claude-eyes] HTTP server error: ${err.message}`);
  });

  // Initial capture
  console.log("[claude-eyes] running initial capture...");
  const initialResult = await runCapture();
  cachedFrameCount = initialResult.framesRetained;
  console.log(
    `[claude-eyes] initial capture done. frames retained: ${cachedFrameCount}`
  );

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("[claude-eyes] shutting down...");
    await watcher.stop();
    if (playwrightCapturer !== null) {
      await playwrightCapturer.close();
    }
    server.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("[claude-eyes] fatal:", err);
  process.exit(1);
});
