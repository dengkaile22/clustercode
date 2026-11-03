import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractJson,
  findCycle,
  generatePlan,
  planPrompt,
  toRuntimeTasks,
  validatePlan,
} from "../src/plan.ts";
import { MAX_TASKS, type TeamMember } from "../src/state.ts";

const team: TeamMember[] = [
  { id: "architect", agentId: "clustercode-architect", role: "plan" },
  { id: "coder", agentId: "clustercode-coder", role: "code" },
];

describe("extractJson", () => {
  it("reads a bare object", () => {
    assert.deepEqual(extractJson('{"tasks":[]}'), { tasks: [] });
  });

  it("ignores a ```json fence and surrounding prose", () => {
    const raw = 'Sure, here you go:\n```json\n{"tasks":[{"title":"x"}]}\n```\nAnything else?';
    assert.deepEqual(extractJson(raw), { tasks: [{ title: "x" }] });
  });

  it("throws without an object", () => {
    assert.throws(() => extractJson("no json here"), /no JSON object/);
  });

  it("throws on broken JSON", () => {
    assert.throws(() => extractJson('{"tasks": [}'), /not valid JSON/);
  });
});

describe("validatePlan", () => {
  it("reports an empty plan", () => {
    const { tasks, issues } = validatePlan({ tasks: [] }, team);
    assert.equal(tasks.length, 0);
    assert.equal(issues[0].kind, "empty");
  });

  it("renames duplicate ids", () => {
    const { tasks, issues } = validatePlan(
      { tasks: [{ id: "t1", title: "a" }, { id: "t1", title: "b" }] },
      team,
    );
    assert.equal(tasks[1].id, "t1-2");
    assert.ok(issues.some((i) => i.kind === "duplicate-id"));
  });

  it("drops a member that is not on the roster", () => {
    const { tasks, issues } = validatePlan({ tasks: [{ title: "a", member: "ghost" }] }, team);
    assert.equal(tasks[0].member, undefined);
    assert.ok(issues.some((i) => i.kind === "unknown-member"));
  });

  it("keeps a known member", () => {
    const { tasks } = validatePlan({ tasks: [{ title: "a", member: "coder" }] }, team);
    assert.equal(tasks[0].member, "coder");
  });

  it("drops a dependency on a missing id and on itself", () => {
    const { tasks, issues } = validatePlan(
      { tasks: [{ id: "t1", title: "a", dependsOn: ["t1", "nope"] }] },
      team,
    );
    assert.deepEqual(tasks[0].dependsOn, []);
    assert.ok(issues.some((i) => i.kind === "self-dep"));
    assert.ok(issues.some((i) => i.kind === "unknown-dep"));
  });

  it("accepts a dependency on an already queued task when appending", () => {
    const { tasks, issues } = validatePlan(
      { tasks: [{ id: "t9", title: "a", dependsOn: ["t1"] }] },
      team,
      { knownIds: ["t1"] },
    );
    assert.deepEqual(tasks[0].dependsOn, ["t1"]);
    assert.equal(issues.length, 0);
  });

  it("breaks a cycle so the queue can still run", () => {
    const { tasks, issues } = validatePlan(
      {
        tasks: [
          { id: "a", title: "a", dependsOn: ["b"] },
          { id: "b", title: "b", dependsOn: ["a"] },
        ],
      },
      team,
    );
    assert.ok(issues.some((i) => i.kind === "cycle"));
    assert.equal(findCycle(tasks), null);
  });

  it("caps the plan at MAX_TASKS", () => {
    const many = Array.from({ length: MAX_TASKS + 5 }, (_, i) => ({ title: `t${i}` }));
    const { tasks, issues } = validatePlan({ tasks: many }, team);
    assert.equal(tasks.length, MAX_TASKS);
    assert.ok(issues.some((i) => i.kind === "too-many"));
  });

  it("names an untitled task instead of dropping it", () => {
    const { tasks } = validatePlan({ tasks: [{ id: "t1" }] }, team);
    assert.match(tasks[0].title, /untitled/);
  });
});

describe("findCycle", () => {
  it("returns the cycle path", () => {
    const cycle = findCycle([
      { id: "a", title: "a", dependsOn: ["b"] },
      { id: "b", title: "b", dependsOn: ["c"] },
      { id: "c", title: "c", dependsOn: ["a"] },
    ]);
    assert.deepEqual(cycle, ["a", "b", "c", "a"]);
  });

  it("returns null for a DAG", () => {
    assert.equal(
      findCycle([
        { id: "a", title: "a", dependsOn: [] },
        { id: "b", title: "b", dependsOn: ["a"] },
      ]),
      null,
    );
  });
});

describe("planPrompt", () => {
  it("lists the roster and demands JSON", () => {
    const prompt = planPrompt("ship a feature", team, 5);
    assert.match(prompt, /ship a feature/);
    assert.match(prompt, /architect/);
    assert.match(prompt, /between 2 and 5 tasks/);
    assert.match(prompt, /JSON object/);
  });

  it("tells the model to omit member when there is no team", () => {
    assert.match(planPrompt("x", [], 4), /Always omit member/);
  });

  it("carries a platform specific verify hint", () => {
    const prompt = planPrompt("x", team, 4);
    assert.match(prompt, process.platform === "win32" ? /cmd\.exe/ : /POSIX shell/);
  });
});

describe("generatePlan", () => {
  it("parses and validates the model answer", async () => {
    const ctx = {
      experimental: {
        generate: {
          text: async () => ({
            text: '```json\n{"tasks":[{"id":"t1","title":"a","verify":"node -e 1"}]}\n```',
          }),
        },
      },
    };
    const result = await generatePlan(ctx, "goal", team, 4);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].verify, "node -e 1");
  });

  it("throws when the host cannot generate", async () => {
    await assert.rejects(() => generatePlan({}, "goal", team), /cluster_plan/);
  });

  it("propagates unparsable output so the caller can fall back", async () => {
    const ctx = { experimental: { generate: { text: async () => ({ text: "sorry, no" }) } } };
    await assert.rejects(() => generatePlan(ctx, "goal", team), /no JSON object/);
  });
});

describe("toRuntimeTasks", () => {
  it("starts every task as pending", () => {
    const tasks = toRuntimeTasks([{ id: "t1", title: "a", dependsOn: [] }]);
    assert.equal(tasks[0].status, "pending");
    assert.deepEqual(tasks[0].dependsOn, []);
  });
});
