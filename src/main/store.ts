// Small JSON file store under the app's userData directory with atomic, debounced writes.
import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(name: string) {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${name}.json`);
  }

  read(): T | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  writeNow(value: T): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, this.path);
  }

  writeSoon(get: () => T, delayMs = 1000): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.writeNow(get());
      } catch (err) {
        console.error(`failed to save ${this.path}`, err);
      }
    }, delayMs);
  }
}
