/**
 * daemon/server.ts — lightweight HTTP server for the daemon API.
 *
 * Endpoints:
 *   GET  /healthz    → HealthResponse (200 always while process is alive)
 *   GET  /latest     → WorkerOutput   (200)
 *   POST /snapshot   → WorkerOutput   (200 — triggers an immediate capture)
 */
import * as http from "node:http";
import type { HealthResponse, WorkerOutput } from "@contracts/index.js";
import { ensureAuthKey, validateRequest } from "./auth.js";

/** Callback invoked by POST /snapshot to request an immediate capture. */
export type SnapshotTrigger = () => Promise<WorkerOutput>;

/** Callback invoked by GET /latest to return the most recent WorkerOutput. */
export type LatestReader = () => WorkerOutput;

/** Callback invoked by GET /healthz to return health info. */
export type HealthReader = () => HealthResponse;

export interface DaemonServerOptions {
  host: string;
  port: number;
  onSnapshot: SnapshotTrigger;
  onLatest: LatestReader;
  onHealth: HealthReader;
}

/** Start the HTTP daemon server and return the http.Server instance. */
export function createDaemonServer(opts: DaemonServerOptions): http.Server {
  const { host, port, onSnapshot, onLatest, onHealth } = opts;
  const authKey = ensureAuthKey();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    const send = (
      status: number,
      body: unknown
    ): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    const notFound = (): void => {
      send(404, { error: "Not found", path: url });
    };

    // SECURITY FIX: require X-Eyes-Key on every endpoint except /healthz (which
    // is useful for ping-style liveness without leaking frames).
    if (url !== "/healthz" && !validateRequest(req, authKey)) {
      send(401, { error: "unauthorized", hint: "missing or invalid X-Eyes-Key header" });
      return;
    }

    if (url === "/healthz" && method === "GET") {
      send(200, onHealth());
      return;
    }

    if (url === "/latest" && method === "GET") {
      send(200, onLatest());
      return;
    }

    if (url === "/snapshot" && method === "POST") {
      // Read optional JSON body (ignored if malformed)
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        void (async () => {
          const result = await onSnapshot();
          send(200, result);
        })();
      });
      return;
    }

    notFound();
  });

  server.listen(port, host);
  return server;
}
