import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beforeEach } from "node:test";
import { ClusterSnapshot, SnapshotSchema } from "../src/rpc.ts";
import { publish, readSnapshot, resetSnapshots, unpublish } from "../src/snapshot.ts";
import { emptyState } from "../src/state.ts";

/**
 * The host decodes the RPC payload against the schema as a closed object. A field
 * that the schema does not list fails the whole call with `rpc.invalid_output`, and
 * the panels stay empty. This walks the actual payload, so adding a field to the
 * snapshot without adding it to the schema fails here instead of in the client.
 */
function assertSchemaCovers(schema: any, value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (schema?.type === "array") {
    assert.ok(Array.isArray(value), `${path} should be an array`);
    for (const item of value as unknown[]) assertSchemaCovers(schema.items, item, `${path}[]`);
    return;
  }
  if (schema?.type === "object") {
    assert.equal(typeof value, "object", `${path} should be an object`);
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const property = schema.properties?.[key];
      assert.ok(property, `schema is missing ${path}.${key}`);
      assertSchemaCovers(property, inner, `${path}.${key}`);
    }
  }
}

describe("snapshot payload", () => {
  beforeEach(() => {
    resetSnapshots();
  });

  it("matches the RPC schema field by field", () => {
    const state = {
      ...emptyState(),
      active: true,
      goal: "ship it",
      round: 2,
      team: [
        { id: "architect", agentId: "clustercode-architect", role: "plan", color: "#8B5CF6" },
        { id: "coder", agentId: "clustercode-coder", role: "code" },
      ],
      cursor: 1,
      heartbeat: true,
      maxRounds: 5,
      tasks: [
        { id: "t1", title: "done one", status: "done" as const, updatedAt: 1, verify: "true", note: "ok" },
        { id: "t2", title: "blocked one", status: "pending" as const, dependsOn: ["t3"], updatedAt: 2 },
        { id: "t3", title: "running one", status: "running" as const, updatedAt: 3 },
      ],
    };
    publish("ses_schema", state);

    const payload = readSnapshot();
    assertSchemaCovers(SnapshotSchema, payload, "snapshot");
    assert.equal(ClusterSnapshot.methods.get.output, SnapshotSchema);
  });

  it("publishes the human fields the UIs read", () => {
    publish("ses_view", {
      ...emptyState(),
      active: true,
      goal: "g",
      round: 4,
      maxRounds: null,
      team: [{ id: "coder", agentId: "clustercode-coder", role: "code" }],
      tasks: [
        { id: "t1", title: "a", status: "pending", dependsOn: ["t2"], updatedAt: 1 },
        { id: "t2", title: "b", status: "running", updatedAt: 2 },
      ],
    });

    const session = readSnapshot().sessions.find((s) => s.sessionID === "ses_view");
    assert.ok(session);
    assert.equal(session.maxRounds, -1);
    assert.equal(session.currentMember, "coder");
    assert.equal(session.stoppedCode, "");
    assert.equal(session.tasks[0].blocked, true);
    assert.equal(session.tasks[0].member, "");
    assert.equal(session.tasks[0].verify, "");
  });

  it("drops a session when it is unpublished", () => {
    publish("ses_gone", { ...emptyState(), goal: "x" });
    assert.equal(readSnapshot().sessions.length, 1);
    unpublish("ses_gone");
    assert.equal(readSnapshot().sessions.length, 0);
  });

  it("keeps the stop code for the UI", () => {
    publish("ses_stop", {
      ...emptyState(),
      active: false,
      stoppedCode: "stagnant",
      stoppedReason: "no progress",
    });
    const session = readSnapshot().sessions.find((s) => s.sessionID === "ses_stop");
    assert.ok(session);
    assert.equal(session.stoppedCode, "stagnant");
    assert.equal(session.stoppedReason, "no progress");
    assert.equal(session.currentMember, "");
  });

  it("resets on demand", () => {
    publish("ses_a", emptyState());
    resetSnapshots();
    assert.deepEqual(readSnapshot().sessions, []);
  });
});
