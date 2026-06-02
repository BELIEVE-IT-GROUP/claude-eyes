/**
 * daemon/auth.ts — local HTTP auth for the claude-eyes daemon.
 *
 * SECURITY FIX (F4 security audit, blocker #1):
 * Without auth, any process on the same Mac could hit the daemon HTTP
 * endpoints and exfiltrate the latest frame or trigger captures.
 *
 * Mechanism: on first start the daemon generates a 32-byte hex key at
 * ~/.claude-eyes/key (chmod 600) and requires the X-Eyes-Key header on
 * every request. Hooks read the same file and send the header.
 *
 * Threat model: defends against same-machine, different-UID processes and
 * scripts that don't have read access to the user's home dotfiles. Does
 * NOT defend against malware running as the same UID (it could read the
 * key file). For personal-use scope, this is the correct trade-off.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";

const KEY_DIR = path.join(os.homedir(), ".claude-eyes");
const KEY_FILE = path.join(KEY_DIR, "key");
const HEADER_NAME = "x-eyes-key";

/** Return the auth key, generating + persisting it on first call. */
export function ensureAuthKey(): string {
  if (fs.existsSync(KEY_FILE)) {
    const existing = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
  return key;
}

/** Path to the key file, for hooks/CLIs that need to read it. */
export function getKeyFilePath(): string {
  return KEY_FILE;
}

/** Constant-time validation of the X-Eyes-Key header against the active key. */
export function validateRequest(req: IncomingMessage, expectedKey: string): boolean {
  const provided = req.headers[HEADER_NAME];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const AUTH_HEADER_NAME = HEADER_NAME;
