/**
 * fork-smoke.test.ts
 *
 * Phase E smoke test for the four new claude-eyes bridge commands.
 * Does NOT require a live cmux process — uses mock-cmux-server.ts.
 *
 * Run with:
 *   npx tsx --test tests/fork-smoke.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

import {
  startMockCmuxServer,
  CANNED_SNAPSHOT,
  CANNED_EVALUATE,
  CANNED_DOM,
  CANNED_SET_VIEWPORT,
  type MockCmuxServer,
} from "./mock-cmux-server.js";

import {
  CmuxClient,
  CmuxError,
  type BridgeSnapshotCommandResult,
  type BridgeEvaluateResult,
  type BridgeDomResult,
  type BridgeSetViewportResult,
} from "../bridge/cmux-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocketPath(): string {
  return join(
    tmpdir(),
    `fork-smoke-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.sock`,
  );
}

// ---------------------------------------------------------------------------
// Suite: mock-cmux-server basics
// ---------------------------------------------------------------------------

describe("mock-cmux-server — lifecycle", () => {
  it("starts, accepts a connection, and stops cleanly", async () => {
    const socketPath = tmpSocketPath();
    const mock = await startMockCmuxServer(socketPath);

    // Connect a client, confirm ping works.
    process.env["CMUX_SOCKET_PATH"] = socketPath;
    const client = new CmuxClient();
    await client.connect();

    const result = await client.send<{ pong: boolean }>("system.ping", {});
    assert.deepEqual(result, { pong: true });

    client.close();
    await mock.stop();

    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  it("requestCount() increments for each handled request", async () => {
    const socketPath = tmpSocketPath();
    const mock = await startMockCmuxServer(socketPath);

    process.env["CMUX_SOCKET_PATH"] = socketPath;
    const client = new CmuxClient();
    await client.connect();

    assert.equal(mock.requestCount(), 0);
    await client.send<{ pong: boolean }>("system.ping", {});
    assert.equal(mock.requestCount(), 1);
    await client.send<{ pong: boolean }>("system.ping", {});
    assert.equal(mock.requestCount(), 2);

    client.close();
    await mock.stop();
    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });
});

// ---------------------------------------------------------------------------
// Suite: browser.bridge.* smoke tests
// ---------------------------------------------------------------------------

describe("CmuxClient bridge commands — smoke tests via mock server", () => {
  let socketPath: string;
  let mock: MockCmuxServer;
  let client: CmuxClient;

  // Tab ID used throughout; real cmux would require a valid surface UUID.
  const TAB_ID = "11111111-2222-3333-4444-555555555555";

  before(async () => {
    socketPath = tmpSocketPath();
    mock = await startMockCmuxServer(socketPath);

    process.env["CMUX_SOCKET_PATH"] = socketPath;
    // The bridge methods don't call requireFork, so we don't need CLAUDE_EYES_FORK.
    client = new CmuxClient();
    await client.connect();
  });

  after(async () => {
    client.close();
    await mock.stop();
    delete process.env["CMUX_SOCKET_PATH"];
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  // ---- browser.bridge.snapshot ----

  it("bridgeSnapshot() returns { png_base64, width, height, scale }", async () => {
    const result: BridgeSnapshotCommandResult = await client.bridgeSnapshot(TAB_ID);

    assert.equal(typeof result.png_base64, "string");
    assert.ok(result.png_base64.length > 0, "png_base64 must be non-empty");
    assert.equal(result.png_base64, CANNED_SNAPSHOT.png_base64);

    assert.equal(typeof result.width, "number");
    assert.equal(typeof result.height, "number");
    assert.equal(typeof result.scale, "number");

    assert.equal(result.width, CANNED_SNAPSHOT.width);
    assert.equal(result.height, CANNED_SNAPSHOT.height);
    assert.equal(result.scale, CANNED_SNAPSHOT.scale);
  });

  it("bridgeSnapshot() works without explicit tabId (focused surface)", async () => {
    // Omit tabId — the mock doesn't care, it returns canned data regardless.
    const result: BridgeSnapshotCommandResult = await client.bridgeSnapshot();
    assert.equal(result.width, CANNED_SNAPSHOT.width);
    assert.equal(result.height, CANNED_SNAPSHOT.height);
    assert.equal(result.scale, CANNED_SNAPSHOT.scale);
    assert.ok(result.png_base64.length > 0);
  });

  it("bridgeSnapshot() png_base64 is valid base64", async () => {
    const result = await client.bridgeSnapshot(TAB_ID);
    // Valid base64 only contains A-Za-z0-9+/= and no whitespace outside padding.
    const b64re = /^[A-Za-z0-9+/]+=*$/;
    assert.ok(
      b64re.test(result.png_base64),
      `png_base64 is not valid base64: ${result.png_base64.slice(0, 40)}`,
    );
  });

  // ---- browser.bridge.evaluate ----

  it("bridgeEvaluate() returns { result_json, type }", async () => {
    const result: BridgeEvaluateResult = await client.bridgeEvaluate(
      TAB_ID,
      "document.title",
    );

    assert.equal(typeof result.result_json, "string");
    assert.equal(typeof result.type, "string");
    assert.equal(result.result_json, CANNED_EVALUATE.result_json);
    assert.equal(result.type, CANNED_EVALUATE.type);
  });

  it("bridgeEvaluate() result_json is parseable JSON", async () => {
    const result = await client.bridgeEvaluate(TAB_ID, "1 + 1");
    // result_json must be valid JSON (the spec says 'always valid JSON').
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.result_json);
    }, `result_json is not valid JSON: ${result.result_json}`);
    // The parsed value must match the JS typeof tag.
    assert.equal(typeof parsed, result.type === "null" ? "object" : result.type);
  });

  it("bridgeEvaluate() accepts world='isolated' (default)", async () => {
    // Default — no world param sent → canned response returned.
    const result = await client.bridgeEvaluate(TAB_ID, "window.location.href");
    assert.equal(result.type, CANNED_EVALUATE.type);
  });

  it("bridgeEvaluate() accepts world='page'", async () => {
    // page world — mock returns same canned data; we just verify no throw.
    const result = await client.bridgeEvaluate(
      TAB_ID,
      "document.body.innerHTML",
      "page",
    );
    assert.equal(typeof result.result_json, "string");
    assert.equal(typeof result.type, "string");
  });

  it("bridgeEvaluate() works without explicit tabId", async () => {
    const result = await client.bridgeEvaluate(undefined, "1 + 1");
    assert.equal(result.result_json, CANNED_EVALUATE.result_json);
  });

  // ---- browser.bridge.dom ----

  it("bridgeDom() returns { html } with non-empty string", async () => {
    const result: BridgeDomResult = await client.bridgeDom(TAB_ID);

    assert.equal(typeof result.html, "string");
    assert.ok(result.html.length > 0, "html must be non-empty");
    assert.equal(result.html, CANNED_DOM.html);
  });

  it("bridgeDom() html contains an html root element", async () => {
    const result = await client.bridgeDom(TAB_ID);
    assert.ok(
      result.html.includes("<html"),
      `expected html to contain '<html', got: ${result.html.slice(0, 80)}`,
    );
  });

  it("bridgeDom() works without explicit tabId", async () => {
    const result = await client.bridgeDom();
    assert.equal(result.html, CANNED_DOM.html);
  });

  // ---- browser.bridge.set_viewport ----

  it("bridgeSetViewport() returns { ok: true, applied_width, applied_height }", async () => {
    const result: BridgeSetViewportResult = await client.bridgeSetViewport(
      TAB_ID,
      1280,
      800,
    );

    assert.equal(result.ok, true);
    assert.equal(typeof result.applied_width, "number");
    assert.equal(typeof result.applied_height, "number");
    assert.equal(result.applied_width, CANNED_SET_VIEWPORT.applied_width);
    assert.equal(result.applied_height, CANNED_SET_VIEWPORT.applied_height);
  });

  it("bridgeSetViewport() with dpr param does not throw", async () => {
    const result = await client.bridgeSetViewport(TAB_ID, 375, 812, 3.0);
    assert.equal(result.ok, true);
  });

  it("bridgeSetViewport() works without explicit tabId", async () => {
    const result = await client.bridgeSetViewport(undefined, 1440, 900);
    assert.equal(result.ok, true);
    assert.equal(result.applied_width, CANNED_SET_VIEWPORT.applied_width);
  });

  // ---- request routing (params forwarded correctly) ----

  it("params are forwarded verbatim: tab_id, width, height sent to mock", async () => {
    const captured: Array<{ method: string; params: Record<string, unknown> }> =
      [];

    const capturePath = tmpSocketPath();
    const capMock = await startMockCmuxServer(
      capturePath,
      (method, params) => {
        captured.push({ method, params });
        // Return a shape matching set_viewport so the client doesn't parse-fail.
        return { ok: true, applied_width: 999, applied_height: 888 };
      },
    );

    const savedSocket = process.env["CMUX_SOCKET_PATH"];
    process.env["CMUX_SOCKET_PATH"] = capturePath;
    const capClient = new CmuxClient();
    await capClient.connect();

    await capClient.bridgeSetViewport("tab-abc", 1024, 768, 2.0);

    capClient.close();
    await capMock.stop();
    if (existsSync(capturePath)) rmSync(capturePath);

    if (savedSocket === undefined) {
      delete process.env["CMUX_SOCKET_PATH"];
    } else {
      process.env["CMUX_SOCKET_PATH"] = savedSocket;
    }

    assert.equal(captured.length, 1);
    const call = captured[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "browser.bridge.set_viewport");
    assert.equal(call.params["tab_id"], "tab-abc");
    assert.equal(call.params["width"], 1024);
    assert.equal(call.params["height"], 768);
    assert.equal(call.params["dpr"], 2.0);
  });

  // ---- error propagation ----

  it("unknown method from mock surfaces as CmuxError", async () => {
    await assert.rejects(
      () => client.send("browser.bridge.unknown_command", {}),
      (err: unknown) => {
        assert.ok(
          err instanceof CmuxError,
          `expected CmuxError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
        );
        assert.ok(
          err.message.includes("unknown method"),
          `message should mention unknown method: ${err.message}`,
        );
        return true;
      },
    );
  });
});
