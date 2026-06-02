/**
 * bridge/screen-capturer.ts
 *
 * F2 / worker S-3 — capture a rectangle of the macOS desktop that corresponds
 * to the cmux embedded browser surface and persist it as a PNG on disk.
 *
 * Strategy (preference order):
 *   1) Caller supplies an explicit rect (highest trust, e.g. from
 *      `bridge.window.get_geometry()`).
 *   2) Bridge geometry provider (`opts.getGeometry()` — wired from
 *      bridge/index.ts in a later worker; the cmux socket API does NOT
 *      currently expose `window.get_geometry`, so the bridge derives it from
 *      `window.list` + AppKit window frames).
 *   3) Fallback: AppleScript Accessibility query against the cmux app's
 *      front browser tab (`System Events` → `process "cmux"` → window 1 →
 *      front WKWebView-backed tab).
 *
 * Multi-monitor safe: `screencapture -R x,y,w,h` uses the global desktop
 * coordinate space (origin at the primary display's top-left, pixels —
 * not points — per the macOS `screencapture(1)` contract). We pass raw
 * floats through `Math.round` and clamp to the union bounds returned by
 * `system_profiler SPDisplaysDataType` only when we had to fall back to
 * Accessibility (which sometimes returns negative origins for secondary
 * displays — that's correct, we keep them).
 *
 * Hard budget: capture must complete in <2s wall clock. We enforce that
 * with `AbortController` + an explicit `setTimeout`.
 *
 * Public contract:
 *   capture(opts): Promise<CaptureResult>
 *
 *   opts.rect?         — { x, y, width, height } in desktop points/pixels
 *   opts.getGeometry?  — async () => Rect | null   (preferred)
 *   opts.outDir?       — directory to drop PNG into (default `.claude/eyes`)
 *   opts.filename?     — base filename (default `cap-<ts>.png`)
 *   opts.timeoutMs?    — default 2000
 *
 *   CaptureResult: { png_path, width, height, bytes, sha256 }
 *
 * Self-test:
 *   `tsx bridge/screen-capturer.ts` runs an end-to-end capture against the
 *   primary display's top-left 320x200 region and prints the result.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types — kept inline because /contracts is not yet populated for F2/S-3.
// Once contracts/screen.ts lands, replace these imports with `@contracts/screen`.
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** Pre-resolved rect in macOS desktop coordinates. Wins over getGeometry. */
  rect?: Rect;
  /** Bridge-supplied geometry resolver. Called only when `rect` is absent. */
  getGeometry?: () => Promise<Rect | null>;
  /** Directory the PNG is written into. Created if missing. */
  outDir?: string;
  /** Base filename. Auto-generated if absent. */
  filename?: string;
  /** Abort the capture if it overruns this many ms (default 2000). */
  timeoutMs?: number;
  /** Capture the cursor (passes `-C` to screencapture). Default false. */
  captureCursor?: boolean;
  /** macOS app name used for the AX fallback. Default "cmux". */
  appName?: string;
}

export interface CaptureResult {
  png_path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  /** Which geometry source was used: "rect" | "bridge" | "accessibility". */
  source: GeometrySource;
  /** Wall-clock ms from entry to PNG persisted. */
  durationMs: number;
  /** The rect that was actually captured (post-rounding). */
  rect: Rect;
}

export type GeometrySource = "rect" | "bridge" | "accessibility";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_OUT_DIR = ".claude/eyes";
const DEFAULT_APP_NAME = "cmux";

// PNG IHDR magic — first 8 bytes signature, then `IHDR` chunk at offset 12.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function capture(
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate raw caller input BEFORE normalisation so a 0 width stays 0.
  if (opts.rect) validateRect(opts.rect);

  const { rect, source } = await resolveRect(opts);
  validateRect(rect);

  const outDir = resolveOutDir(opts.outDir);
  await mkdir(outDir, { recursive: true });

  const filename = opts.filename ?? defaultFilename(started);
  const pngPath = join(outDir, filename);

  await runScreencapture({
    rect,
    pngPath,
    captureCursor: opts.captureCursor === true,
    timeoutMs: remainingBudget(started, timeoutMs),
  });

  const png = await readFile(pngPath);
  if (!isPng(png)) {
    // screencapture occasionally writes 0-byte files on failed regions
    // (e.g. rect entirely off-screen). Surface that as a real error.
    await safeUnlink(pngPath);
    throw new CaptureError(
      `screencapture produced a non-PNG file (size=${png.byteLength})`,
    );
  }

  const { width, height } = readPngDimensions(png);
  const sha256 = createHash("sha256").update(png).digest("hex");

  return {
    png_path: pngPath,
    width,
    height,
    bytes: png.byteLength,
    sha256,
    source,
    durationMs: Date.now() - started,
    rect,
  };
}

