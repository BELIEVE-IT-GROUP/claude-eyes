/**
 * daemon/config-file.ts — loads `.claude-eyes.json` from the repo root.
 *
 * Schema (all fields optional):
 *   {
 *     "devUrl": "http://localhost:5173",
 *     "watched_external_tabs": [
 *       { "tab_label": "docs",     "url": "http://localhost:3000/docs" },
 *       { "tab_label": "supabase", "url": "https://app.supabase.com/..." }
 *     ]
 *   }
 *
 * Invalid JSON, missing file, or schema violations all degrade to {} so the
 * daemon never crashes on a malformed user config.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EyesFileConfig,
  WatchedExternalTab,
} from "@contracts/index.js";

const CONFIG_FILENAME = ".claude-eyes.json";

/**
 * Read `.claude-eyes.json` from `repoRoot`. Returns an empty object on any
 * failure path (missing file, malformed JSON, unreadable, etc.). Diagnostic
 * messages are logged to stderr but never thrown.
 */
export function loadEyesFileConfig(repoRoot: string): EyesFileConfig {
  const filePath = path.join(repoRoot, CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-eyes] could not read ${CONFIG_FILENAME}: ${msg}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-eyes] ${CONFIG_FILENAME} is not valid JSON: ${msg}`);
    return {};
  }

  if (typeof parsed !== "object" || parsed === null) return {};

  const out: EyesFileConfig = {};
  const obj = parsed as Record<string, unknown>;

  if (typeof obj["devUrl"] === "string") {
    out.devUrl = obj["devUrl"];
  }

  const tabs = obj["watched_external_tabs"];
  if (Array.isArray(tabs)) {
    out.watched_external_tabs = normalizeTabs(tabs);
  }

  return out;
}

function normalizeTabs(input: unknown[]): WatchedExternalTab[] {
  const out: WatchedExternalTab[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const label = rec["tab_label"];
    const url = rec["url"];
    if (typeof label !== "string" || typeof url !== "string") continue;
    if (label.trim() === "" || url.trim() === "") continue;
    out.push({ tab_label: label, url });
  }
  return out;
}

/**
 * Slugify a tab_label into a filesystem-safe filename fragment.
 * Lowercase, replace any non [a-z0-9._-] with "-", collapse repeats.
 */
export function slugifyTabLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "tab";
}
