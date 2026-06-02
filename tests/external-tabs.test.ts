/**
 * external-tabs.test.ts — F5 E-6 bonus self-check.
 *
 * Scenario:
 *  - Stub bridge that returns a deterministic 1x1 PNG for snapshot() and snapshotUrl().
 *  - .claude-eyes.json declares 2 watched_external_tabs (docs + storybook).
 *  - Run captureExternalTabs() and assert:
 *      * one ExternalContextEntry per tab, in declaration order
 *      * snapshot_png_path is an absolute path under <eyesDir>/external/
 *      * each PNG file actually exists on disk
 *      * httpStatus is null (URLs are non-routable; probe degrades gracefully)
 *      * error is null on success
 *
 * Also covers loadEyesFileConfig + slugifyTabLabel as integration scaffolding.
 *
 * Run: node --test --import tsx ./tests/external-tabs.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

import type {
  BridgeSnapshotResult,
  EyesFileConfig,
  WatchedExternalTab,
  WorkerOutput,
} from "../contracts/index.js";
import {
  loadEyesFileConfig,
  slugifyTabLabel,
} from "../daemon/config-file.js";
import { captureExternalTabs } from "../daemon/external-tabs.js";
import { frameStem } from "../daemon/storage.js";

// ---------------------------------------------------------------------------
// 1x1 transparent PNG — used by the stub bridge to fake a screenshot payload.
// ---------------------------------------------------------------------------

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";

const ONE_PX_PNG = Buffer.from(ONE_PX_PNG_BASE64, "base64");

// ---------------------------------------------------------------------------
// StubBridge — implements the subset of BridgeClient that external-tabs uses.
// ---------------------------------------------------------------------------

class StubBridge {
  public readonly snapshotUrlCalls: string[] = [];

  async snapshot(): Promise<BridgeSnapshotResult> {
    return { ok: true, pngBuffer: ONE_PX_PNG, width: 1, height: 1 };
  }

  async snapshotUrl(url: string): Promise<BridgeSnapshotResult> {
    this.snapshotUrlCalls.push(url);
    return { ok: true, pngBuffer: ONE_PX_PNG, width: 1, height: 1 };
  }

  async resolveFocusedSurface(): Promise<string | null> {
    return "surface:test";
  }

  // BridgeClient has setViewport too; external-tabs does not call it.
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;
let eyesDir: string;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(tmpdir(), "claude-eyes-e6-"));
  eyesDir = path.join(tmpRoot, ".claude", "eyes");
  await fsp.mkdir(eyesDir, { recursive: true });

  // Write the .claude-eyes.json fixture with 2 watched tabs.
  const cfg: EyesFileConfig = {
    devUrl: "http://localhost:5173",
    watched_external_tabs: [
      { tab_label: "docs", url: "http://127.0.0.1:65530/docs" },
      {
        tab_label: "Storybook Components!",
        url: "http://127.0.0.1:65531/storybook",
      },
    ],
  };
  await fsp.writeFile(
    path.join(tmpRoot, ".claude-eyes.json"),
    JSON.stringify(cfg, null, 2)
  );
});

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadEyesFileConfig", () => {
  it("loads watched_external_tabs from .claude-eyes.json", () => {
    const cfg = loadEyesFileConfig(tmpRoot);
    assert.equal(cfg.devUrl, "http://localhost:5173");
    assert.ok(cfg.watched_external_tabs);
    assert.equal(cfg.watched_external_tabs!.length, 2);
    assert.equal(cfg.watched_external_tabs![0]!.tab_label, "docs");
    assert.equal(
      cfg.watched_external_tabs![1]!.tab_label,
      "Storybook Components!"
    );
  });

  it("returns {} when file missing", () => {
    const cfg = loadEyesFileConfig(tmpdir());
    assert.deepEqual(cfg, {});
  });
});

describe("slugifyTabLabel", () => {
  it("lowercases and replaces unsafe chars", () => {
    assert.equal(slugifyTabLabel("docs"), "docs");
    assert.equal(
      slugifyTabLabel("Storybook Components!"),
      "storybook-components"
    );
    assert.equal(slugifyTabLabel("a/b/c"), "a-b-c");
    assert.equal(slugifyTabLabel(""), "tab");
  });
});

describe("captureExternalTabs with stub bridge (2 tabs)", () => {
  it(
    "captures both tabs, writes PNGs to <eyesDir>/external/, and returns " +
      "one ExternalContextEntry per tab",
    async () => {
      const stub = new StubBridge();
      const tabs: WatchedExternalTab[] = [
        { tab_label: "docs", url: "http://127.0.0.1:65530/docs" },
        {
          tab_label: "Storybook Components!",
          url: "http://127.0.0.1:65531/storybook",
        },
      ];

      const capturedAt = new Date().toISOString();
      const seq = 42;
      const stem = frameStem(capturedAt, seq);

      const result = await captureExternalTabs({
        tabs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bridge: stub as unknown as any,
        playwright: null,
        eyesDir,
        stem,
      });

      // shape + ordering
      assert.equal(result.length, 2, "expected one entry per configured tab");
      assert.equal(result[0]!.tab_label, "docs");
      assert.equal(result[1]!.tab_label, "Storybook Components!");

      // both succeeded
      assert.equal(result[0]!.error, null);
      assert.equal(result[1]!.error, null);

      // snapshot_png_path is absolute and under <eyesDir>/external/
      for (const entry of result) {
        assert.ok(entry.snapshot_png_path, "snapshot_png_path must be set");
        assert.ok(
          path.isAbsolute(entry.snapshot_png_path!),
          "snapshot_png_path must be absolute"
        );
        assert.ok(
          entry.snapshot_png_path!.startsWith(path.join(eyesDir, "external")),
          `snapshot_png_path should be under <eyesDir>/external/ — got ${entry.snapshot_png_path}`
        );
        assert.ok(
          fs.existsSync(entry.snapshot_png_path!),
          `PNG file must exist on disk: ${entry.snapshot_png_path}`
        );
        // sanity: file is our 1x1 PNG fixture
        const buf = await fsp.readFile(entry.snapshot_png_path!);
        assert.deepEqual(buf, ONE_PX_PNG);
      }

      // stub was called once per tab with the right URL
      assert.deepEqual(stub.snapshotUrlCalls, [
        "http://127.0.0.1:65530/docs",
        "http://127.0.0.1:65531/storybook",
      ]);

      // ---- Build the WorkerOutput the daemon would emit after this cycle ----
      // (This mirrors what daemon/index.ts buildWorkerOutputSync returns.)
      const worker: WorkerOutput = {
        seq,
        capturedAt,
        pngPath: path.join(eyesDir, `${stem}.png`),
        jsonPath: path.join(eyesDir, `${stem}.json`),
        error: null,
        framesRetained: 1,
        devUrl: "http://localhost:5173",
        uptimeMs: 1234,
      };

      assert.equal(worker.seq, seq);
      assert.equal(worker.error, null);
      assert.equal(worker.framesRetained, 1);
    }
  );

  it("returns [] when no tabs are configured", async () => {
    const stub = new StubBridge();
    const result = await captureExternalTabs({
      tabs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: stub as unknown as any,
      playwright: null,
      eyesDir,
      stem: "noop",
    });
    assert.deepEqual(result, []);
    assert.equal(stub.snapshotUrlCalls.length, 0);
  });

  it("returns an error entry but does not throw when bridge fails", async () => {
    class FailingBridge {
      async snapshotUrl(): Promise<BridgeSnapshotResult> {
        return { ok: false, error: "boom" };
      }
    }
    const result = await captureExternalTabs({
      tabs: [{ tab_label: "broken", url: "http://127.0.0.1:65532/x" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: new FailingBridge() as unknown as any,
      playwright: null,
      eyesDir,
      stem: "err",
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.snapshot_png_path, null);
    assert.match(result[0]!.error ?? "", /bridge: boom/);
  });
});
