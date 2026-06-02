/**
 * cmux-client.test.ts
 *
 * Unit tests for CmuxClient.
 * Uses node:test + node:assert.  Run with:
 *   npx tsx --test tests/cmux-client.test.ts
 *
 * No live cmux process required — tests use a fake in-process Unix-socket
 * server, or validate CLI-fallback / error paths directly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

import {
  CmuxClient,
  CmuxError,
  CmuxTimeoutError,
  CmuxNotImplementedError,
} from "../bridge/cmux-client.js";

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface FakeServer {
  server: Server;
  /** Forcefully destroy all open client sockets + close the server. */
  destroy: () => Promise<void>;
}

function tmpSocketPath(): string {
  return join(
    tmpdir(),
    `claude-eyes-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

/**
 * Minimal fake cmux socket server that speaks the V2 JSON-RPC line protocol.
 * Tracks open client sockets so `destroy()` can clean them up immediately.
 */
function createFakeServer(
  socketPath: string,
  handler: (
    method: string,
    params: Record<string, unknown>,
    id: string,
  ) => unknown,
): Promise<FakeServer> {
  const clientSockets = new Set<NetSocket>();

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
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
            const req = JSON.parse(line) as {
              id: string;
              method: string;
              params: Record<string, unknown>;
            };
            id = req.id;
            // Handler may be sync or return a promise.
            Promise.resolve(handler(req.method, req.params, req.id))
              .then((result) => {
                if (!socket.destroyed) {
                  socket.write(
                    JSON.stringify({ ok: true, id, result }) + "\n",
                  );
                }
              })
              .catch((err: unknown) => {
                const msg =
                  err instanceof Error ? err.message : String(err);
                if (!socket.destroyed) {
                  socket.write(
                    JSON.stringify({
                      ok: false,
                      id,
                      error: { code: -32_000, message: msg },
                    }) + "\n",
                  );
                }
              });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            socket.write(
              JSON.stringify({
                ok: false,
                id,
                error: { code: -32_000, message: msg },
              }) + "\n",
            );
          }
        }
      });
    });

    const destroy = (): Promise<void> => {
      for (const sock of clientSockets) {
        sock.destroy();
      }
      return new Promise<void>((res) => {
        server.close(() => res());
        // Forceful: if close() doesn't fire quickly, resolve anyway.
        setTimeout(res, 200);
      });
    };

    server.once("error", reject);
    server.listen(socketPath, () => resolve({ server, destroy }));
  });
}

// ---------------------------------------------------------------------------
// Suite: instantiation
// ---------------------------------------------------------------------------

describe("CmuxClient — instantiation", () => {
  it("constructs without arguments", () => {
    const client = new CmuxClient();
    assert.ok(client instanceof CmuxClient);
  });

  it("constructs with a custom timeoutMs option", () => {
    const client = new CmuxClient({ timeoutMs: 1_000 });
    assert.ok(client instanceof CmuxClient);
  });

  it("close() is idempotent when never connected", () => {
    const client = new CmuxClient();
    client.close();
    client.close();
    // No throw = pass.
  });
});

// ---------------------------------------------------------------------------
// Suite: CLI fallback (no socket)
// ---------------------------------------------------------------------------

describe("CmuxClient — CLI fallback / no-socket path", () => {
  it("connect() resolves even when socket path does not exist", async () => {
    const saved = process.env["CMUX_SOCKET_PATH"];
    process.env["CMUX_SOCKET_PATH"] =
      "/tmp/claude-eyes-nonexistent-socket-xyzzy.sock";

    const client = new CmuxClient();
    await client.connect(); // must not reject
    client.close();

    if (saved === undefined) {
      delete process.env["CMUX_SOCKET_PATH"];
    } else {
      process.env["CMUX_SOCKET_PATH"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: socket round-trip (mock-encode)
// ---------------------------------------------------------------------------

describe("CmuxClient — socket round-trip", () => {
  let socketPath: string;
  let fake: FakeServer;
  let client: CmuxClient;

  before(async () => {
    socketPath = tmpSocketPath();
    fake = await createFakeServer(socketPath, (method, _params) => {
      switch (method) {
        case "system.ping":
          return { pong: true };
        case "browser.navigate":
          return {
            workspace_id: "ws-1",
            workspace_ref: "workspace-1",
            surface_id: "sf-1",
            surface_ref: "surface-1",
            window_id: "win-1",
            window_ref: "window-1",
          };
        case "browser.tab.list":
          return {
            tabs: [
              {
                tab_id: "t1",
                url: "http://localhost:3000",
                title: "Dev Server",
                active: true,
              },
              {
                tab_id: "t2",
                url: "http://localhost:3000/about",
                title: "About",
                active: false,
              },
            ],
          };
        default:
          throw new Error(`unknown method: ${method}`);
      }
    });

    process.env["CMUX_SOCKET_PATH"] = socketPath;
    client = new CmuxClient();
    await client.connect();
  });

  after(async () => {
    client.close();
    await fake.destroy();
    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  it("send<{pong:boolean}>('system.ping') returns {pong:true}", async () => {
    const result = await client.send<{ pong: boolean }>("system.ping", {});
    assert.deepEqual(result, { pong: true });
  });

  it("openUrl() wraps browser.navigate and returns NavigateResult", async () => {
    const result = await client.openUrl("sf-1", "http://localhost:3000");
    assert.equal(result.surface_id, "sf-1");
    assert.equal(result.workspace_id, "ws-1");
  });

  it("listTabs() wraps browser.tab.list and returns Tab[]", async () => {
    const tabs = await client.listTabs("sf-1");
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0]?.tab_id, "t1");
    assert.equal(tabs[1]?.url, "http://localhost:3000/about");
  });

  it("send() with an unknown method surfaces CmuxError from server envelope", async () => {
    await assert.rejects(
      () => client.send("nonexistent.method", {}),
      (err: unknown) => {
        assert.ok(err instanceof CmuxError, `expected CmuxError, got ${err}`);
        assert.ok(
          err.message.includes("unknown method"),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("JSON wire encoding round-trip preserves nested params", async () => {
    // Use a fresh server that captures what it receives.
    const capturePath = tmpSocketPath();
    const captured: Record<string, unknown>[] = [];
    const capFake = await createFakeServer(capturePath, (_method, params) => {
      captured.push(params);
      return { pong: true };
    });

    const savedSocket = process.env["CMUX_SOCKET_PATH"];
    process.env["CMUX_SOCKET_PATH"] = capturePath;
    const capClient = new CmuxClient();
    await capClient.connect();

    await capClient.send("system.ping", {
      nested: { array: [1, 2, 3], flag: true },
      str: "hello",
    });

    capClient.close();
    await capFake.destroy();
    if (existsSync(capturePath)) rmSync(capturePath);

    if (savedSocket === undefined) {
      delete process.env["CMUX_SOCKET_PATH"];
    } else {
      process.env["CMUX_SOCKET_PATH"] = savedSocket;
    }

    assert.equal(captured.length, 1);
    const p = captured[0];
    assert.ok(p !== undefined);
    assert.deepEqual(p["nested"], { array: [1, 2, 3], flag: true });
    assert.equal(p["str"], "hello");
  });
});

// ---------------------------------------------------------------------------
// Suite: timeout
// ---------------------------------------------------------------------------

describe("CmuxClient — timeout", () => {
  let socketPath: string;
  let fake: FakeServer;

  before(async () => {
    socketPath = tmpSocketPath();
    // Server that never replies (simulates stalled cmux).
    fake = await createFakeServer(socketPath, () => {
      // Returning a never-settling promise means no response is written.
      // We rely on destroy() to cut connections after the test.
      return new Promise(() => {
        /* intentionally never resolves */
      });
    });
    process.env["CMUX_SOCKET_PATH"] = socketPath;
  });

  after(async () => {
    await fake.destroy();
    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  it("throws CmuxTimeoutError when server does not respond within timeoutMs", async () => {
    const client = new CmuxClient({ timeoutMs: 80 });
    await client.connect();

    try {
      await assert.rejects(
        () => client.send("system.ping", {}),
        (err: unknown) => {
          assert.ok(
            err instanceof CmuxTimeoutError,
            `expected CmuxTimeoutError, got ${err instanceof Error ? err.constructor.name + ": " + err.message : String(err)}`,
          );
          assert.ok(
            err.message.includes("system.ping"),
            `message should name the method: ${err.message}`,
          );
          assert.ok(
            err.message.includes("80ms"),
            `message should include timeout value: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: Phase-4 guard (getGeometry)
// ---------------------------------------------------------------------------

describe("CmuxClient — Phase-4 guard (getGeometry)", () => {
  let socketPath: string;
  let fake: FakeServer;
  let client: CmuxClient;

  before(async () => {
    socketPath = tmpSocketPath();
    fake = await createFakeServer(socketPath, (method) => {
      if (method === "browser.get.box") {
        return { x: 0, y: 0, width: 1280, height: 768 };
      }
      return {};
    });
    process.env["CMUX_SOCKET_PATH"] = socketPath;
    client = new CmuxClient();
    await client.connect();
  });

  after(async () => {
    client.close();
    await fake.destroy();
    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  it("throws CmuxNotImplementedError when CLAUDE_EYES_FORK is unset", async () => {
    const saved = process.env["CLAUDE_EYES_FORK"];
    delete process.env["CLAUDE_EYES_FORK"];

    try {
      await assert.rejects(
        () => client.getGeometry("sf-1", "body"),
        (err: unknown) => {
          assert.ok(
            err instanceof CmuxNotImplementedError,
            `expected CmuxNotImplementedError, got ${err}`,
          );
          assert.ok(
            err.message.includes("browser.get.box"),
            `message should name the method: ${err.message}`,
          );
          assert.ok(
            err.message.includes("CLAUDE_EYES_FORK"),
            `message should mention env var: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      if (saved === undefined) {
        delete process.env["CLAUDE_EYES_FORK"];
      } else {
        process.env["CLAUDE_EYES_FORK"] = saved;
      }
    }
  });

  it("proceeds and returns BoundingBox when CLAUDE_EYES_FORK=true", async () => {
    const saved = process.env["CLAUDE_EYES_FORK"];
    process.env["CLAUDE_EYES_FORK"] = "true";

    try {
      const box = await client.getGeometry("sf-1", "body");
      assert.equal(box.width, 1280);
      assert.equal(box.height, 768);
      assert.equal(box.x, 0);
      assert.equal(box.y, 0);
    } finally {
      if (saved === undefined) {
        delete process.env["CLAUDE_EYES_FORK"];
      } else {
        process.env["CLAUDE_EYES_FORK"] = saved;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: close() cancels pending sends
// ---------------------------------------------------------------------------

describe("CmuxClient — close() cancels pending sends", () => {
  it("rejects in-flight sends with CmuxError when close() is called", async () => {
    const socketPath = tmpSocketPath();
    const fake = await createFakeServer(socketPath, () => {
      return new Promise(() => {
        /* stall */
      });
    });
    process.env["CMUX_SOCKET_PATH"] = socketPath;

    const client = new CmuxClient({ timeoutMs: 30_000 });
    await client.connect();

    const sendPromise = client.send("system.ping", {});

    // Close before the (stalled) server can reply.
    client.close();

    try {
      await assert.rejects(
        () => sendPromise,
        (err: unknown) => {
          assert.ok(err instanceof CmuxError, `expected CmuxError, got ${err}`);
          return true;
        },
      );
    } finally {
      await fake.destroy();
      delete process.env["CMUX_SOCKET_PATH"];
      if (existsSync(socketPath)) rmSync(socketPath);
    }
  });
});
