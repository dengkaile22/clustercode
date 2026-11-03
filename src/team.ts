/**
 * Team rendering: a member is a markdown agent file on disk.
 *
 * OpenCode V2 has no "create agent" API — the editor exposes list/get/update/remove
 * and the client exposes list/get — so writing `<agents>/clustercode-<id>.md` and
 * calling `ctx.agent.reload()` is the only way to add seats. Files this plugin
 * writes carry a `managed-by` marker; a same-named file without it is treated as
 * hand written and never overwritten or deleted.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TeamMember } from "./state.ts";

export const MANAGED_MARKER = "<!-- managed-by: clustercode -->";
/** Prefix for every member agent file. Keeps clustercode clear of other plugins' files. */
export const AGENT_PREFIX = "clustercode-";
/** The single primary agent users can reach with Shift+Tab. */
export const CLUSTER_ID = "clustercode";

export const agentsDir = () =>
  process.env.CLUSTERCODE_AGENTS_DIR || join(homedir(), ".config", "opencode", "agents");

export const agentIdFor = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

export interface MemberSpec {
  id: string;
  role: string;
  color?: string;
  /** Extra role instructions appended after the shared rules. */
  extra?: string;
  /**
   * Hide the agent from the agent list / Shift+Tab cycle. Members default to hidden:
   * the only way they enter a session is `switchAgent`, so listing them would just
   * bloat the user's mode picker. The `clustercode` agent itself must stay visible.
   */
  hidden?: boolean;
  /** Read-only seat: the frontmatter denies `edit:*` tool calls. */
  readOnly?: boolean;
  /** Optional `provider/model` override for this seat. */
  model?: string;
}

/** Personality of the mode the user reaches with Shift+Tab. */
export const CLUSTER_SPEC: MemberSpec = {
  id: CLUSTER_ID,
  role: "Cluster dispatcher: turns a request into verifiable tasks and lets the plugin hand back the next turn until the queue drains",
  color: "#22C55E",
  hidden: false,
  extra: [
    "You are not doing the work alone. You hand it to a cluster queue, and the plugin pushes the next turn back to you when a turn ends.",
    "",
    "## What to do with a request",
    "1. Two or more independently verifiable steps -> call `cluster_auto` (one goal line) or `cluster_plan` (explicit tasks) right away.",
    "2. A single small edit -> just do it. Do not start a long run for a one-liner.",
    "3. The first run should pass `maxRounds: 5` unless the user explicitly asked for no limit.",
    "",
    "## How a turn works",
    "- Find the task for this turn with `cluster_status` or the injected `[clustercode]` note.",
    '- Finish it, call `cluster_update(id, "done")`, then continue with the next one. Never wait for confirmation.',
    '- Stuck on the same error three turns in a row: mark it `failed`, write down the blocker, move on.',
    "",
    "## Wrapping up",
    "When the queue drains, report briefly: what shipped, what failed, why, and what to do next. Do not replay the turn log.",
  ].join("\n"),
};

/** Built-in roster used when the caller does not pass `members`. */
export const DEFAULT_TEAM: MemberSpec[] = [
  {
    id: "architect",
    role: "Break down the request, fix interfaces and boundaries, write the implementation plan; no production code",
    color: "#8B5CF6",
    extra:
      "Your output is a plan the next person can execute without guessing: file paths, signatures, edit points, acceptance criteria.\n" +
      'Never leave "TBD" or "depends on the situation". If unsure, pick one option and state why.',
  },
  {
    id: "coder",
    role: "Implement the plan, one runnable minimal change at a time",
    color: "#22C55E",
    extra:
      "Read the files the plan points at before editing, and say so when reality differs from the plan.\n" +
      "Verify your own change (run it, read the diff) before marking anything done.",
  },
  {
    id: "reviewer",
    role: "Read-only review: correctness, edge cases, regression risk; changes no files",
    color: "#F59E0B",
    readOnly: true,
    extra:
      "You have no write access. Do not edit files and do not 'fix it while you are there'.\n" +
      "Order findings by severity and cite file plus line. If it is clean, say it is clean.",
  },
  {
    id: "tester",
    role: "Run tests, reproduce bugs, prove that the acceptance criteria really hold",
    color: "#EF4444",
    extra:
      "Only real command output counts. A test you did not run is not a passing test.\n" +
      "On failure give the smallest reproduction and the raw error text, never a paraphrase.",
  },
];

function frontmatter(spec: MemberSpec): string {
  // YAML: a value starting with `[` is parsed as a flow sequence, so the description
  // must be quoted. JSON.stringify produces a valid double-quoted YAML scalar and
  // escapes inner quotes for free.
  const lines = [
    "---",
    `description: ${JSON.stringify(`[team/${spec.id}] ${spec.role}`)}`,
    "mode: primary",
    `color: ${JSON.stringify(spec.color ?? "#64748B")}`,
  ];
  if (spec.model) lines.push(`model: ${JSON.stringify(spec.model)}`);
  // Members stay out of the Shift+Tab cycle; only clustercode itself is user visible.
  if (spec.hidden !== false) lines.push("hidden: true");
  if (spec.readOnly) {
    // The action must be the policy enum `tool.use` and the resource is
    // `<tool>:<input>`. `action: edit` matches nothing and silently grants write
    // access — a real bug in an earlier iteration.
    lines.push(
      "permissions:",
      '  - action: "tool.use"',
      '    resource: "edit:*"',
      "    effect: deny",
      '  - action: "tool.use"',
      '    resource: "edit:**"',
      "    effect: deny",
    );
  }
  lines.push("---");
  return lines.join("\n");
}

