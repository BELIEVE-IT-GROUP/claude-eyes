/**
 * daemon/external-tabs.ts — captures auxiliary browser tabs declared in
 * `.claude-eyes.json` → `watched_external_tabs`, alongside the primary frame.
 *
 * For each configured tab:
 *  - Attempt a snapshot via the cmux bridge (preferred) or Playwright fallback.
 *  - Persist the PNG to `<eyesDir>/external/<stem>-<slug>.png`.
 *  - Probe HTTP status so the EyeFrame entry carries an httpStatus field.
 *  - Return one ExternalContextEntry per configured tab (in declaration order).
 *
 * Failures are isolated: a broken tab yields `snapshot_png_path: null` plus an
 * `error` message, but never aborts the primary capture or sibling tabs.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  ExternalContextEntry,
  WatchedExternalTab,
} from "@contracts/index.js";
import type { BridgeClient } from "../bridge/index.js";
import { PlaywrightCapturer } from "./playwright-capturer.js";
import { probeDevServer } from "./screencapturer.js";
import { slugifyTabLabel } from "./config-file.js";

export interface CaptureExternalTabsOpts {
  /** Configured tabs to capture; safe to pass an empty array. */
  tabs: WatchedExternalTab[];
  /** Optional cmux bridge (preferred capture path when available). */
  bridge: BridgeClient | null;
  /** Optional Playwright capturer for the fallback path. */
  playwright: PlaywrightCapturer | null;
  /** Output directory root — files land under `<eyesDir>/external/`. */
  eyesDir: string;
  /** Filename stem from the primary frame (timestamp + seq). */
  stem: string;
}

/**
 * Capture all configured external tabs sequentially.
 * Returns one ExternalContextEntry per input tab, in the same order.
 *
 * Empty input → empty array (caller can omit the field from EyeFrame).
 */
export async function captureExternalTabs(
  opts: CaptureExternalTabsOpts
): Promise<ExternalContextEntry[]> {
  if (opts.tabs.length === 0) return [];

  const externalDir = path.join(opts.eyesDir, "external");
  await fsp.mkdir(externalDir, { recursive: true });

  const results: ExternalContextEntry[] = [];
  for (const tab of opts.tabs) {
    const entry = await captureOne(tab, externalDir, opts);
    results.push(entry);
  }
  return results;
}

async function captureOne(
  tab: WatchedExternalTab,
  externalDir: string,
  opts: CaptureExternalTabsOpts
): Promise<ExternalContextEntry> {
  const slug = slugifyTabLabel(tab.tab_label);
  const pngPath = path.join(externalDir, `${opts.stem}-${slug}.png`);

  // Probe HTTP status — independent of snapshot success.
  let httpStatus: number | null = null;
  try {
    const probe = await probeDevServer(tab.url);
    httpStatus = probe.status;
  } catch {
    httpStatus = null;
  }

  // Attempt capture (bridge → playwright → error).
  let pngBuffer: Buffer | null = null;
  let captureError: string | null = null;

  if (opts.bridge !== null) {
    const result = await opts.bridge.snapshotUrl(tab.url);
    if (result.ok) {
      pngBuffer = result.pngBuffer;
    } else {
      captureError = `bridge: ${result.error}`;
    }
  }

  if (pngBuffer === null && opts.playwright !== null) {
    const pw = await opts.playwright.captureUrl(tab.url).catch(
      (err: unknown): { ok: false; error: string } => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    if (pw.ok) {
      pngBuffer = pw.pngBuffer;
      captureError = null;
    } else {
      captureError = captureError === null
        ? `playwright: ${pw.error}`
        : `${captureError}; playwright: ${pw.error}`;
    }
  }

  if (pngBuffer === null && captureError === null) {
    captureError = "no capture backend available for external tabs";
  }

  if (pngBuffer !== null) {
    try {
      await fsp.writeFile(pngPath, pngBuffer);
      return {
        tab_label: tab.tab_label,
        url: tab.url,
        snapshot_png_path: pngPath,
        httpStatus,
        error: null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      captureError = `write failed: ${msg}`;
    }
  }

  return {
    tab_label: tab.tab_label,
    url: tab.url,
    snapshot_png_path: null,
    httpStatus,
    error: captureError ?? "unknown capture failure",
  };
}
