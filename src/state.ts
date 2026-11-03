/**
 * Cluster state: the task DAG, the team roster, the rotation cursor and the
 * counters used by the guards.
 *
 * Everything in this module is pure. No host imports, no I/O, no timers, so the
 * scheduler, the RPC snapshot, the tools and the UI can all share one source of
 * truth and be unit tested without an OpenCode process.
 */

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Pin the task to one team member. Omitted = whoever the rotation points at. */
  member?: string;
  /** Ids that must be `done` before this task becomes runnable. */
  dependsOn?: string[];
  /** Shell command that must exit 0 before this task can be marked `done`. */
  verify?: string;
  note?: string;
  /** How many times the task went back to pending via `cluster_retry`. */
  attempts?: number;
  updatedAt: number;
}

/** One seat in the team. `agentId` is the on-disk agent that takes this seat. */
export interface TeamMember {
  id: string;
  agentId: string;
  role: string;
  color?: string;
}

/** Machine readable reason a cluster is not running any more. Empty = still running. */
export type StopCode = "finished" | "max-rounds" | "stagnant" | "deadlock" | "user" | "";

export interface ClusterState {
  active: boolean;
  goal: string;
  /** How many turns this run has taken. Compared against `maxRounds`. */
  round: number;
  /** `null` = no cap, run until the queue drains. */
  maxRounds: number | null;
  /** Stop after this many turns without any task changing status. 0 disables the guard. */
  maxStagnant: number;
  stagnant: number;
  /** Status fingerprint of the previous turn, used by the stagnation guard. */
  lastFingerprint: string;
  tasks: Task[];
  /** Empty = solo mode, the plugin never swaps agents. */
  team: TeamMember[];
  /** Rotation pointer. Advanced only after a successful agent switch. */
  cursor: number;
  /** Wake an idle session every `heartbeatMs` so a 24h run survives interruptions. */
  heartbeat: boolean;
  heartbeatMs: number;
  lastWakeAt?: number;
  createdAt: number;
  updatedAt: number;
  stoppedReason?: string;
  stoppedCode: StopCode;
}

export const DEFAULT_MAX_STAGNANT = 12;
export const DEFAULT_HEARTBEAT_MS = 60_000;
/** The scheduler refuses to wake a session more often than this. */
export const MIN_HEARTBEAT_MS = 15_000;
/** Hard cap on a single plan; keeps a runaway model from filling the disk. */
export const MAX_TASKS = 64;

const KEY_PREFIX = "cluster:";

export const keyFor = (sessionID: string) => `${KEY_PREFIX}${sessionID}`;
export const sessionIdFromKey = (key: string) =>
  key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : "";
export const KEY_PREFIX_FOR_SCAN = KEY_PREFIX;

export function emptyState(now = Date.now()): ClusterState {
  return {
    active: false,
    goal: "",
    round: 0,
    maxRounds: null,
    maxStagnant: DEFAULT_MAX_STAGNANT,
    stagnant: 0,
    lastFingerprint: "",
    tasks: [],
    team: [],
    cursor: 0,
    heartbeat: false,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    createdAt: now,
    updatedAt: now,
    stoppedCode: "",
  };
}

/** Clamp a user supplied stagnant limit. Invalid input falls back to the default. */
export function stagnantLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STAGNANT;
  return Math.floor(n);
}

/** Normalise a value read back from storage. Never throws, always returns a usable state. */
export function hydrate(raw: unknown): ClusterState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const state: ClusterState = { ...base, ...(raw as ClusterState) };

  if (!Array.isArray(state.team)) state.team = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  state.tasks = state.tasks
    .filter((t) => t && typeof t === "object" && typeof t.id === "string")
    .map((t) => ({
      ...t,
      status: isStatus(t.status) ? t.status : "pending",
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      updatedAt: Number(t.updatedAt) || state.updatedAt,
    }));

  if (typeof state.cursor !== "number" || !Number.isFinite(state.cursor)) state.cursor = 0;
  if (typeof state.round !== "number" || !Number.isFinite(state.round)) state.round = 0;
  if (state.maxRounds !== null && (typeof state.maxRounds !== "number" || !Number.isFinite(state.maxRounds))) {
    state.maxRounds = null;
  }
  if (typeof state.maxStagnant !== "number" || !Number.isFinite(state.maxStagnant) || state.maxStagnant < 0) {
    state.maxStagnant = DEFAULT_MAX_STAGNANT;
  }
  if (typeof state.stagnant !== "number" || !Number.isFinite(state.stagnant)) state.stagnant = 0;
  if (typeof state.heartbeat !== "boolean") state.heartbeat = false;
  if (typeof state.heartbeatMs !== "number" || !Number.isFinite(state.heartbeatMs)) {
    state.heartbeatMs = DEFAULT_HEARTBEAT_MS;
  }
  if (typeof state.goal !== "string") state.goal = "";
  if (typeof state.stoppedCode !== "string") state.stoppedCode = "";
  return state;
}

function isStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "running" || value === "done" || value === "failed";
}

export interface Counts {
  pending: number;
  running: number;
  done: number;
  failed: number;
  total: number;
}

export function counts(state: ClusterState): Counts {
  const c: Counts = { pending: 0, running: 0, done: 0, failed: 0, total: state.tasks.length };
  for (const task of state.tasks) {
    if (isStatus(task.status)) c[task.status] += 1;
  }
  return c;
}

/**
 * Are all dependencies of `task` satisfied?
 * A `failed` dependency is *not* satisfied: stopping is better than building on a
 * broken premise. The scheduler then reports a deadlock instead of burning turns.
 */
export function depsSatisfied(state: ClusterState, task: Task): boolean {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return true;
  const done = new Set(state.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return deps.every((id) => done.has(id));
}

/** Pending tasks that are still waiting for their dependencies. */
export function blockedTasks(state: ClusterState): Task[] {
  return state.tasks.filter((t) => t.status === "pending" && !depsSatisfied(state, t));
}

/**
 * The task for the next turn: an interrupted `running` task first, then the first
 * runnable `pending` task in declaration order.
 */
export function nextTask(state: ClusterState): Task | undefined {
  const running = state.tasks.find((t) => t.status === "running");
  if (running) return running;
  return state.tasks.find((t) => t.status === "pending" && depsSatisfied(state, t));
}

export function isFinished(state: ClusterState): boolean {
  return state.tasks.length > 0 && state.tasks.every((t) => t.status === "done" || t.status === "failed");
}

/**
 * Work is left but nothing can run. That means a dependency cycle, a dependency on
 * something that already failed, or a `dependsOn` pointing at a task that was
 * removed. Reporting it immediately beats spinning until the stagnation guard fires.
 */
export function isDeadlocked(state: ClusterState): boolean {
  if (isFinished(state)) return false;
  if (state.tasks.length === 0) return false;
  return !state.tasks.some(
    (t) => t.status === "running" || (t.status === "pending" && depsSatisfied(state, t)),
  );
}

/**
 * Rotation pick. A task that names a member wins; otherwise the cursor decides.
 * `index` is -1 when there is no team, so callers can tell "no team" from "seat 0".
 */
export function pickMember(
  state: ClusterState,
  task: Task | undefined,
): { member?: TeamMember; index: number } {
  if (state.team.length === 0) return { index: -1 };
  if (task?.member) {
    const pinned = state.team.findIndex((m) => m.id === task.member);
    if (pinned >= 0) return { member: state.team[pinned], index: pinned };
  }
  const size = state.team.length;
  const index = ((state.cursor % size) + size) % size;
  return { member: state.team[index], index };
}

/** Status-only fingerprint. Notes and timestamps deliberately do not count as progress. */
export function fingerprint(state: ClusterState): string {
  return state.tasks.map((t) => `${t.id}:${t.status}`).join("|");
}

/** How many turns in a row produced no status change, if this turn also produces none. */
export function nextStagnant(state: ClusterState): number {
  return fingerprint(state) === state.lastFingerprint ? state.stagnant + 1 : 0;
}

/** One-line summary used by the tools and the injected system card. */
export function brief(state: ClusterState): string {
  const c = counts(state);
  const current = nextTask(state);
  const { member } = pickMember(state, current);
  const blocked = blockedTasks(state).length;
  return [
    `${state.active ? "Running" : "Stopped"} · turn ${state.round}`,
    `goal: ${state.goal || "(none)"}`,
    `tasks: ${c.done}/${c.total} done, ${c.pending} pending${
      blocked ? ` (${blocked} waiting on deps)` : ""
    }, ${c.running} running, ${c.failed} failed`,
    current ? `next: ${current.id} ${current.title}` : "next: none (check dependencies)",
    state.team.length > 0
      ? `team: ${state.team.map((m) => m.id).join(" -> ")}${
          member ? ` (this turn: ${member.id})` : ""
        }`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
