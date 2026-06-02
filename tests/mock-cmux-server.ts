/**
 * mock-cmux-server.ts
 *
 * A minimal in-process Unix-socket server that speaks the cmux V2
 * JSON-RPC line protocol and returns canned responses for the four
 * claude-eyes bridge commands added in sprint 2:
 *
 *   browser.bridge.snapshot   -> { png_base64, width, height, scale }
 *   browser.bridge.evaluate   -> { result_json, type }
 *   browser.bridge.dom        -> { html }
 *   browser.bridge.set_viewport -> { ok: true, applied_width, applied_height }
 *
 * Usage (from tests):
 *   const mock = await startMockCmuxServer(socketPath);
 *   // ... run assertions ...
 *   await mock.stop();
 */

import { createServer, type Server, type Socket as NetSocket } from "node:net";

// ---------------------------------------------------------------------------
// Canned response payloads
// ---------------------------------------------------------------------------

/** Canned PNG base64 — a 1x1 transparent pixel, base64-encoded. */
export const CANNED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const CANNED_SNAPSHOT = {
  png_base64: CANNED_PNG_BASE64,
  width: 1280,
  height: 800,
  scale: 2.0,
};

export const CANNED_EVALUATE = {
  result_json: '"hello from isolated world"',
  type: "string",
};

export const CANNED_DOM = {
  html: "<html><head></head><body><h1>Mock page</h1></body></html>",
};

export const CANNED_SET_VIEWPORT = {
  ok: true as const,
  applied_width: 1280,
  applied_height: 800,
};

// ---------------------------------------------------------------------------
// Wire-protocol types
// ---------------------------------------------------------------------------

interface V2Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type HandlerFn = (
  method: string,
  params: Record<string, unknown>,
  id: string,
) => unknown;

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

export interface MockCmuxServer {
  /** Stop the server and destroy all open client sockets. */
  stop: () => Promise<void>;
  /** Number of requests handled since start. */
  requestCount: () => number;
}

/**
 * Start a mock cmux socket server bound to `socketPath`.
 *
 * The server handles the four browser.bridge.* methods with canned payloads,
 * and returns a minimal error for any other method so the test can verify
 * unknown-method error propagation.
 *
 * @param socketPath   - Absolute path for the AF_UNIX socket (caller must ensure
 *                       the path does not exist yet, or clean it up before calling).
 * @param customHandler - Optional override; if provided, replaces the default
 *                        canned-response logic entirely.
 */
export function startMockCmuxServer(
  socketPath: string,
  customHandler?: HandlerFn,
): Promise<MockCmuxServer> {
  const clientSockets = new Set<NetSocket>();
  let handled = 0;

  const defaultHandler: HandlerFn = (method, _params, _id) => {
    switch (method) {
      case "system.ping":
        return { pong: true };

      case "browser.bridge.snapshot":
        return CANNED_SNAPSHOT;

      case "browser.bridge.evaluate":
        return CANNED_EVALUATE;

      case "browser.bridge.dom":
        return CANNED_DOM;

      case "browser.bridge.set_viewport":
        return CANNED_SET_VIEWPORT;

      default:
        throw new Error(`mock-cmux: unknown method "${method}"`);
    }
  };

  const handler = customHandler ?? defaultHandler;

  return new Promise<MockCmuxServer>((resolve, reject) => {
    const server: Server = createServer((socket: NetSocket) => {
      clientSockets.add(socket);
      socket.once("close", () => clientSockets.delete(socket));

      let buf = "";
      socket.setEncoding("utf8");

      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          let id = "?";
          try {
            const req = JSON.parse(line) as V2Request;
            id = req.id;
            handled++;

            Promise.resolve(handler(req.method, req.params, req.id))
              .then((result) => {
                if (!socket.destroyed) {
                  socket.write(
                    JSON.stringify({ ok: true, id, result }) + "\n",
                  );
                }
              })
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (!socket.destroyed) {
                  socket.write(
                    JSON.stringify({
                      ok: false,
                      id,
                      error: { code: -32000, message: msg },
                    }) + "\n",
                  );
                }
              });
          } catch (parseErr: unknown) {
            const msg =
              parseErr instanceof Error ? parseErr.message : String(parseErr);
            if (!socket.destroyed) {
              socket.write(
                JSON.stringify({
                  ok: false,
                  id,
                  error: { code: -32700, message: `JSON parse error: ${msg}` },
                }) + "\n",
              );
            }
          }
        }
      });
    });

    const stop = (): Promise<void> => {
      for (const sock of clientSockets) {
        sock.destroy();
      }
      return new Promise<void>((res) => {
        server.close(() => res());
        // Safety: resolve even if close doesn't fire promptly.
        setTimeout(res, 300);
      });
    };

    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({ stop, requestCount: () => handled });
    });
  });
}
