import type { HitLogEntry } from "./core/types.ts";

const MAX_LOGS = 200;

export class HitLogStore {
  private entries: HitLogEntry[] = [];
  private recentCwds: string[] = [];

  record(entry: HitLogEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_LOGS) {
      this.entries.length = MAX_LOGS;
    }
    if (entry.cwd) {
      this.trackCwd(entry.cwd);
    }
  }

  updateById(id: string, patch: Partial<HitLogEntry>): boolean {
    const found = this.entries.find((e) => e.id === id);
    if (!found) return false;
    Object.assign(found, patch);
    return true;
  }

  list(limit = 100): HitLogEntry[] {
    return this.entries.slice(0, Math.max(1, Math.min(limit, MAX_LOGS)));
  }

  clear(): void {
    this.entries = [];
  }

  trackCwd(cwd: string): void {
    const clean = cwd.trim();
    if (!clean) return;
    this.recentCwds = [clean, ...this.recentCwds.filter((c) => c !== clean)].slice(0, 10);
  }

  getRecentCwds(): string[] {
    return [...this.recentCwds];
  }

  getStats(): {
    total: number;
    matched: number;
    skipped: number;
    deferred: number;
  } {
    let matched = 0;
    let skipped = 0;
    let deferred = 0;
    for (const e of this.entries) {
      if (e.status === "matched") matched += 1;
      else if (e.status === "skipped-utility" || e.status === "skipped-disabled") skipped += 1;
      else if (e.status === "deferred") deferred += 1;
    }
    return {
      total: this.entries.length,
      matched,
      skipped,
      deferred,
    };
  }
}

export const hitLogStore = new HitLogStore();
