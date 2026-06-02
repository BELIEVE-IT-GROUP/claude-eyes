/**
 * cmux-client.ts — TypeScript wrapper over the cmux Unix-socket IPC.
 *
 * Protocol: AF_UNIX SOCK_STREAM, newline-delimited JSON (V2).
 * Each request: {"id":"<uuid>","method":"<name>","params":{...}}\n
 * Each response: {"ok":true,"id":"<echoed>","result":{...}}\n
 *            or: {"ok":false,"id":"<echoed>","error":{"code":number,"message":string,"data"?:unknown}}\n
 *
 * CLI fallback: when socket path cannot be resolved, every send() is
 * routed through the `cmux-cli` binary (V2 JSON-RPC subcommand).
 *
 * Phase-4 guard: commands that require a patched fork of cmux throw
 * CmuxNotImplementedError unless the env var CLAUDE_EYES_FORK=true is set.
 *
 * Timeout: all round-trips enforce a 5 000 ms deadline by default.
 */

import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const MARKER_FILE = join(homedir(), ".cmux", "socket_addr");
const LEGACY_SOCKET = "/tmp/cmux.sock";
const DEFAULT_SOCKET = join(
  homedir(),
  "Library",
  "Application Support",
  "cmux",
  "cmux.sock",
);

// ---------------------------------------------------------------------------
// Types — wire protocol
// ---------------------------------------------------------------------------

interface V2Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface V2SuccessResponse<R> {
  ok: true;
  id: string;
  result: R;
}

interface V2ErrorResponse {
  ok: false;
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type V2Response<R> = V2SuccessResponse<R> | V2ErrorResponse;

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export interface PingResult {
  pong: boolean;
}

export interface NavigateResult {
  workspace_id: string;
  workspace_ref: string;
  surface_id: string;
  surface_ref: string;
  window_id: string;
  window_ref: string;
}

export interface Tab {
  tab_id: string;
  url?: string;
  title?: string;
  active?: boolean;
}

export interface TabListResult {
  tabs: Tab[];
}

/** BoundingClientRect from browser.get.box — Phase-4 only (CLAUDE_EYES_FORK). */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result returned by browser.bridge.snapshot (CLAUDE_EYES_FORK). */
export interface BridgeSnapshotCommandResult {
  /** Base64-encoded PNG of the WKWebView viewport. */
  png_base64: string;
  /** Logical width of the captured image in points. */
  width: number;
  /** Logical height of the captured image in points. */
  height: number;
  /** Backing-store scale factor (e.g. 2.0 on a Retina display). */
  scale: number;
}

/** Result returned by browser.bridge.evaluate (CLAUDE_EYES_FORK). */
export interface BridgeEvaluateResult {
  /**
   * JSON-serialized representation of the JS expression result.
   * Always valid JSON; primitives serialize directly.
   */
  result_json: string;
  /**
   * JavaScript typeof-derived type tag for the result.
   * One of: "string" | "number" | "boolean" | "object" | "undefined" | "null".
   */
  type: string;
}

/** Result returned by browser.bridge.dom (CLAUDE_EYES_FORK). */
export interface BridgeDomResult {
  /** Full outer HTML of document.documentElement. */
  html: string;
}

/** Result returned by browser.bridge.set_viewport (CLAUDE_EYES_FORK). */
export interface BridgeSetViewportResult {
  ok: true;
  /** Actual frame width applied to the WKWebView after layout (in points). */
  applied_width: number;
  /** Actual frame height applied to the WKWebView after layout (in points). */
  applied_height: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CmuxError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "CmuxError";
  }
}

export class CmuxTimeoutError extends CmuxError {
  constructor(method: string, timeoutMs: number) {
    super(`cmux: method "${method}" timed out after ${timeoutMs}ms`);
    this.name = "CmuxTimeoutError";
  }
}