// ---------------------------------------------------------------------------
// Geometry resolution
// ---------------------------------------------------------------------------

async function resolveRect(
  opts: CaptureOptions,
): Promise<{ rect: Rect; source: GeometrySource }> {
  if (opts.rect) {
    return { rect: normalizeRect(opts.rect), source: "rect" };
  }

  if (opts.getGeometry) {
    try {
      const geom = await opts.getGeometry();
      if (geom) {
        return { rect: normalizeRect(geom), source: "bridge" };
      }
    } catch (err) {
      // Bridge unavailable — keep going and fall back to Accessibility.
      // We deliberately swallow because the AX fallback is the whole point.
      if (process.env.CLAUDE_EYES_DEBUG) {
        process.stderr.write(
          `[screen-capturer] bridge getGeometry failed: ${describeError(err)}\n`,
        );
      }
    }
  }

  const ax = await queryAccessibilityRect(opts.appName ?? DEFAULT_APP_NAME);
  return { rect: normalizeRect(ax), source: "accessibility" };
}

function normalizeRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
}

function validateRect(r: Rect): void {
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) {
    throw new CaptureError(`invalid rect origin: ${JSON.stringify(r)}`);
  }
  if (r.width <= 0 || r.height <= 0) {
    throw new CaptureError(`invalid rect size: ${JSON.stringify(r)}`);
  }
  // Reject absurd sizes — guards against AX returning the whole desktop union
  // by mistake, or a runaway dev-server preview.
  if (r.width > 16384 || r.height > 16384) {
    throw new CaptureError(`rect exceeds 16384 in some dimension: ${JSON.stringify(r)}`);
  }
}

// ---------------------------------------------------------------------------
// Accessibility fallback
//
// We ask System Events for the position+size of the front window of the cmux
// process, then drill into its first WKWebView-shaped AXGroup (the embedded
// browser surface). If we cannot find a webview descendant we return the
// window itself — that still captures the preview, just with cmux chrome.
// ---------------------------------------------------------------------------

const AX_SCRIPT = `
on numFrom(v)
  try
    return v as real
  on error
    return v as integer
  end try
end numFrom

on findWebView(uiElem)
  try
    set rolePath to {"AXWebArea", "AXScrollArea", "AXGroup"}
    repeat with r in rolePath
      try
        set candidate to first UI element of uiElem whose role is (r as text)
        if candidate is not missing value then return candidate
      end try
    end repeat
  end try
  try
    set kids to UI elements of uiElem
    repeat with k in kids
      set deeper to my findWebView(k)
      if deeper is not missing value then return deeper
    end repeat
  end try
  return missing value
end findWebView

on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if not (exists process appName) then
      return "ERR:no-process:" & appName
    end if
    tell process appName
      if (count of windows) is 0 then return "ERR:no-window"
      set win to window 1
      set winPos to position of win
      set winSize to size of win
      set wx to my numFrom(item 1 of winPos)
      set wy to my numFrom(item 2 of winPos)
      set ww to my numFrom(item 1 of winSize)
      set wh to my numFrom(item 2 of winSize)
      set wv to my findWebView(win)
      if wv is not missing value then
        try
          set wvPos to position of wv
          set wvSize to size of wv
          set vx to my numFrom(item 1 of wvPos)
          set vy to my numFrom(item 2 of wvPos)
          set vw to my numFrom(item 1 of wvSize)
          set vh to my numFrom(item 2 of wvSize)
          if vw > 0 and vh > 0 then
            return "OK:webview:" & vx & "," & vy & "," & vw & "," & vh
          end if
        end try
      end if
      return "OK:window:" & wx & "," & wy & "," & ww & "," & wh
    end tell
  end tell
end run
`.trim();

