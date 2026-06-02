/**
 * bridge/index.ts — thin adapter that talks to the cmux runtime over its
 * Unix-domain socket API and pulls browser screenshots via browser.screenshot.
 *
 * When FORK=true the daemon calls bridge.snapshot() instead of ScreenCapturer.
 * This module is stateless: construct a new BridgeClient per session or reuse
 * one and call snapshot() at will.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { BridgeSnapshotResult } from "@contracts/index.js";

// ---------------------------------------------------------------------------
// JSON-RPC shape (v2 cmux socket protocol)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// BridgeClient
// ---------------------------------------------------------------------------

/** Options accepted by BridgeClient constructor. */
export interface BridgeClientOptions {
  /** Absolute path to the cmux Unix-domain socket. */
  socketPath: string;
  /**
   * Surface ID to target (e.g. "surface:7").
   * If omitted, the client uses system.identify to find the focused browser surface.
   */
  surfaceId?: string;
  /** Request timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
}

/**
 * Thin adapter over the cmux socket API.
 * Exposes only the subset needed by the claude-eyes daemon.
 */
export class BridgeClient {
  private readonly socketPath: string;
  private readonly surfaceId: string | null;
  private readonly timeoutMs: number;
  private seq = 0;

  constructor(opts: BridgeClientOptions) {
    this.socketPath = opts.socketPath;
    this.surfaceId = opts.surfaceId ?? null;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Capture a screenshot of the active cmux browser surface.
   * Returns a PNG buffer on success, or an error description on failure.
   */
  async snapshot(): Promise<BridgeSnapshotResult> {
    try {
      // Resolve surface id if not provided
      const surfaceId = this.surfaceId ?? (await this.resolveFocusedSurface());
      if (surfaceId === null) {
        return { ok: false, error: "No focused browser surface found in cmux" };
      }

      // Call browser.bridge.snapshot (CLAUDE_EYES_FORK endpoint) which returns
      // a base64-encoded PNG together with logical dimensions and scale factor.
      const result = await this.call("browser.bridge.snapshot", {
        tab_id: surfaceId,
      });

      if (
        typeof result !== "object" ||
        result === null ||
        !("png_base64" in result)
      ) {
        return { ok: false, error: "Unexpected browser.bridge.snapshot response shape" };
      }

      const record = result as Record<string, unknown>;
      const png_base64 = record["png_base64"];
      if (typeof png_base64 !== "string") {
        return { ok: false, error: "browser.bridge.snapshot response.png_base64 is not a string" };
      }

      const pngBuffer = Buffer.from(png_base64, "base64");
      const width = typeof record["width"] === "number" ? record["width"] : 0;
      const height =
        typeof record["height"] === "number" ? record["height"] : 0;

      return { ok: true, pngBuffer, width, height };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Capture a screenshot of an arbitrary URL via the cmux bridge.
   * Implementation strategy: call `browser.screenshot` with `url:` param so
   * the cmux runtime can route the request to an off-screen/auxiliary surface.
   * On fork builds without URL support, the runtime falls back to opening
   * a transient browser surface.
   *
   * Returns a PNG buffer on success, or an error description on failure.
   */
  async snapshotUrl(url: string): Promise<BridgeSnapshotResult> {
    try {
      const result = await this.call("browser.screenshot", {
        url,
        full_page: false,
      });

      if (
        typeof result !== "object" ||
        result === null ||
        !("data" in result)
      ) {
        return { ok: false, error: "Unexpected browser.screenshot response shape" };
      }

      const record = result as Record<string, unknown>;
      const data = record["data"];
      if (typeof data !== "string") {
        return { ok: false, error: "browser.screenshot response.data is not a string" };
      }

      const pngBuffer = Buffer.from(data, "base64");
      const width = typeof record["width"] === "number" ? record["width"] : 0;
      const height =
        typeof record["height"] === "number" ? record["height"] : 0;

      return { ok: true, pngBuffer, width, height };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Resize the cmux browser surface (and the WKWebView CSS viewport) to
   * `width × height`. Wraps `browser.set_viewport` on the cmux runtime.
   *
   * F5 E-1: called before snapshot() to take the same page at multiple device
   * tiers (mobile / tablet / desktop) without reloading the WKWebView. The
   * surface_id is reused across calls so the page session, scroll position
   * and JS state are preserved between viewport changes.
   */
  async setViewport(
    width: number,
    height: number,
    surfaceId?: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const sid =
        surfaceId ?? this.surfaceId ?? (await this.resolveFocusedSurface());
      if (sid === null) {
        return {
          ok: false,
          error: "No focused browser surface found in cmux",
        };
      }
      await this.call("browser.bridge.set_viewport", {
        tab_id: sid,
        width,
        height,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Resolve the currently focused browser surface ID via system.identify.
   * Returns null when no browser surface is focused.
   */
  async resolveFocusedSurface(): Promise<string | null> {
    try {
      const result = await this.call("system.identify", {});
      if (
        typeof result !== "object" ||
        result === null
      ) {
        return null;
      }
      const record = result as Record<string, unknown>;
      const focused = record["focused"];
      if (
        typeof focused !== "object" ||
        focused === null
      ) {
        return null;
      }
      const f = focused as Record<string, unknown>;
      const surfaceType = f["surface_type"];
      if (surfaceType !== "browser") return null;
      const surfaceId = f["surface_id"];
      return typeof surfaceId === "string" ? surfaceId : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private nextId(): number {
    return ++this.seq;
  }

  /**
   * Send a single JSON-RPC call over the cmux socket and return the result.
   * Opens a fresh connection per call (cmux socket is stateless for individual calls).
   */
  private call(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!fs.existsSync(this.socketPath)) {
        reject(new Error(`cmux socket not found: ${this.socketPath}`));
        return;
      }

      const id = this.nextId();
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const socket = net.createConnection(this.socketPath);
      let rawData = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`Timeout waiting for ${method} (${this.timeoutMs}ms)`));
        }
      }, this.timeoutMs);

      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };

      socket.on("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        rawData += chunk.toString("utf8");
        // cmux responses are newline-delimited JSON
        const lines = rawData.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = (lines[i] ?? "").trim();
          if (!line) continue;
          try {
            const parsed: JsonRpcResponse = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) {
              if (parsed.error !== undefined) {
                settle(() => {
                  reject(
                    new Error(
                      `${method} error ${parsed.error!.code}: ${parsed.error!.message}`
                    )
                  );
                });
              } else {
                settle(() => {
                  resolve(parsed.result);
                });
              }
              socket.destroy();
            }
          } catch {
            // partial line — keep buffering
          }
        }
        rawData = lines[lines.length - 1] ?? "";
      });

      socket.on("error", (err: Error) => {
        settle(() => {
          reject(err);
        });
      });

      socket.on("close", () => {
        settle(() => {
          reject(new Error(`Socket closed before response for ${method}`));
        });
      });

      // Resolve relative socket paths
      void path.resolve(this.socketPath);
    });
  }
}

// ---------------------------------------------------------------------------
// Default export: factory for ergonomic usage in daemon
// ---------------------------------------------------------------------------

/**
 * Create a BridgeClient from environment variables.
 * Reads CMUX_SOCKET_PATH (or CMUX_SOCKET) and CMUX_SURFACE_ID.
 */
export function createBridgeFromEnv(): BridgeClient {
  const socketPath =
    process.env["CMUX_SOCKET_PATH"] ??
    process.env["CMUX_SOCKET"] ??
    "/tmp/cmux.sock";
  const surfaceId = process.env["CMUX_SURFACE_ID"] ?? undefined;
  return new BridgeClient({ socketPath, surfaceId });
}
