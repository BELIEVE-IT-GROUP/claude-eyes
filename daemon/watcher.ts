/**
 * daemon/watcher.ts — chokidar file-watcher with 250ms debounce.
 *
 * Watches tsx/jsx/ts/css/html/svelte/vue files under cwd and emits a single
 * "change" event after the debounce window closes.
 */
import chokidar from "chokidar";
import { EventEmitter } from "node:events";

/** Extensions the watcher tracks. */
const WATCHED_GLOBS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.css",
  "**/*.html",
  "**/*.svelte",
  "**/*.vue",
];

/** Directories always excluded from the watch. */
const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist\//,
  /build\//,
  /\.claude\//,
  /\.workspace\//,
  /\.recon\//,
];

export interface WatcherEvents {
  change: [];
}

/**
 * FileWatcher emits `"change"` after the debounce window closes.
 * Usage:
 *   const w = new FileWatcher("/path/to/root");
 *   w.on("change", () => triggerCapture());
 *   w.start();
 *   // later:
 *   w.stop();
 */
export class FileWatcher extends EventEmitter<WatcherEvents> {
  private readonly root: string;
  private readonly debounceMs: number;
  private watcher: chokidar.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(root: string, debounceMs = 250) {
    super();
    this.root = root;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.watcher !== null) return;

    this.watcher = chokidar.watch(WATCHED_GLOBS, {
      cwd: this.root,
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 50,
      },
    });

    const onEvent = (): void => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit("change");
      }, this.debounceMs);
    };

    this.watcher.on("add", onEvent);
    this.watcher.on("change", onEvent);
    this.watcher.on("unlink", onEvent);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
