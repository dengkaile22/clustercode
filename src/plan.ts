/**
 * Automatic workflow building.
 *
 * `cluster_auto` hands the goal to the model once through
 * `ctx.experimental.generate.text` — a single call with no session, no history and
 * no tools. It does not pollute the conversation and it does not consume a cluster
 * turn. The JSON that comes back is validated here: ids are de-duplicated,
 * unknown members and dangling dependencies are dropped, cycles are detected, and
 * the result is capped at `MAX_TASKS`.
 */

import { type Task, type TeamMember, MAX_TASKS } from "./state.ts";

export interface PlannedTask {
  id: string;
  title: string;
  member?: string;
  dependsOn?: string[];
  verify?: string;
}

export type PlanIssueKind =
  | "unknown-member"
  | "unknown-dep"
  | "duplicate-id"
  | "cycle"
  | "self-dep"
  | "too-many"
  | "empty";

export interface PlanIssue {
  kind: PlanIssueKind;
  detail: string;
}

/** Pull the first JSON object out of a model reply, tolerating ```json fences and prose. */
export function extractJson(raw: string): unknown {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in model output");
  const body = candidate.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`model output is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Validate and repair a plan. Never throws on bad data: every problem becomes an
 * issue and the plan is repaired when a safe repair exists.
 */
export function validatePlan(
  input: unknown,
  team: TeamMember[],
  options: { knownIds?: Iterable<string> } = {},
): { tasks: PlannedTask[]; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const list = Array.isArray((input as { tasks?: unknown })?.tasks)
    ? ((input as { tasks: unknown[] }).tasks as unknown[])
    : [];

  if (list.length === 0) {
    issues.push({ kind: "empty", detail: "tasks[] is empty" });
    return { tasks: [], issues };
  }

  const memberIds = new Set(team.map((m) => m.id));
  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    if (tasks.length >= MAX_TASKS) {
      issues.push({ kind: "too-many", detail: `plan truncated at ${MAX_TASKS} tasks` });
      break;
    }
    const raw = (list[i] ?? {}) as Record<string, unknown>;

    let id = String(raw.id ?? `t${i + 1}`).trim() || `t${i + 1}`;
    if (seen.has(id)) {
      const renamed = `${id}-${tasks.length + 1}`;
      issues.push({ kind: "duplicate-id", detail: `${id} was duplicated and renamed to ${renamed}` });
      id = renamed;
    }
    seen.add(id);

    const wanted = raw.member ? String(raw.member) : undefined;
    const member = wanted && memberIds.has(wanted) ? wanted : undefined;
    if (wanted && !member) {
      issues.push({
        kind: "unknown-member",
        detail: `${id} asked for member "${wanted}" which is not in the team; falling back to rotation`,
      });
    }

    tasks.push({
      id,
      title: String(raw.title ?? "").trim() || `(untitled task ${id})`,
      member,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      verify: raw.verify ? String(raw.verify) : undefined,
    });
  }

  // Dependencies must exist and must not point at the task itself.
  // `knownIds` lets an appended batch depend on tasks that are already queued.
  const ids = new Set<string>([...(options.knownIds ?? []), ...tasks.map((t) => t.id)]);
  for (const task of tasks) {
    const kept: string[] = [];
    for (const dep of task.dependsOn ?? []) {
      if (dep === task.id) {
        issues.push({ kind: "self-dep", detail: `${task.id} depended on itself; dropped` });
        continue;
      }
      if (ids.has(dep)) {
        kept.push(dep);
      } else {
        issues.push({ kind: "unknown-dep", detail: `${task.id} depended on missing ${dep}; dropped` });
      }
    }
    task.dependsOn = kept;
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    issues.push({ kind: "cycle", detail: `dependency cycle: ${cycle.join(" -> ")}` });
    // Break the cycle at its back edge so the plan is still runnable. The repeated
    // node is appended last, so the task holding the offending edge is one before it.
    const ownerId = cycle[cycle.length - 2];
    const owner = tasks.find((t) => t.id === ownerId);
    if (owner) owner.dependsOn = (owner.dependsOn ?? []).filter((d) => d !== cycle[0]);
  }

  return { tasks, issues };
}

/** Three-colour DFS. Returns the first cycle as a path, or null. */
export function findCycle(tasks: PlannedTask[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const task of tasks) graph.set(task.id, task.dependsOn ?? []);

  const colour = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    colour.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const state = colour.get(dep) ?? 0;
      if (state === 1) {
        const from = stack.indexOf(dep);
        return [...stack.slice(from < 0 ? 0 : from), dep];
      }
      if (state === 0) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(node, 2);
    return null;
  };

  for (const task of tasks) {
    if ((colour.get(task.id) ?? 0) === 0) {
      const found = visit(task.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Prompt for the planning call. The `verify` commands it produces are executed for
 * real in the target project, so the platform hint matters: a POSIX one-liner on
 * Windows fails every single verification.
 */
export function planPrompt(goal: string, team: TeamMember[], maxTasks: number): string {
  const cap = Math.max(2, Math.min(MAX_TASKS, Math.floor(maxTasks) || 8));
  const roster =
    team.length > 0 ? team.map((m) => `- ${m.id}: ${m.role}`).join("\n") : "(no team: always omit member)";
  const platformHint =
    process.platform === "win32"
      ? 'The target is Windows (cmd.exe). "verify" must run in cmd directly: no test -f, grep -q, ' +
        '[ -f ], and no single-quoted paths. Prefer node -e "..." for file checks, and relative paths.'
      : "The target is a POSIX shell (sh/bash). Plain test/grep is fine, and paths are relative to the project root.";

  return [
    "You plan workflows for an automated agent cluster. Turn the goal into a task DAG.",
    "",
    `Goal: ${goal}`,
    "",
    "Available members:",
    roster,
    "",
    "Rules:",
    `1. Produce between 2 and ${cap} tasks. Every task needs a verifiable outcome.`,
    "2. dependsOn may only reference ids from this reply and must stay acyclic. Use [] when there is no dependency.",
    "3. verify is an optional single shell command: exit code 0 means the task is really done. Keep it short.",
    `   Platform constraint: ${platformHint}`,
    team.length > 0
      ? "4. member must come from the list above; omit it when unsure (rotation assigns one)."
      : "4. Always omit member.",
    "5. Write acceptance criteria, never vague goals like 'implement feature X'.",
    "",
    "Reply with one JSON object. No prose, no comments:",
    '{"tasks":[{"id":"t1","title":"...","member":"coder","dependsOn":[],"verify":"..."}]}',
  ].join("\n");
}

export interface GeneratePlanResult {
  tasks: PlannedTask[];
  issues: PlanIssue[];
  raw: string;
}

/**
 * One-shot planning call. Throws when the model cannot produce usable JSON so the
 * caller can fall back to a hand written `cluster_plan`.
 */
export async function generatePlan(
  ctx: { experimental?: { generate?: { text?: (input: { prompt: string }) => Promise<{ text?: string }> } } },
  goal: string,
  team: TeamMember[],
  maxTasks = 8,
): Promise<GeneratePlanResult> {
  const generate = ctx?.experimental?.generate?.text;
  if (typeof generate !== "function") {
    throw new Error("this host does not expose ctx.experimental.generate.text; use cluster_plan instead");
  }
  const response = await generate({ prompt: planPrompt(goal, team, maxTasks) });
  const raw = String(response?.text ?? "");
  const parsed = extractJson(raw);
  const { tasks, issues } = validatePlan(parsed, team);
  return { tasks, issues, raw };
}

/** Turn planned tasks into runtime tasks. */
export function toRuntimeTasks(list: PlannedTask[], now = Date.now()): Task[] {
  return list.map((task) => ({
    id: task.id,
    title: task.title,
    status: "pending" as const,
    member: task.member,
    dependsOn: task.dependsOn ?? [],
    verify: task.verify,
    updatedAt: now,
  }));
}
