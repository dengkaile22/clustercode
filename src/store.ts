/**
 * Persistence.
 *
 * `ClusterStore` wraps any key/value backend that looks like the OpenCode plugin
 * storage (`get` / `set` / optional `scan`) and adds the two things the cluster
 * needs: an in-memory cache so the hot path never blocks on I/O, and per-session
 * serialised writes so a tool call and an idle hook cannot clobber each other.
 *
 * The same interface is implemented by `MemoryStorage` (tests) and `FileStorage`
 * (CLI, local inspection, environments without plugin storage).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ClusterState, KEY_PREFIX_FOR_SCAN, hydrate, keyFor, sessionIdFromKey } from "./state.ts";

export interface StorageEntry {
  key: string;
  value: unknown;
}

export interface StorageScanResult {
  entries: ReadonlyArray<StorageEntry>;
  /** Opaque cursor for the next page, when the backend has one. */
  next?: string;
}

export interface Storage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<void>;
  scan?(options: { prefix: string; limit?: number; after?: string }): Promise<StorageScanResult>;
}

export class MemoryStorage implements Storage {
  #data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.#data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    // Round-trip through JSON like a real backend would, so callers cannot rely on
    // object identity surviving a save/load cycle.
    this.#data.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }

  async scan(options: { prefix: string; limit?: number; after?: string }): Promise<StorageScanResult> {
    const limit = options.limit ?? 100;
    const keys = [...this.#data.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .filter((k) => (options.after ? k > options.after : true))
      .sort();
    const page = keys.slice(0, limit);
    return {
      entries: page.map((key) => ({ key, value: this.#data.get(key) })),
      next: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }
}

const fileFor = (key: string) => `${key.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}.json`;

/** Shape on disk: `{ key, value }`, so a scan never has to guess the original key. */
interface Envelope {
  key: string;
  value: unknown;
}

/**
 * One JSON file per key. Writes go through a temp file + rename so a crash cannot
 * leave a truncated state behind.
 */
export class FileStorage implements Storage {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get directory(): string {
    return this.#dir;
  }

  async get(key: string): Promise<unknown> {
    const envelope = await this.#read(key);
    return envelope?.value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, fileFor(key));
    const tmp = `${target}.${process.pid}.tmp`;
    const envelope: Envelope = { key, value };
    await writeFile(tmp, JSON.stringify(envelope, null, 2), "utf8");
    await rename(tmp, target);
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.#dir, fileFor(key)), { force: true });
  }

  async scan(options: { prefix: string; limit?: number; after?: string }): Promise<StorageScanResult> {
    const limit = options.limit ?? 100;
    let files: string[];
    try {
      files = (await readdir(this.#dir)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return { entries: [] };
    }

    const all: Envelope[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(join(this.#dir, file), "utf8")) as Partial<Envelope>;
        if (typeof parsed?.key !== "string") continue;
        all.push({ key: parsed.key, value: parsed.value });
      } catch {
        /* unreadable file: skip it rather than failing the whole scan */
      }
    }

    const matching = all.filter((e) => e.key.startsWith(options.prefix)).sort((a, b) => (a.key < b.key ? -1 : 1));
    const after = options.after;
    const start = after ? matching.findIndex((e) => e.key > after) : 0;
    const page = matching.slice(start < 0 ? matching.length : start, (start < 0 ? matching.length : start) + limit);
    const next = matching.length > (start < 0 ? matching.length : start) + limit ? page[page.length - 1]?.key : undefined;
    return { entries: page, next };
  }

  async #read(key: string): Promise<Envelope | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.#dir, fileFor(key)), "utf8")) as Envelope;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

/**
 * Cached, write-serialised view over a `Storage` backend.
 * Every read/write of cluster state goes through this class.
 */
export class ClusterStore {
  #storage: Storage;
  #cache = new Map<string, ClusterState>();
  #writing = new Map<string, Promise<void>>();

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  get storage(): Storage {
    return this.#storage;
  }

  async load(sessionID: string): Promise<ClusterState> {
    const cached = this.#cache.get(sessionID);
    if (cached) return cached;
    const raw = await this.#storage.get(keyFor(sessionID));
    const state = hydrate(raw);
    this.#cache.set(sessionID, state);
    return state;
  }

  async save(sessionID: string, state: ClusterState): Promise<void> {
    state.updatedAt = Date.now();
    this.#cache.set(sessionID, state);
    const previous = this.#writing.get(sessionID) ?? Promise.resolve();
    const job = previous
      .then(() => this.#storage.set(keyFor(sessionID), state))
      .catch(() => {
        /* a failed write must never break the run; the next save retries */
      });
    this.#writing.set(sessionID, job);
    await job;
  }

  /** Cache only. The heartbeat path uses this to avoid an I/O call every tick. */
  peek(sessionID: string): ClusterState | undefined {
    return this.#cache.get(sessionID);
  }

  invalidate(sessionID?: string): void {
    if (sessionID) this.#cache.delete(sessionID);
    else this.#cache.clear();
  }

  /** All known clusters. Used by heartbeat and crash recovery. */
  async scanAll(): Promise<Array<{ sessionID: string; state: ClusterState }>> {
    const backend = this.#storage;
    if (typeof backend.scan !== "function") {
      return [...this.#cache.entries()].map(([sessionID, state]) => ({ sessionID, state }));
    }
    const out: Array<{ sessionID: string; state: ClusterState }> = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await backend.scan({ prefix: KEY_PREFIX_FOR_SCAN, limit: 100, after });
      for (const entry of result?.entries ?? []) {
        const sessionID = sessionIdFromKey(String(entry.key));
        if (!sessionID) continue;
        const state = hydrate(entry.value);
        this.#cache.set(sessionID, state);
        out.push({ sessionID, state });
      }
      if (!result?.next) break;
      after = result.next;
    }
    return out;
  }
}
