import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASK_GLYPH,
  TONE_COLOR,
  activeMember,
  clusterFor,
  footerLabel,
  panelLabel,
  progress,
  shortGoal,
  stopText,
  taskTone,
  tone,
} from "../src/status.ts";
import type { SessionView, SnapshotView } from "../src/rpc.ts";

const view = (extra: Partial<SessionView> = {}): SessionView => ({
  sessionID: "ses_1",
  goal: "ship it",
  active: true,
  round: 3,
  stoppedReason: "",
  stoppedCode: "",
  heartbeat: false,
  heartbeatMs: 60_000,
  maxRounds: -1,
  team: [],
  currentMember: "",
  tasks: [],
  updatedAt: 0,
  ...extra,
});

const task = (id: string, status: string, blocked = false) => ({
  id,
  title: `task ${id}`,
  status,
  member: "",
  blocked,
  verify: "",
  note: "",
});

describe("clusterFor", () => {
  const snapshot: SnapshotView = { updatedAt: 1, sessions: [view()] };

  it("finds the session", () => {
    assert.equal(clusterFor(snapshot, "ses_1")?.sessionID, "ses_1");
  });

  it("returns undefined without a snapshot or id", () => {
    assert.equal(clusterFor(null, "ses_1"), undefined);
    assert.equal(clusterFor(snapshot, undefined), undefined);
    assert.equal(clusterFor(snapshot, "other"), undefined);
  });
});

describe("progress", () => {
  it("counts done tasks only", () => {
    const session = view({ tasks: [task("t1", "done"), task("t2", "failed"), task("t3", "pending")] });
    assert.deepEqual(progress(session), { done: 1, total: 3, percent: 33 });
  });

  it("is zero for an empty queue", () => {
    assert.deepEqual(progress(view()), { done: 0, total: 0, percent: 0 });
  });
});

describe("tone", () => {
  it("reports failed when a stopped run has failures", () => {
    assert.equal(tone(view({ active: false, tasks: [task("t1", "failed")] })), "failed");
  });

  it("reports done when a stopped run is clean", () => {
    assert.equal(tone(view({ active: false, tasks: [task("t1", "done")] })), "done");
  });

  it("reports running while a task is running", () => {
    assert.equal(tone(view({ tasks: [task("t1", "running")] })), "running");
  });

  it("reports blocked when the next work waits on deps", () => {
    assert.equal(tone(view({ tasks: [task("t1", "pending", true)] })), "blocked");
  });
});

describe("taskTone", () => {
  it("prefers the real status over the blocked flag", () => {
    assert.equal(taskTone(task("t1", "done", true)), "done");
    assert.equal(taskTone(task("t1", "failed", true)), "failed");
    assert.equal(taskTone(task("t1", "running", true)), "running");
    assert.equal(taskTone(task("t1", "pending", true)), "blocked");
    assert.equal(taskTone(task("t1", "pending", false)), "idle");
  });
});

describe("labels", () => {
  it("shows progress, turn and seat while running", () => {
    const session = view({ currentMember: "coder", tasks: [task("t1", "done"), task("t2", "pending")] });
    assert.equal(footerLabel(session), "cluster 1/2 · turn 3 · coder");
  });

  it("says stopped when the run ended", () => {
    assert.equal(footerLabel(view({ active: false, tasks: [task("t1", "done")] })), "cluster 1/1 stopped");
    assert.equal(footerLabel(view({ active: false })), "cluster idle");
  });

  it("names the turn in the panel", () => {
    assert.equal(panelLabel(view()), "turn 3");
    assert.equal(panelLabel(view({ active: false })), "stopped");
  });

  it("exposes the active member only while running", () => {
    assert.equal(activeMember(view({ currentMember: "coder" })), "coder");
    assert.equal(activeMember(view({ active: false, currentMember: "coder" })), null);
    assert.equal(activeMember(view()), null);
  });

  it("truncates a long goal", () => {
    assert.equal(shortGoal("x".repeat(80), 10).length, 10);
    assert.equal(shortGoal("", 10), "(no goal)");
  });

  it("prefers the stop reason and falls back to the code", () => {
    assert.equal(stopText(view({ active: false, stoppedReason: "no progress", stoppedCode: "stagnant" })), "no progress");
    assert.equal(stopText(view({ active: false, stoppedCode: "stagnant" })), "stagnant");
    assert.equal(stopText(view()), "");
  });
});

describe("constants", () => {
  it("has a glyph and a colour for every tone", () => {
    for (const key of ["running", "done", "failed", "idle", "blocked"] as const) {
      assert.ok(TONE_COLOR[key]);
      assert.ok(TASK_GLYPH[key]);
    }
  });
});
