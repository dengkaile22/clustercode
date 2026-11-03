import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceCursor, commit, decide, turnMessage } from "../src/scheduler.ts";
import { type ClusterState, type Task, emptyState, fingerprint } from "../src/state.ts";

const task = (id: string, status: Task["status"], dependsOn: string[] = []): Task => ({
  id,
  title: `task ${id}`,
  status,
  dependsOn,
  updatedAt: 0,
});

const state = (tasks: Task[], extra: Partial<ClusterState> = {}): ClusterState => ({
  ...emptyState(),
  active: true,
  goal: "ship it",
  tasks,
  ...extra,
});

describe("decide: wait paths", () => {
  it("waits when the cluster is not active", () => {
    const decision = decide(state([task("t1", "pending")], { active: false }));
    assert.equal(decision.type, "wait");
    assert.equal(decision.type === "wait" && decision.code, "idle");
  });

  it("waits for background work so it does not race a subagent", () => {
    const decision = decide(state([task("t1", "pending")]), { background: 2 });
    if (decision.type !== "wait" || decision.code !== "background") {
      throw new Error(`expected a background wait, got ${decision.type}`);
    }
    assert.equal(decision.count, 2);
  });
});

describe("decide: stop paths", () => {
  it("stops when every task ended", () => {
    const decision = decide(state([task("t1", "done"), task("t2", "failed")]));
    assert.equal(decision.type, "stop");
    assert.equal(decision.type === "stop" && decision.code, "finished");
  });

  it("stops on a deadlocked graph instead of burning turns", () => {
    const decision = decide(state([task("t1", "pending", ["t2"]), task("t2", "pending", ["t1"])]));
    assert.equal(decision.type, "stop");
    assert.equal(decision.type === "stop" && decision.code, "deadlock");
  });

  it("stops at the round cap", () => {
    const decision = decide(state([task("t1", "pending")], { round: 3, maxRounds: 3 }));
    assert.equal(decision.type, "stop");
    assert.equal(decision.type === "stop" && decision.code, "max-rounds");
  });

  it("stops when the next turn would exceed the stagnation limit", () => {
    const current = state([task("t1", "pending")], { stagnant: 2, maxStagnant: 3 });
    current.lastFingerprint = fingerprint(current);
    const decision = decide(current);
    assert.equal(decision.type, "stop");
    assert.equal(decision.type === "stop" && decision.code, "stagnant");
  });

  it("does not apply the stagnation guard when it is disabled", () => {
    const current = state([task("t1", "pending")], { stagnant: 99, maxStagnant: 0 });
    current.lastFingerprint = fingerprint(current);
    assert.equal(decide(current).type, "continue");
  });

  it("checks finished before the round cap", () => {
    const current = state([task("t1", "done")], { round: 5, maxRounds: 1 });
    const decision = decide(current);
    assert.equal(decision.type === "stop" && decision.code, "finished");
  });
});

describe("decide: continue path", () => {
  it("counts the next turn and picks the task", () => {
    const decision = decide(state([task("t1", "pending")]));
    assert.equal(decision.type, "continue");
    if (decision.type !== "continue") return;
    assert.equal(decision.round, 1);
    assert.equal(decision.task?.id, "t1");
    assert.equal(decision.memberIndex, -1);
    assert.equal(decision.stagnant, 0);
  });

  it("carries the current fingerprint so the next turn can compare", () => {
    const current = state([task("t1", "running")]);
    const decision = decide(current);
    assert.equal(decision.type === "continue" && decision.fingerprint, fingerprint(current));
  });

  it("picks the rotation seat and reports its index", () => {
    const current = state([task("t1", "pending")], {
      team: [
        { id: "architect", agentId: "clustercode-architect", role: "plan" },
        { id: "coder", agentId: "clustercode-coder", role: "code" },
      ],
      cursor: 1,
    });
    const decision = decide(current);
    assert.equal(decision.type === "continue" && decision.member?.id, "coder");
    assert.equal(decision.type === "continue" && decision.memberIndex, 1);
  });

  it("lets force bypass the active flag, for /cluster-resume", () => {
    const decision = decide(state([task("t1", "pending")], { active: false }), { force: true });
    assert.equal(decision.type, "continue");
  });
});

describe("commit", () => {
  it("applies a continue decision", () => {
    const current = state([task("t1", "pending")]);
    const decision = decide(current);
    commit(current, decision);
    assert.equal(current.round, 1);
    assert.equal(current.lastFingerprint, fingerprint(current));
    assert.equal(current.active, true);
  });

  it("applies a stop decision with a machine readable code", () => {
    const current = state([task("t1", "done")]);
    commit(current, decide(current));
    assert.equal(current.active, false);
    assert.equal(current.stoppedCode, "finished");
    assert.match(current.stoppedReason ?? "", /done or failed/);
  });

  it("leaves state untouched for a wait decision", () => {
    const current = state([task("t1", "pending")]);
    const before = JSON.stringify(current);
    commit(current, decide(current, { background: 1 }));
    assert.equal(JSON.stringify(current), before);
  });
});

describe("advanceCursor", () => {
  it("wraps around the roster", () => {
    const current = state([], {
      team: [
        { id: "a", agentId: "clustercode-a", role: "A" },
        { id: "b", agentId: "clustercode-b", role: "B" },
      ],
      cursor: 1,
    });
    advanceCursor(current, 1);
    assert.equal(current.cursor, 0);
  });

  it("ignores the no-team index", () => {
    const current = state([]);
    advanceCursor(current, -1);
    assert.equal(current.cursor, 0);
  });
});

describe("turnMessage", () => {
  it("names the task, the seat and the follow-up call", () => {
    const current = state([task("t0", "done"), task("t1", "pending", ["t0"])], {
      team: [{ id: "coder", agentId: "clustercode-coder", role: "write code" }],
    });
    const decision = decide(current);
    if (decision.type !== "continue") throw new Error(`expected continue, got ${decision.type}`);
    commit(current, decision);
    const text = turnMessage(current, decision, " (coder takes this turn)");
    assert.match(text, /turn 1/);
    assert.match(text, /You are coder/);
    assert.match(text, /t1/);
    assert.match(text, /Dependencies satisfied: t0/);
    assert.match(text, /cluster_update/);
  });

  it("tells the model to wrap up when nothing is runnable", () => {
    const current = state([task("t1", "done")], { active: true, maxRounds: null });
    const decision = { type: "continue" as const, memberIndex: -1, round: 2, stagnant: 0, fingerprint: "" };
    const text = turnMessage(current, decision);
    assert.match(text, /No runnable pending task/);
  });
});
