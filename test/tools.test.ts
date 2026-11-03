import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ClusterStore } from "../src/store.ts";
import { registerTools, runVerify, type Runtime } from "../src/tools.ts";
import { isFinished, nextTask } from "../src/state.ts";
import { TEST_SESSION, makeHarness, type Harness } from "./support/harness.ts";

let dir = "";
let harness: Harness;
let runtime: Runtime;

async function setup(options: Parameters<typeof makeHarness>[0] = {}) {
  harness = makeHarness({ dir, ...options });
  runtime = { store: new ClusterStore(harness.storage), publish: () => {}, cwd: dir };
  await registerTools(harness.ctx, runtime);
  return harness;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clustercode-tools-"));
  process.env.CLUSTERCODE_AGENTS_DIR = join(dir, "agents");
});

afterEach(() => {
  delete process.env.CLUSTERCODE_AGENTS_DIR;
  // A killed shell can keep the directory handle for a moment on Windows.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("runVerify", () => {
  it("reports success on exit code 0", async () => {
    const result = await runVerify('node -e "process.exit(0)"', dir);
    assert.equal(result.ok, true);
  });

  it("reports failure and keeps the output", async () => {
    const result = await runVerify('node -e "console.error(\'boom\');process.exit(3)"', dir);
    assert.equal(result.ok, false);
    assert.match(result.out, /boom/);
  });

  it("kills a command that exceeds the timeout", async () => {
    const result = await runVerify('node -e "setTimeout(()=>{},5000)"', dir, 250);
    assert.equal(result.ok, false);
    assert.match(result.out, /killed after/);
  });

  it("runs in the given working directory", async () => {
    const result = await runVerify('node -e "console.log(process.cwd())"', dir);
    assert.equal(result.ok, true);
    assert.ok(result.out.toLowerCase().includes(dir.toLowerCase().slice(0, 8)));
  });
});

describe("tool registration", () => {
  it("registers the full surface", async () => {
    await setup();
    assert.deepEqual(
      [...harness.tools.keys()].sort(),
      ["cluster_auto", "cluster_plan", "cluster_retry", "cluster_status", "cluster_team", "cluster_update"],
    );
  });
});

describe("cluster_plan", () => {
  it("creates a queue, builds the default team and stores the run", async () => {
    await setup();
    const result = await harness.callTool("cluster_plan", {
      goal: "ship it",
      tasks: [{ id: "t1", title: "write code" }, { id: "t2", title: "test it", dependsOn: ["t1"] }],
    });
    assert.match(result.content, /2-task queue/);
    assert.match(result.content, /team ready/);

    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.active, true);
    assert.equal(state.tasks.length, 2);
    assert.deepEqual(state.tasks[1].dependsOn, ["t1"]);
    assert.equal(state.team.length, 4);
  });

  it("rejects an empty list", async () => {
    await setup();
    const result = await harness.callTool("cluster_plan", { goal: "x", tasks: [] });
    assert.match(result.content, /empty/);
  });

  it("appends to a live queue without losing progress", async () => {
    await setup();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      maxRounds: 9,
    });
    await harness.callTool("cluster_update", { id: "t1", status: "done" });
    const before = await runtime.store.load(TEST_SESSION);
    before.round = 4;
    await runtime.store.save(TEST_SESSION, before);

    const result = await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t2", title: "b", dependsOn: ["t1"] }],
      append: true,
    });
    assert.match(result.content, /appended 1 task/);

    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.tasks.length, 2);
    assert.equal(state.tasks[0].status, "done");
    assert.equal(state.tasks[1].status, "pending");
    assert.equal(state.active, true);
    // Appending continues the run instead of restarting it.
    assert.equal(state.round, 4);
    assert.equal(state.maxRounds, 9);
  });

  it("warns about an unrunnable graph instead of pretending it is fine", async () => {
    await setup();
    const result = await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a", dependsOn: ["t2"] }, { id: "t2", title: "b", dependsOn: ["t1"] }],
    });
    assert.match(result.content, /repaired/);
    assert.match(result.content, /cycle/);
  });

  it("warns when both guardrails are disabled", async () => {
    await setup();
    const result = await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      maxStagnant: 0,
    });
    assert.match(result.content, /both guardrails are off/);
  });

  it("stays quiet while at least one guardrail is armed", async () => {
    await setup();
    const result = await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [{ id: "t1", title: "a" }],
      maxRounds: 3,
      maxStagnant: 0,
    });
    assert.doesNotMatch(result.content, /both guardrails/);
  });
});

