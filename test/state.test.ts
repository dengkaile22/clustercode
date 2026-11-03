import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ClusterState,
  type Task,
  blockedTasks,
  brief,
  counts,
  depsSatisfied,
  emptyState,
  fingerprint,
  hydrate,
  isDeadlocked,
  isFinished,
  keyFor,
  nextStagnant,
  nextTask,
  pickMember,
  sessionIdFromKey,
  stagnantLimit,
} from "../src/state.ts";

const task = (id: string, status: Task["status"], dependsOn: string[] = []): Task => ({
  id,
  title: `task ${id}`,
  status,
  dependsOn,
  updatedAt: 0,
});

const withTasks = (tasks: Task[], extra: Partial<ClusterState> = {}): ClusterState => ({
  ...emptyState(),
  tasks,
  active: true,
  goal: "goal",
  ...extra,
});

describe("hydrate", () => {
  it("returns defaults for garbage input", () => {
    const state = hydrate("nope");
    assert.equal(state.active, false);
    assert.deepEqual(state.tasks, []);
    assert.equal(state.maxStagnant, 12);
    assert.equal(state.stoppedCode, "");
  });

  it("repairs broken counters and task arrays", () => {
    const state = hydrate({
      active: true,
      maxStagnant: -5,
      round: Number.NaN,
      cursor: "3",
      tasks: [{ id: "t1" }, null, { title: "no id" }],
      team: "nope",
    });
    assert.equal(state.maxStagnant, 12);
    assert.equal(state.round, 0);
    assert.equal(state.cursor, 0);
    assert.deepEqual(state.team, []);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, "pending");
    assert.deepEqual(state.tasks[0].dependsOn, []);
  });
});

describe("keys", () => {
  it("round-trips a session id", () => {
    assert.equal(keyFor("ses_1"), "cluster:ses_1");
    assert.equal(sessionIdFromKey("cluster:ses_1"), "ses_1");
    assert.equal(sessionIdFromKey("other:ses_1"), "");
  });
});

describe("stagnantLimit", () => {
  it("accepts 0 to disable the guard", () => {
    assert.equal(stagnantLimit(0), 0);
  });

  it("falls back for invalid values", () => {
    assert.equal(stagnantLimit(-1), 12);
    assert.equal(stagnantLimit("abc"), 12);
    assert.equal(stagnantLimit(3.7), 3);
  });
});

describe("counts", () => {
  it("counts every status", () => {
    const c = counts(withTasks([task("a", "done"), task("b", "failed"), task("c", "running"), task("d", "pending")]));
    assert.deepEqual(c, { done: 1, failed: 1, running: 1, pending: 1, total: 4 });
  });
});

describe("dependencies", () => {
  it("treats a failed dependency as unsatisfied", () => {
    const state = withTasks([task("a", "failed"), task("b", "pending", ["a"])]);
    assert.equal(depsSatisfied(state, state.tasks[1]), false);
  });

  it("requires every dependency", () => {
    const state = withTasks([task("a", "done"), task("b", "pending", ["a", "c"]), task("c", "done")]);
    assert.equal(depsSatisfied(state, state.tasks[1]), true);
  });

  it("reports pending tasks that wait on deps", () => {
    const state = withTasks([task("a", "pending", ["b"]), task("b", "pending")]);
    assert.deepEqual(blockedTasks(state).map((t) => t.id), ["a"]);
  });
});

describe("nextTask", () => {
  it("resumes an interrupted running task before opening a new one", () => {
    const state = withTasks([task("a", "pending"), task("b", "running")]);
    assert.equal(nextTask(state)?.id, "b");
  });

  it("skips tasks whose dependencies are not done", () => {
    const state = withTasks([task("a", "pending", ["b"]), task("b", "pending")]);
    assert.equal(nextTask(state)?.id, "b");
  });

  it("returns undefined when nothing is runnable", () => {
    assert.equal(nextTask(withTasks([task("a", "done")])), undefined);
  });
});

describe("isFinished", () => {
  it("is false for an empty queue", () => {
    assert.equal(isFinished(withTasks([])), false);
  });

  it("is true when everything ended", () => {
    assert.equal(isFinished(withTasks([task("a", "done"), task("b", "failed")])), true);
  });
});

describe("isDeadlocked", () => {
  it("detects a cycle", () => {
    const state = withTasks([task("a", "pending", ["b"]), task("b", "pending", ["a"])]);
    assert.equal(isDeadlocked(state), true);
  });

  it("detects a failed upstream task", () => {
    const state = withTasks([task("a", "failed"), task("b", "pending", ["a"])]);
    assert.equal(isDeadlocked(state), true);
  });

  it("is false while work can run", () => {
    const state = withTasks([task("a", "pending")]);
    assert.equal(isDeadlocked(state), false);
  });

  it("is false for a finished queue", () => {
    assert.equal(isDeadlocked(withTasks([task("a", "done")])), false);
  });
});

describe("pickMember", () => {
  const state = withTasks([], {
    team: [
      { id: "a", agentId: "clustercode-a", role: "A" },
      { id: "b", agentId: "clustercode-b", role: "B" },
    ],
  });

  it("returns index -1 without a team", () => {
    assert.deepEqual(pickMember(withTasks([]), undefined), { index: -1 });
  });

  it("follows the cursor", () => {
    state.cursor = 1;
    assert.equal(pickMember(state, undefined).member?.id, "b");
  });

  it("wraps a negative cursor", () => {
    state.cursor = -1;
    assert.equal(pickMember(state, undefined).member?.id, "b");
  });

  it("lets a task pin a member", () => {
    const pinned = { id: "t", title: "t", status: "pending" as const, member: "a", updatedAt: 0 };
    assert.equal(pickMember(state, pinned).member?.id, "a");
  });

  it("falls back to rotation when the pinned member is gone", () => {
    const pinned = { id: "t", title: "t", status: "pending" as const, member: "zz", updatedAt: 0 };
    state.cursor = 0;
    assert.equal(pickMember(state, pinned).member?.id, "a");
  });
});

describe("fingerprint and stagnation", () => {
  it("ignores notes and timestamps", () => {
    const a = withTasks([{ ...task("t1", "pending"), note: "x", updatedAt: 1 }]);
    const b = withTasks([{ ...task("t1", "pending"), note: "y", updatedAt: 99 }]);
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it("counts an unchanged turn as stagnant", () => {
    const state = withTasks([task("t1", "pending")]);
    state.lastFingerprint = fingerprint(state);
    state.stagnant = 2;
    assert.equal(nextStagnant(state), 3);
  });

  it("resets stagnation after a status change", () => {
    const state = withTasks([task("t1", "running")]);
    state.lastFingerprint = "t1:pending";
    state.stagnant = 5;
    assert.equal(nextStagnant(state), 0);
  });
});

describe("brief", () => {
  it("summarises progress and the next task", () => {
    const text = brief(withTasks([task("t1", "done"), task("t2", "pending")]));
    assert.match(text, /1\/2 done/);
    assert.match(text, /next: t2/);
  });
});
