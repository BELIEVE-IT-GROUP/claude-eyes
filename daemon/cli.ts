/**
 * daemon/cli.ts — CLI wrapper that starts/queries the claude-eyes daemon.
 *
 * Usage:
 *   npx tsx daemon/cli.ts start         # start the daemon (foreground)
 *   npx tsx daemon/cli.ts snapshot      # trigger a capture via POST /snapshot
 *   npx tsx daemon/cli.ts latest        # print the latest WorkerOutput as JSON
 *   npx tsx daemon/cli.ts health        # check /healthz
 *
 * For the "start" sub-command, this module simply delegates to daemon/index.ts
 * by dynamic import so the file can act as both CLI entry and importable module.
 */
import * as http from "node:http";

const PORT = Number(process.env["CLAUDE_EYES_PORT"] ?? "14242");
const HOST = "127.0.0.1";

function httpGet(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.get(`http://${HOST}:${PORT}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

function httpPost(path: string, body: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.byteLength,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

async function cmdStart(): Promise<void> {
  // Delegate to daemon/index.ts
  await import("./index.js");
}

async function cmdSnapshot(): Promise<void> {
  const body = await httpPost("/snapshot", "{}");
  process.stdout.write(body + "\n");
}

async function cmdLatest(): Promise<void> {
  const body = await httpGet("/latest");
  process.stdout.write(body + "\n");
}

async function cmdHealth(): Promise<void> {
  const body = await httpGet("/healthz");
  process.stdout.write(body + "\n");
}

async function main(): Promise<void> {
  const subcmd = process.argv[2] ?? "start";
  switch (subcmd) {
    case "start":
      await cmdStart();
      break;
    case "snapshot":
      await cmdSnapshot();
      break;
    case "latest":
      await cmdLatest();
      break;
    case "health":
    case "healthz":
      await cmdHealth();
      break;
    default:
      console.error(
        `Unknown subcommand: ${subcmd}\nUsage: cli.ts [start|snapshot|latest|health]`
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[claude-eyes cli] error:", err);
  process.exit(1);
});