describe("cluster_update and the verify gate", () => {
  beforeEach(async () => {
    await setup();
    await harness.callTool("cluster_plan", {
      goal: "x",
      tasks: [
        { id: "t1", title: "guarded", verify: 'node -e "process.exit(1)"' },
        { id: "t2", title: "fine", verify: 'node -e "process.exit(0)"' },
      ],
    });
  });

  it("refuses done when verify fails", async () => {
    const result = await harness.callTool("cluster_update", { id: "t1", status: "done" });
    assert.match(result.content, /refusing to mark t1/);
    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.tasks[0].status, "pending");
  });

  it("accepts done when verify passes and records the evidence", async () => {
    const result = await harness.callTool("cluster_update", { id: "t2", status: "done" });
    assert.match(result.content, /t2 -> done/);
    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.tasks[1].status, "done");
    assert.match(state.tasks[1].note ?? "", /verify passed/);
  });

  it("allows skipping a command that cannot run", async () => {
    const result = await harness.callTool("cluster_update", { id: "t1", status: "done", skipVerify: true });
    assert.match(result.content, /t1 -> done/);
  });

  it("reports an unknown task id with the existing ids", async () => {
    const result = await harness.callTool("cluster_update", { id: "nope", status: "done" });
    assert.match(result.content, /no task nope/);
    assert.match(result.content, /t1, t2/);
  });

  it("stops the cluster when the queue drains", async () => {
    await harness.callTool("cluster_update", { id: "t1", status: "failed" });
    const result = await harness.callTool("cluster_update", { id: "t2", status: "done" });
    assert.match(result.content, /cluster stopped/);

    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(isFinished(state), true);
    assert.equal(state.active, false);
    assert.equal(state.stoppedCode, "finished");
  });

  it("rejects an invalid status", async () => {
    const result = await harness.callTool("cluster_update", { id: "t1", status: "sideways" });
    assert.match(result.content, /invalid status/);
  });
});

describe("cluster_retry", () => {
  it("puts failed tasks back in the queue", async () => {
    await setup();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    await harness.callTool("cluster_update", { id: "t1", status: "failed" });

    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.active, false);

    const result = await harness.callTool("cluster_retry", {});
    assert.match(result.content, /reset 1 task/);

    const after = await runtime.store.load(TEST_SESSION);
    assert.equal(after.active, true);
    assert.equal(after.tasks[0].status, "pending");
    assert.equal(after.tasks[0].attempts, 1);
    assert.equal(after.stoppedCode, "");
    assert.equal(nextTask(after)?.id, "t1");
  });

  it("says so when there is nothing to retry", async () => {
    await setup();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    const result = await harness.callTool("cluster_retry", {});
    assert.match(result.content, /Nothing to retry/);
  });

  it("reports an unknown id", async () => {
    await setup();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    const result = await harness.callTool("cluster_retry", { id: "zz" });
    assert.match(result.content, /no task zz/);
  });

  it("refuses to reset a task that did not fail", async () => {
    await setup();
    await harness.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
    const result = await harness.callTool("cluster_retry", { id: "t1" });
    assert.match(result.content, /not failed/);
    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.tasks[0].status, "pending");
    assert.equal(state.tasks[0].attempts, undefined);
  });
});

describe("cluster_status", () => {
  it("explains an empty installation", async () => {
    await setup();
    assert.match((await harness.callTool("cluster_status")).content, /No cluster yet/);
  });

  it("shows the queue, the seat and the guards", async () => {
    await setup();
    await harness.callTool("cluster_plan", {
      goal: "ship",
      tasks: [{ id: "t1", title: "a" }],
      maxRounds: 3,
      maxStagnant: 5,
      heartbeat: true,
    });
    const result = await harness.callTool("cluster_status");
    assert.match(result.content, /tasks: 0\/1 done/);
    assert.match(result.content, /next seat:/);
    assert.match(result.content, /heartbeat: on \(60s\)/);
    assert.match(result.content, /stop after 5 turns/);
    assert.match(result.content, /round cap: 3/);
  });
});

describe("cluster_auto", () => {
  it("uses the generated DAG and reports repairs", async () => {
    await setup({
      generate: async () => ({
        text:
          "```json\n" +
          JSON.stringify({
            tasks: [
              { id: "t1", title: "scaffold", member: "ghost" },
              { id: "t2", title: "verify", dependsOn: ["t1", "missing"] },
            ],
          }) +
          "\n```",
      }),
    });
    const result = await harness.callTool("cluster_auto", { goal: "do the thing" });
    assert.match(result.content, /2-task workflow/);
    assert.match(result.content, /unknown-member/);
    assert.match(result.content, /unknown-dep/);

    const state = await runtime.store.load(TEST_SESSION);
    assert.equal(state.tasks.length, 2);
    assert.equal(state.heartbeat, true);
  });

  it("falls back to cluster_plan when generation fails", async () => {
    await setup({ generate: async () => ({ text: "no json here" }) });
    const result = await harness.callTool("cluster_auto", { goal: "x" });
    assert.match(result.content, /automatic planning failed/);
    assert.match(result.content, /cluster_plan/);
  });

  it("rejects an empty goal", async () => {
    await setup();
    assert.match((await harness.callTool("cluster_auto", { goal: "  " })).content, /goal is empty/);
  });

  it("carries the guardrail warning into the generated run", async () => {
    await setup();
    const result = await harness.callTool("cluster_auto", { goal: "x", maxStagnant: 0 });
    assert.match(result.content, /both guardrails are off/);
  });
});

describe("cluster_team", () => {
  it("replaces the roster and writes the files", async () => {
    await setup();
    const result = await harness.callTool("cluster_team", {
      members: [
        { id: "researcher", role: "read docs" },
        { id: "writer", role: "write docs" },
      ],
    });
    assert.match(result.content, /team ready: researcher -> writer/);

    const state = await runtime.store.load(TEST_SESSION);
    assert.deepEqual(state.team.map((m) => m.id), ["researcher", "writer"]);
    assert.equal(harness.reloads, 1);
  });
});