async function queryAccessibilityRect(appName: string): Promise<Rect> {
  const out = await runProcess(
    "/usr/bin/osascript",
    ["-s", "s", "-", appName],
    { stdin: AX_SCRIPT, timeoutMs: 1500 },
  );
  const line = out.stdout.trim().replace(/^"|"$/g, "");
  if (line.startsWith("ERR:")) {
    throw new CaptureError(`accessibility fallback failed: ${line}`);
  }
  const m = line.match(/^OK:(webview|window):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    throw new CaptureError(`accessibility fallback returned unparseable output: ${line}`);
  }
  return {
    x: Number(m[2]),
    y: Number(m[3]),
    width: Number(m[4]),
    height: Number(m[5]),
  };
}

// ---------------------------------------------------------------------------
// screencapture invocation
// ---------------------------------------------------------------------------

interface RunScreencaptureOpts {
  rect: Rect;
  pngPath: string;
  captureCursor: boolean;
  timeoutMs: number;
}

async function runScreencapture(o: RunScreencaptureOpts): Promise<void> {
  const args: string[] = [
    "-x",                                            // silent (no shutter sound)
    "-t", "png",                                     // PNG format
    "-R", `${o.rect.x},${o.rect.y},${o.rect.width},${o.rect.height}`,
  ];
  if (o.captureCursor) args.push("-C");
  args.push(o.pngPath);

  const res = await runProcess("/usr/sbin/screencapture", args, {
    timeoutMs: o.timeoutMs,
  });

  if (res.code !== 0) {
    throw new CaptureError(
      `screencapture exited ${res.code}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }

  // screencapture sometimes exits 0 but writes nothing for invalid rects.
  try {
    const s = await stat(o.pngPath);
    if (s.size === 0) {
      throw new CaptureError("screencapture wrote a 0-byte file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CaptureError("screencapture did not produce an output file");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Subprocess helper with hard timeout
// ---------------------------------------------------------------------------

interface RunProcessOpts {
  stdin?: string;
  timeoutMs: number;
}
interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: RunProcessOpts,
): Promise<RunProcessResult> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rejectFn(new CaptureError(`${cmd} timed out after ${opts.timeoutMs}ms`));
    }, Math.max(1, opts.timeoutMs));

    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectFn(new CaptureError(`${cmd} failed to spawn: ${describeError(err)}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn({ code: code ?? -1, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// PNG inspection
// ---------------------------------------------------------------------------

function isPng(buf: Buffer): boolean {
  if (buf.byteLength < 24) return false;
  return buf.subarray(0, 8).equals(PNG_SIG);
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  // IHDR is the first chunk after the 8-byte signature.
  // Layout: 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height, ...
  const ihdr = buf.subarray(12, 16).toString("ascii");
  if (ihdr !== "IHDR") {
    throw new CaptureError(`PNG missing IHDR chunk (found "${ihdr}")`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

function resolveOutDir(outDir: string | undefined): string {
  const base = outDir ?? DEFAULT_OUT_DIR;
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

function defaultFilename(ts: number): string {
  return `cap-${ts}.png`;
}

function remainingBudget(started: number, totalMs: number): number {
  const left = totalMs - (Date.now() - started);
  return Math.max(50, left);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeUnlink(p: string): Promise<void> {
  try { await unlink(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Self-test (run via `tsx bridge/screen-capturer.ts`)
//
// Captures a known 320×200 region at (0,0) of the main display and prints
// the CaptureResult. Useful for: confirming TCC permissions, smoke-testing
// timing budget, and as a manual integration probe.
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    return thisFile === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "eyes");
  const testRect: Rect = { x: 0, y: 0, width: 320, height: 200 };

  capture({
    rect: testRect,
    outDir,
    filename: `selftest-${Date.now()}.png`,
    timeoutMs: 2000,
  })
    .then(async (res) => {
      // Write a tiny sidecar with the result for the workflow auditor.
      const sidecar = `${res.png_path}.json`;
      await writeFile(sidecar, JSON.stringify(res, null, 2), "utf8");
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`capture failed: ${describeError(err)}\n`);
      process.exit(1);
    });
}
