import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ClusterStore, FileStorage, MemoryStorage } from "../src/store.ts";
import { emptyState, keyFor } from "../src/state.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clustercode-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryStorage", () => {
  it("round-trips values through JSON", async () => {
    const storage = new MemoryStorage();
    await storage.set("cluster:a", { hello: "world" });
    assert.deepEqual(await storage.get("cluster:a"), { hello: "world" });
    assert.equal(await storage.get("missing"), undefined);
  });

  it("deletes keys", async () => {
    const storage = new MemoryStorage();
    await storage.set("cluster:a", 1);
    await storage.delete("cluster:a");
    assert.equal(await storage.get("cluster:a"), undefined);
  });

  it("paginates a scan cursor", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 5; i++) await storage.set(`cluster:s${i}`, i);
    await storage.set("other:x", 1);

    const first = await storage.scan({ prefix: "cluster:", limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.ok(first.next);

    const second = await storage.scan({ prefix: "cluster:", limit: 2, after: first.next });
    assert.equal(second.entries.length, 2);
    assert.notEqual(second.entries[0].key, first.entries[0].key);
  });

  it("filters by prefix", async () => {
    const storage = new MemoryStorage();
    await storage.set("cluster:a", 1);
    await storage.set("other:b", 2);
    const result = await storage.scan({ prefix: "cluster:" });
    assert.deepEqual(result.entries.map((e) => e.key), ["cluster:a"]);
  });
});

describe("FileStorage", () => {
  it("persists across instances", async () => {
    await new FileStorage(dir).set(keyFor("ses_1"), { active: true });
    const value = await new FileStorage(dir).get(keyFor("ses_1"));
    assert.deepEqual(value, { active: true });
  });

  it("returns undefined for a missing key", async () => {
    assert.equal(await new FileStorage(dir).get("cluster:none"), undefined);
  });

  it("deletes files", async () => {
    const storage = new FileStorage(dir);
    await storage.set("cluster:a", 1);
    await storage.delete("cluster:a");
    assert.equal(await storage.get("cluster:a"), undefined);
  });

  it("scans by prefix and skips unrelated keys", async () => {
    const storage = new FileStorage(dir);
    await storage.set("cluster:a", { a: 1 });
    await storage.set("cluster:b", { b: 2 });
    await storage.set("other:c", { c: 3 });
    const result = await storage.scan({ prefix: "cluster:" });
    assert.deepEqual(result.entries.map((e) => e.key).sort(), ["cluster:a", "cluster:b"]);
  });

  it("returns an empty scan for a missing directory", async () => {
    const storage = new FileStorage(join(dir, "nope"));
    assert.deepEqual(await storage.scan({ prefix: "cluster:" }), { entries: [] });
  });
});

describe("ClusterStore", () => {
  it("caches a loaded state", async () => {
    const storage = new MemoryStorage();
    await storage.set(keyFor("ses_1"), { ...emptyState(), goal: "cached" });
    const store = new ClusterStore(storage);

    const first = await store.load("ses_1");
    assert.equal(first.goal, "cached");
    assert.equal(store.peek("ses_1"), first);
    assert.equal(await store.load("ses_1"), first);
  });

  it("hydrates a missing state", async () => {
    const store = new ClusterStore(new MemoryStorage());
    const state = await store.load("ses_new");
    assert.equal(state.active, false);
    assert.deepEqual(state.tasks, []);
  });

  it("saves and reads back", async () => {
    const store = new ClusterStore(new MemoryStorage());
    const state = await store.load("ses_1");
    state.active = true;
    state.goal = "persisted";
    await store.save("ses_1", state);

    const reopened = new ClusterStore(store.storage);
    const loaded = await reopened.load("ses_1");
    assert.equal(loaded.goal, "persisted");
    assert.equal(loaded.active, true);
  });

  it("drops the cache on invalidate", async () => {
    const store = new ClusterStore(new MemoryStorage());
    const state = await store.load("ses_1");
    state.goal = "before";
    await store.save("ses_1", state);

    store.invalidate("ses_1");
    assert.equal(store.peek("ses_1"), undefined);
    assert.equal((await store.load("ses_1")).goal, "before");
  });

  it("scans every stored session", async () => {
    const store = new ClusterStore(new MemoryStorage());
    for (const id of ["a", "b", "c"]) {
      const state = await store.load(id);
      state.goal = `goal ${id}`;
      await store.save(id, state);
    }
    const all = await store.scanAll();
    assert.deepEqual(all.map((entry) => entry.sessionID).sort(), ["a", "b", "c"]);
  });

  it("falls back to the cache when the backend cannot scan", async () => {
    const backend = {
      get: async () => undefined,
      set: async () => {},
    };
    const store = new ClusterStore(backend);
    await store.load("ses_1");
    assert.deepEqual((await store.scanAll()).map((e) => e.sessionID), ["ses_1"]);
  });

  it("keeps writing after a failed save", async () => {
    let fail = true;
    const backend = {
      get: async () => undefined,
      set: async () => {
        if (fail) throw new Error("disk full");
        return undefined;
      },
    };
    const store = new ClusterStore(backend);
    const state = await store.load("ses_1");
    await assert.doesNotReject(() => store.save("ses_1", state));
    fail = false;
    await assert.doesNotReject(() => store.save("ses_1", state));
  });
});
