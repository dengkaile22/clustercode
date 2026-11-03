import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import plugin, { heartbeatTick, MARK } from "../src/index.ts";
import { ClusterStore } from "../src/store.ts";
import { resetSnapshots } from "../src/snapshot.ts";
import { CLUSTER_ID } from "../src/team.ts";
import { TEST_SESSION, makeHarness, type Harness } from "./support/harness.ts";

let dir = "";
let harness: Harness;
let dispose: (() => Promise<void> | void) | undefined;

async function boot(options: Parameters<typeof makeHarness>[0] = {}) {
  harness = makeHarness({ dir, ...options });
  dispose = await plugin.setup(harness.ctx);
  return harness;
}

const store = () => new ClusterStore(harness.storage);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clustercode-plugin-"));
  process.env.CLUSTERCODE_AGENTS_DIR = join(dir, "agents");
  resetSnapshots();
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  delete process.env.CLUSTERCODE_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("setup", () => {
  it("writes the cluster mode agent and reloads the agent list", async () => {
    await boot();
    assert.ok(existsSync(join(dir, "agents", `${CLUSTER_ID}.md`)));
    assert.equal(harness.reloads, 1);
  });

  it("registers tools, commands and the snapshot RPC", async () => {
    await boot();
    assert.equal(harness.tools.size, 6);
    assert.deepEqual([...harness.commands.keys()].sort(), ["cluster-resume", "cluster-stop"]);
    assert.equal(harness.rpc?.definition.id, "clustercode.snapshot");
    assert.equal(typeof harness.rpc?.handlers.get, "function");
  });

  it("survives a missing RPC domain", async () => {
    harness = makeHarness({ dir });
    harness.ctx.rpc = undefined;
    await assert.doesNotReject(() => Promise.resolve(plugin.setup(harness.ctx)));
  });
});

describe("idle hook", () => {
  it("hands back the next turn with resume: true", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "ship", tasks: [{ id: "t1", title: "a" }] });
    await harness.idle();

    assert.equal(harness.synthetics.length, 1);
    assert.equal(harness.synthetics[0].resume, true);
    assert.match(harness.synthetics[0].text, /turn 1/);
    assert.match(harness.synthetics[0].text, /t1/);

    const state = await store().load(TEST_SESSION);
    assert.equal(state.round, 1);
    assert.equal(state.active, true);
  });

  it("waits while background work is still running", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await harness.idle(TEST_SESSION, [{ kind: "shell", sessionID: TEST_SESSION, shellID: "sh", command: "sleep" }]);

    assert.equal(harness.synthetics.length, 0);
    const state = await store().load(TEST_SESSION);
    assert.equal(state.round, 0);
  });

  it("rotates through the team and advances the cursor", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }, { id: "t2", title: "b" }],
    });

    await harness.idle();
    assert.equal(harness.switches[0].agent, "clustercode-architect");
    assert.equal((await store().load(TEST_SESSION)).cursor, 1);

    await harness.idle();
    assert.equal(harness.switches[1].agent, "clustercode-coder");
    assert.equal((await store().load(TEST_SESSION)).cursor, 2);
  });

  it("lets a task pin its seat", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a", member: "tester" }],
    });
    await harness.idle();
    assert.equal(harness.switches[0].agent, "clustercode-tester");
    assert.equal((await store().load(TEST_SESSION)).cursor, 4 % 4);
  });

  it("keeps running when the agent switch fails, and does not skip the seat", async () => {
    await boot({ switchAgentError: "agent not found" });
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await harness.idle();

    assert.equal(harness.synthetics.length, 1);
    assert.match(harness.synthetics[0].text, /could not switch to architect/);
    const state = await store().load(TEST_SESSION);
    assert.equal(state.cursor, 0);
    assert.equal(state.round, 1);
  });

  it("stops at the round cap without injecting another turn", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      maxRounds: 1,
    });

    await harness.idle();
    assert.equal(harness.synthetics.length, 1);

    await harness.idle();
    assert.equal(harness.synthetics.length, 1);
    const state = await store().load(TEST_SESSION);
    assert.equal(state.active, false);
    assert.equal(state.stoppedCode, "max-rounds");
  });

  it("stops when the queue drains", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await harness.callTool("cluster_update", { id: "t1", status: "done" });

    await harness.idle();
    const state = await store().load(TEST_SESSION);
    assert.equal(state.active, false);
    assert.equal(state.stoppedCode, "finished");
    assert.equal(harness.synthetics.length, 0);
  });

  it("does nothing when no cluster was ever started", async () => {
    await boot();
    await harness.idle();
    assert.equal(harness.synthetics.length, 0);
  });
});

