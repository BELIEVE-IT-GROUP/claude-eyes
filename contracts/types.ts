/**
 * Shared types for the claude-eyes daemon + bridge + hooks pipeline.
 * All processes import from here — keep this free of runtime side-effects.
 */

// ---------------------------------------------------------------------------
// ExternalContext — a snapshot of an auxiliary browser tab captured alongside
// the primary dev-server frame (F5 E-6 bonus).
// ---------------------------------------------------------------------------

/**
 * One auxiliary tab captured alongside the primary frame.
 * Configured via `.claude-eyes.json` → `watched_external_tabs`.
 */
export interface ExternalContextEntry {
  /** Human-friendly label for this tab (e.g. "docs", "supabase-dashboard"). */
  tab_label: string;
  /** URL that was captured. */
  url: string;
  /** Absolute path to the PNG snapshot for this tab, or null if capture failed. */
  snapshot_png_path: string | null;
  /** HTTP status from probing the URL, or null if unreachable. */
  httpStatus?: number | null;
  /** Error message if this auxiliary capture failed; null/absent on success. */
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Viewport — one named device profile inside a multi-viewport EyeFrame
// ---------------------------------------------------------------------------

/** Logical viewport label used by the bridge when emitting per-device captures. */
export type ViewportName = "mobile" | "tablet" | "desktop";

/** One captured viewport — paired PNG + JSON inside a multi-viewport frame. */
export interface ViewportCapture {
  /** Logical device tier this capture targeted. */
  name: ViewportName;
  /** CSS-pixel width used for set_viewport. */
  width: number;
  /** CSS-pixel height used for set_viewport. */
  height: number;
  /** Absolute path to the PNG for this viewport. */
  pngPath: string;
  /** Relative path from the repo root (for agent consumption). */
  pngRelative: string;
  /** Absolute path to the companion JSON metadata file for this viewport. */
  jsonPath: string;
  /** Error message if this viewport capture failed; null on success. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// EyeFrame — one captured screenshot moment
// ---------------------------------------------------------------------------

/** A single captured frame written to .claude/eyes/ */
export interface EyeFrame {
  /** Monotonic capture sequence number (1-based, never reused within a run). */
  seq: number;
  /** ISO-8601 timestamp when the capture was requested. */
  capturedAt: string;
  /** Absolute path to the PNG file on disk. */
  pngPath: string;
  /** Relative path from the repo root (for agent consumption). */
  pngRelative: string;
  /** Absolute path to the companion JSON metadata file. */
  jsonPath: string;
  /** URL of the dev server page that was captured. */
  sourceUrl: string;
  /** HTTP status returned by the dev server probe, or null if unreachable. */
  httpStatus: number | null;
  /** Width of the captured image in pixels (primary tier — desktop when multi-viewport). */
  width: number;
  /** Height of the captured image in pixels (primary tier — desktop when multi-viewport). */
  height: number;
  /** Whether this frame was taken via the cmux bridge (FORK=true) or ScreenCapturer. */
  captureMethod: "bridge" | "screencapturer";
  /** Error message if capture failed; null on success. */
  error: string | null;
  /**
   * Per-viewport captures emitted by the bridge when CLAUDE_EYES_FORK=true.
   * - Bridge path: [mobile 375x812, tablet 768x1024, desktop 1280x800] (sequential, same WKWebView).
   * - Non-bridge / fallback path: single-entry [desktop] (or empty on error).
   */
  viewports: ViewportCapture[];
  /**
   * Optional auxiliary tab snapshots taken in the same capture cycle.
   * Populated when `.claude-eyes.json` declares `watched_external_tabs`.
   * Absent (or empty) when no extra tabs are configured.
   */
  external_context?: ExternalContextEntry[];
}

// ---------------------------------------------------------------------------
// EyesFileConfig — user-editable `.claude-eyes.json` schema
// ---------------------------------------------------------------------------

/**
 * Shape of `.claude-eyes.json` at the repo root.
 * All fields are optional; the daemon merges this with env-derived defaults.
 */
export interface EyesFileConfig {
  /** Override CLAUDE_EYES_DEV_URL from a file. */
  devUrl?: string;
  /**
   * Extra browser tabs to snapshot alongside the primary frame on every capture.
   * Each entry becomes one ExternalContextEntry in the resulting EyeFrame.
   */
  watched_external_tabs?: WatchedExternalTab[];
}

/** One entry in `watched_external_tabs`. */
export interface WatchedExternalTab {
  /** Human-friendly label used to derive the snapshot filename. */
  tab_label: string;
  /** URL to capture. */
  url: string;
}

// ---------------------------------------------------------------------------
// DiffResult — pixel-level diff between two consecutive frames (F5 E-2)
// ---------------------------------------------------------------------------

/**
 * Bounding box of the changed region in the diff image.
 * All coordinates are in the same pixel space as the input PNGs.
 */
export interface BboxChanged {
  /** Left edge of the changed region (inclusive). */
  x: number;
  /** Top edge of the changed region (inclusive). */
  y: number;
  /** Width of the changed region in pixels. */
  width: number;
  /** Height of the changed region in pixels. */
  height: number;
}

/**
 * Result produced by diffFrames() — the pixelmatch comparison between the
 * previous and current captured frames.
 *
 * Returned inside WorkerOutput.diff after every capture that has a same-size
 * predecessor frame.
 */
export interface DiffResult {
  /** Absolute path to the written diff PNG visualisation. */
  diff_png_path: string;
  /**
   * Fraction of pixels that differ between the two frames, expressed as a
   * value in [0, 1].  0 = identical; 1 = every pixel changed.
   */
  changed_pixels_pct: number;
  /**
   * Axis-aligned bounding box of all changed pixels.
   * null when changed_pixels_pct === 0 (no pixels changed).
   */
  bbox_changed: BboxChanged | null;
}

// ---------------------------------------------------------------------------
// WorkerOutput — structured result the daemon emits after each capture cycle
// ---------------------------------------------------------------------------

/** Returned by the daemon over HTTP GET /latest and POST /snapshot. */
export interface WorkerOutput {
  /** Sequence number of the captured frame, or null if no frame exists. */
  seq: number | null;
  /** ISO-8601 timestamp of the last successful capture, or null. */
  capturedAt: string | null;
  /** Absolute path to the most-recent PNG (symlink target of last.png). */
  pngPath: string | null;
  /** Absolute path to the most-recent JSON metadata (symlink target of last.json). */
  jsonPath: string | null;
  /** Short error description from the last capture attempt, or null. */
  error: string | null;
  /** Total number of frames retained in the GC window. */
  framesRetained: number;
  /** Dev-server URL that was probed. */
  devUrl: string;
  /** Daemon uptime in milliseconds. */
  uptimeMs: number;
  /**
   * Pixel-level diff against the previous same-viewport frame.
   * Populated by daemon/diff.ts when a previous frame exists with matching dimensions.
   * null when no previous frame, dimensions differ, or diff is skipped.
   */
  diff?: DiffResult | null;
}

// ---------------------------------------------------------------------------
// SnapshotRequest — payload for POST /snapshot
// ---------------------------------------------------------------------------

/** Optional body accepted by POST /snapshot. */
export interface SnapshotRequest {
  /** Override the dev URL for this one capture. Defaults to CLAUDE_EYES_DEV_URL. */
  url?: string;
}

// ---------------------------------------------------------------------------
// HealthResponse — GET /healthz
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  uptimeMs: number;
  devUrl: string;
  framesRetained: number;
}

// ---------------------------------------------------------------------------
// BridgeSnapshot — what bridge/index.ts returns from .snapshot()
// ---------------------------------------------------------------------------

/** Raw result from bridge.snapshot() — either a PNG buffer or an error. */
export type BridgeSnapshotResult =
  | { ok: true; pngBuffer: Buffer; width: number; height: number }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// DaemonConfig — resolved from environment at startup
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  /** Dev server URL to probe and capture. */
  devUrl: string;
  /** Absolute path to .claude/eyes/ output directory. */
  eyesDir: string;
  /** Absolute path to the repo root (for relative paths in EyeFrame). */
  repoRoot: string;
  /** Port the daemon HTTP server listens on. */
  httpPort: number;
  /** Host the daemon HTTP server binds to. */
  httpHost: string;
  /** Maximum number of frames to keep (GC removes oldest beyond this). */
  gcKeep: number;
  /** Debounce delay in milliseconds for file-watcher triggers. */
  debounceMs: number;
  /** Whether to use the cmux bridge for captures (FORK=true). */
  useBridge: boolean;
  /** cmux socket path (only relevant when useBridge=true). */
  cmuxSocket: string | null;
  /** cmux surface id to target for browser.snapshot (only relevant when useBridge=true). */
  cmuxSurface: string | null;
  /** Whether to use Playwright headless Chromium for captures (CLAUDE_EYES_PLAYWRIGHT=true). */
  usePlaywright: boolean;
  /**
   * Auxiliary tabs to snapshot on every capture cycle.
   * Loaded from `.claude-eyes.json` at the repo root, or [] if file absent/invalid.
   */
  watchedExternalTabs: WatchedExternalTab[];
}