export class CmuxNotImplementedError extends CmuxError {
  constructor(method: string) {
    super(
      `cmux: method "${method}" requires a patched fork. Set CLAUDE_EYES_FORK=true to enable.`,
    );
    this.name = "CmuxNotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// Socket path resolver
// ---------------------------------------------------------------------------

function resolveSocketPath(): string | null {
  const fromEnv = process.env["CMUX_SOCKET_PATH"];
  if (fromEnv) return fromEnv;

  if (existsSync(MARKER_FILE)) {
    try {
      const addr = readFileSync(MARKER_FILE, "utf8").trim();
      if (addr.length > 0) return addr;
    } catch {
      // fall through
    }
  }

  if (existsSync(DEFAULT_SOCKET)) return DEFAULT_SOCKET;
  if (existsSync(LEGACY_SOCKET)) return LEGACY_SOCKET;

  return null;
}

// ---------------------------------------------------------------------------
// Phase-4 guard
// ---------------------------------------------------------------------------

function requireFork(method: string): void {
  const flag = process.env["CLAUDE_EYES_FORK"];
  if (flag !== "true" && flag !== "1") {
    throw new CmuxNotImplementedError(method);
  }
}

// ---------------------------------------------------------------------------
// CLI fallback helper
// ---------------------------------------------------------------------------

async function sendViaCli<R>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<R> {
  const paramsJson = JSON.stringify(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { stdout } = await execFileAsync(
      "cmux-cli",
      ["rpc", method, paramsJson],
      { signal: controller.signal, encoding: "utf8" },
    );
    clearTimeout(timer);

    const raw: unknown = JSON.parse(stdout.trim());
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("ok" in raw)
    ) {
      throw new CmuxError(`cmux-cli: unexpected response shape for "${method}"`);
    }
    const response = raw as V2Response<R>;
    if (!response.ok) {
      throw new CmuxError(
        response.error.message,
        response.error.code,
        response.error.data,
      );
    }
    return response.result;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof CmuxError) throw err;
    if (
      err instanceof Error &&
      err.name === "AbortError"
    ) {
      throw new CmuxTimeoutError(method, timeoutMs);
    }
    throw new CmuxError(
      `cmux-cli exec failed for "${method}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// CmuxClient
// ---------------------------------------------------------------------------

export class CmuxClient {
  private socket: Socket | null = null;
  private readonly timeoutMs: number;

  /** Line buffer for partial reads. */
  private buffer = "";

  /** Pending in-flight requests keyed by request id. */
  private readonly pending = new Map<
    string,
    {
      resolve: (line: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Whether to always use the CLI fallback (no socket available). */
  private useCli = false;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // connect / close
  // -------------------------------------------------------------------------

  /**
   * Connect to the cmux socket.  If the socket path cannot be resolved the
   * client falls back to the `cmux-cli` binary for every subsequent send().
   *
   * SECURITY FIX (F4 audit blocker #2): when CMUX_PASSWORD env is set, sends
   * `auth.login` (V2) immediately after connect, before any command. Cmux's
   * password mode is opt-in; we honor it when the user enables it.
   */
  async connect(): Promise<void> {
    const socketPath = resolveSocketPath();

    if (!socketPath) {
      this.useCli = true;
      return;
    }

    await new Promise<void>((resolve) => {
      const sock = createConnection(socketPath);

      const onError = (_err: Error): void => {
        // Socket unreachable — degrade to CLI fallback silently.
        sock.destroy();
        this.useCli = true;
        resolve();
      };

      const onConnect = (): void => {
        sock.removeListener("error", onError);
        this.socket = sock;
        this._attachReadLoop(sock);
        resolve();
      };

      sock.once("connect", onConnect);
      sock.once("error", onError);

      sock.on("close", () => {
        this._rejectAllPending(new CmuxError("cmux: socket closed unexpectedly"));
        this.socket = null;
      });
    });

    // After socket is up (not CLI-fallback), authenticate if password configured.
    if (this.socket && !this.useCli) {
      const password = process.env["CMUX_PASSWORD"];
      if (password && password.length > 0) {
        try {
          await this.send<unknown>("auth.login", { password });
        } catch (err) {
          // Fail loud — wrong password is a misconfiguration, not a runtime quirk.
          throw new CmuxError(
            `cmux: auth.login failed (${err instanceof Error ? err.message : String(err)})`
          );
        }
      }
    }
  }

  /** Close the socket connection and cancel all pending requests. */
  close(): void {
    this._rejectAllPending(new CmuxError("cmux: client closed"));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = "";
  }

  // -------------------------------------------------------------------------
  // Core send
  // -------------------------------------------------------------------------

  /**
   * Send a V2 JSON-RPC command and return the typed result.
   * Enforces the configured timeout.  Routes through CLI if socket unavailable.
   */
  async send<R>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<R> {
    if (this.useCli || !this.socket) {
      return sendViaCli<R>(method, params, this.timeoutMs);
    }

    const id = randomUUID();
    const request: V2Request = { id, method, params };
    const line = JSON.stringify(request) + "\n";

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CmuxTimeoutError(method, this.timeoutMs));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (rawLine: string) => {
          clearTimeout(timer);
          try {
            const parsed: unknown = JSON.parse(rawLine);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("ok" in parsed)
            ) {
              reject(new CmuxError(`cmux: malformed response for "${method}"`));
              return;
            }
            const response = parsed as V2Response<R>;
            if (!response.ok) {
              reject(
                new CmuxError(
                  response.error.message,
                  response.error.code,
                  response.error.data,
                ),
              );
              return;
            }
            resolve(response.result);
          } catch (parseErr) {
            reject(
              new CmuxError(
                `cmux: JSON parse error for "${method}": ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              ),
            );
          }
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      this.socket!.write(line, (writeErr) => {
        if (writeErr) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            entry.reject(
              new CmuxError(`cmux: write error for "${method}": ${writeErr.message}`),
            );
          }
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // High-level helpers
  // -------------------------------------------------------------------------

  /**
   * Navigate the given browser surface to `url`.
   * Wraps browser.navigate.
   */
  async openUrl(surfaceId: string, url: string): Promise<NavigateResult> {
    return this.send<NavigateResult>("browser.navigate", {
      surface_id: surfaceId,
      url,
    });
  }

  /**
   * List browser tabs for the given surface.
   * Wraps browser.tab.list.
   */
  async listTabs(surfaceId: string): Promise<Tab[]> {
    const result = await this.send<TabListResult>("browser.tab.list", {
      surface_id: surfaceId,
    });
    return result.tabs;
  }

  /**
   * Get the bounding box (getBoundingClientRect) for a CSS selector within a
   * browser surface.
   *
   * PHASE-4: this command requires a patched cmux fork.
   * It will throw CmuxNotImplementedError unless CLAUDE_EYES_FORK=true.
   */
  async getGeometry(surfaceId: string, selector: string): Promise<BoundingBox> {
    requireFork("browser.get.box");
    return this.send<BoundingBox>("browser.get.box", {
      surface_id: surfaceId,
      selector,
    });
  }

  // -------------------------------------------------------------------------
  // Claude Eyes bridge commands (CLAUDE_EYES_FORK)
  // These wrap the browser.bridge.* endpoints added in sprint 2 of the
  // cmux fork. They require a patched cmux build; the daemon uses these
  // only when CLAUDE_EYES_FORK=true (useBridge=true in DaemonConfig).
  // -------------------------------------------------------------------------

  /**
   * Capture a PNG snapshot of the WKWebView viewport for the given tab.
   * Wraps browser.bridge.snapshot.
   *
   * @param tabId - UUID of the cmux surface / BrowserPanel to capture.
   *   Omit to default to the currently focused browser surface.
   * @returns BridgeSnapshotCommandResult: { png_base64, width, height, scale }
   */
  async bridgeSnapshot(tabId?: string): Promise<BridgeSnapshotCommandResult> {
    const params: Record<string, unknown> = {};
    if (tabId !== undefined) params["tab_id"] = tabId;
    return this.send<BridgeSnapshotCommandResult>(
      "browser.bridge.snapshot",
      params,
    );
  }

  /**
   * Evaluate a JavaScript expression inside the given browser tab.
   * Wraps browser.bridge.evaluate.
   *
   * Defaults to the isolated client world (WKContentWorld.defaultClient)
   * so the expression runs isolated from the page JS. Pass world="page"
   * to opt in to the page world (use only when strictly needed).
   *
   * @param tabId - UUID of the target surface. Omit to use the focused surface.
   * @param js    - JavaScript source string to evaluate.
   * @param world - "isolated" (default) | "page".
   * @returns BridgeEvaluateResult: { result_json, type }
   */
  async bridgeEvaluate(
    tabId: string | undefined,
    js: string,
    world: "isolated" | "page" = "isolated",
  ): Promise<BridgeEvaluateResult> {
    const params: Record<string, unknown> = { js };
    if (tabId !== undefined) params["tab_id"] = tabId;
    if (world === "page") params["world"] = "page";
    return this.send<BridgeEvaluateResult>("browser.bridge.evaluate", params);
  }

  /**
   * Fetch the outer HTML of the current document in the given browser tab.
   * Wraps browser.bridge.dom.
   *
   * @param tabId - UUID of the target surface. Omit to use the focused surface.
   * @returns BridgeDomResult: { html }
   */
  async bridgeDom(tabId?: string): Promise<BridgeDomResult> {
    const params: Record<string, unknown> = {};
    if (tabId !== undefined) params["tab_id"] = tabId;
    return this.send<BridgeDomResult>("browser.bridge.dom", params);
  }

  /**
   * Resize the WKWebView CSS viewport for the given browser tab.
   * Wraps browser.bridge.set_viewport.
   *
   * @param tabId  - UUID of the target surface. Omit to use the focused surface.
   * @param width  - Target logical width in CSS points (must be > 0).
   * @param height - Target logical height in CSS points (must be > 0).
   * @param dpr    - Optional device-pixel-ratio override (defaults to 1 in cmux).
   * @returns BridgeSetViewportResult: { ok: true, applied_width, applied_height }
   */
  async bridgeSetViewport(
    tabId: string | undefined,
    width: number,
    height: number,
    dpr?: number,
  ): Promise<BridgeSetViewportResult> {
    const params: Record<string, unknown> = { width, height };
    if (tabId !== undefined) params["tab_id"] = tabId;
    if (dpr !== undefined) params["dpr"] = dpr;
    return this.send<BridgeSetViewportResult>(
      "browser.bridge.set_viewport",
      params,
    );
  }

  // -------------------------------------------------------------------------
  // Read loop internals
  // -------------------------------------------------------------------------

  private _attachReadLoop(sock: Socket): void {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this._dispatchLine(line.trim());
      }
    });
  }

  private _dispatchLine(line: string): void {
    if (line.length === 0) return;

    // Try to extract the id without fully parsing (fast path for error branch).
    let id: string | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
        const raw = (parsed as Record<string, unknown>)["id"];
        if (typeof raw === "string") id = raw;
      }
    } catch {
      // Not valid JSON — ignore stray line.
      return;
    }

    if (!id) return;

    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    entry.resolve(line);
  }

  private _rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