describe("context card", () => {
  it("injects one card with the goal and the follow-up call", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "ship the thing", tasks: [{ id: "t1", title: "a" }] });

    const event: any = { sessionID: TEST_SESSION, system: [], agent: "build" };
    await harness.runHook("context", event);

    assert.equal(event.system.length, 1);
    assert.ok(event.system[0].text.startsWith(MARK));
    assert.match(event.system[0].text, /ship the thing/);
    assert.match(event.system[0].text, /cluster_update/);
  });

  it("does not inject the card twice", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });

    const event: any = { sessionID: TEST_SESSION, system: [], agent: "build" };
    await harness.runHook("context", event);
    await harness.runHook("context", event);
    assert.equal(event.system.length, 1);
  });

  it("explains cluster mode when the user switched to it with no run", async () => {
    await boot();
    const event: any = { sessionID: TEST_SESSION, system: [], agent: CLUSTER_ID };
    await harness.runHook("context", event);
    assert.match(event.system[0].text, /cluster mode/);
    assert.match(event.system[0].text, /cluster_auto/);
  });

  it("stays out of unrelated agents when there is no run", async () => {
    await boot();
    const event: any = { sessionID: TEST_SESSION, system: [], agent: "build" };
    await harness.runHook("context", event);
    assert.equal(event.system.length, 0);
  });

  it("ignores an event without a system array", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await assert.doesNotReject(() => harness.runHook("context", { sessionID: TEST_SESSION }));
  });
});

describe("commands", () => {
  it("stops and resumes the run", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });

    await harness.runCommand("cluster-stop");
    let state = await store().load(TEST_SESSION);
    assert.equal(state.active, false);
    assert.equal(state.stoppedCode, "user");

    await harness.runCommand("cluster-resume");
    state = await store().load(TEST_SESSION);
    assert.equal(state.active, true);
    assert.equal(state.stoppedCode, "");
    assert.equal(harness.synthetics.length, 1);
    assert.match(harness.synthetics[0].text, /resumed/);
  });

  it("does not resume a session without a queue", async () => {
    await boot();
    await harness.runCommand("cluster-resume");
    assert.equal(harness.synthetics.length, 0);
  });
});

describe("heartbeat", () => {
  it("wakes an idle cluster and counts the turn", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      heartbeat: true,
    });

    await heartbeatTick(harness.ctx, store(), Date.now());
    assert.equal(harness.synthetics.length, 1);
    assert.equal(harness.synthetics[0].resume, true);
    assert.match(harness.synthetics[0].text, /heartbeat wake-up/);
    assert.equal((await store().load(TEST_SESSION)).round, 1);
  });

  it("respects the cooldown", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      heartbeat: true,
    });

    const now = Date.now();
    await heartbeatTick(harness.ctx, store(), now);
    await heartbeatTick(harness.ctx, store(), now + 1_000);
    assert.equal(harness.synthetics.length, 1);
  });

  it("does not wake a busy session", async () => {
    const now = Date.now();
    await boot({ sessionBusy: now, sessionIdle: now - 5_000 });
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      heartbeat: true,
    });

    await heartbeatTick(harness.ctx, store(), now);
    assert.equal(harness.synthetics.length, 0);
  });

  it("applies the round cap instead of waking one extra turn", async () => {
    await boot();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      heartbeat: true,
      maxRounds: 1,
    });

    const now = Date.now();
    await heartbeatTick(harness.ctx, store(), now);
    assert.equal(harness.synthetics.length, 1);

    await heartbeatTick(harness.ctx, store(), now + 120_000);
    assert.equal(harness.synthetics.length, 1);
    const state = await store().load(TEST_SESSION);
    assert.equal(state.active, false);
    assert.equal(state.stoppedCode, "max-rounds");
  });

  it("ignores clusters without heartbeat", async () => {
    await boot();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await heartbeatTick(harness.ctx, store(), Date.now());
    assert.equal(harness.synthetics.length, 0);
  });
});

describe("teardown", () => {
  it("returns a dispose that can run twice", async () => {
    await boot();
    await dispose?.();
    await dispose?.();
  });
});