function body(spec: MemberSpec, team: MemberSpec[]): string {
  const roster = team.map((m) => `- ${m.id}: ${m.role}`).join("\n");
  return [
    MANAGED_MARKER,
    "",
    `You are ${spec.id}, one seat in a long-running agent team.`,
    "",
    "## Team",
    roster,
    "",
    "The team hands off turn by turn and exactly one seat works per turn. Do your leg well and leave the rest to the next turn.",
    "",
    "## Shared rules",
    "- Start by checking `cluster_status`; never guess the current turn or task.",
    "- Stay inside your role. Other seats own their work.",
    '- Call `cluster_update(id, "done")` when the task is finished. If it cannot be finished, mark it `failed` and write the blocker in `note`.',
    "- After updating, continue with the next task assigned to you. **Do not ask the user for confirmation.**",
    "- Never invent verification. A test you did not run is not a passing test.",
    "",
    "## This seat",
    spec.extra ?? "(no extra instructions)",
  ].join("\n");
}

export function renderAgent(spec: MemberSpec, team: MemberSpec[]): string {
  return `${frontmatter(spec)}\n\n${body(spec, team)}\n`;
}

/** The file behind the user-facing `clustercode` mode. */
export function renderClusterAgent(team: MemberSpec[] = DEFAULT_TEAM): string {
  const roster = [CLUSTER_SPEC, ...team.filter((m) => m.id !== CLUSTER_SPEC.id)]
    .map((m) => `- ${m.id}: ${m.role}`)
    .join("\n");
  return `${frontmatter(CLUSTER_SPEC)}\n\n${[
    MANAGED_MARKER,
    "",
    "You are in **cluster mode**. The user pressed Shift+Tab to get here because they want the work handed to the agent cluster.",
    "",
    "## Roster",
    roster,
    "",
    "The plugin swaps seats with `switchAgent` between turns; just play the seat you are in. Member agents live in",
    "`~/.config/opencode/agents/clustercode-*.md`, are managed by the plugin, and must not be edited by hand.",
    "",
    "## Your job",
    CLUSTER_SPEC.extra ?? "",
    "",
    "## Boundaries",
    "- Never invent verification. A test you did not run is not a passing test.",
    "- Marking a task done runs its `verify` command for real, so verify before you claim success.",
    "- Stop and ask once before destructive work (deleting files, rewriting history, pushing to a remote).",
  ].join("\n")}\n`;
}

export interface ClusterAgentSync {
  written: boolean;
  skipped: boolean;
  dir: string;
  path: string;
  reason?: string;
}

export const clusterAgentPath = () => join(agentsDir(), `${CLUSTER_ID}.md`);

/**
 * Write the Shift+Tab entry point. A same-named file that this plugin did not write
 * is left alone unless `adopt` is set.
 */
export function syncClusterAgent(options: { adopt?: boolean } = {}): ClusterAgentSync {
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${CLUSTER_ID}.md`);

  if (existsSync(path) && !isManaged(path) && !options.adopt) {
    return {
      written: false,
      skipped: true,
      dir,
      path,
      reason:
        "an existing hand-written clustercode.md was left untouched (delete it or pass adoptCluster: true to let the plugin own it)",
    };
  }

  writeFileSync(path, renderClusterAgent(DEFAULT_TEAM), "utf8");
  return { written: true, skipped: false, dir, path };
}

function isManaged(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

export interface SyncResult {
  written: string[];
  skipped: string[];
  removed: string[];
  dir: string;
}

/**
 * Write every member to the agent directory and delete managed files that are no
 * longer wanted, so shrinking a team does not leave orphan agents behind.
 */
export function syncAgents(specs: MemberSpec[], keep?: string[]): SyncResult {
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];

  const wanted = new Set(specs.map((s) => `${agentIdFor(s.id)}.md`));

  for (const spec of specs) {
    const file = `${agentIdFor(spec.id)}.md`;
    const path = join(dir, file);
    if (existsSync(path) && !isManaged(path)) {
      skipped.push(file);
      continue;
    }
    writeFileSync(path, renderAgent(spec, specs), "utf8");
    written.push(file);
  }

  const keepSet = new Set(keep ?? [...wanted]);
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(AGENT_PREFIX) || !file.endsWith(".md")) continue;
    if (wanted.has(file) || keepSet.has(file)) continue;
    const path = join(dir, file);
    if (!isManaged(path)) continue;
    try {
      unlinkSync(path);
      removed.push(file);
    } catch {
      /* locked file: leave it for the next run */
    }
  }

  return { written, skipped, removed, dir };
}

export function toMembers(specs: MemberSpec[]): TeamMember[] {
  return specs.map((spec) => ({
    id: spec.id,
    agentId: agentIdFor(spec.id),
    role: spec.role,
    color: spec.color,
  }));
}
