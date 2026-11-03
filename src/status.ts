/**
 * Display helpers shared by the TUI, the Desktop panel and the tests.
 *
 * No Solid, no DOM, no file system: both UIs must agree on wording, otherwise the
 * status bar says 3/5 while the panel says 4/5 and nobody trusts either.
 */

import type { SessionView, SnapshotView } from "./rpc.ts";

export type ClusterTone = "running" | "done" | "failed" | "idle" | "blocked";

export const TONE_COLOR: Record<ClusterTone, string> = {
  running: "#22C55E",
  done: "#22C55E",
  failed: "#EF4444",
  idle: "#64748B",
  blocked: "#F59E0B",
};

export const TASK_GLYPH: Record<ClusterTone, string> = {
  running: "●",
  done: "●",
  failed: "×",
  idle: "○",
  blocked: "⊘",
};

export function clusterFor(
  snapshot: SnapshotView | null | undefined,
  sessionID: string | undefined,
): SessionView | undefined {
  if (!snapshot || !sessionID) return undefined;
  return snapshot.sessions.find((s) => s.sessionID === sessionID);
}

export function progress(session: SessionView): { done: number; total: number; percent: number } {
  const total = session.tasks.length;
  const done = session.tasks.filter((t) => t.status === "done").length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export function activeMember(session: SessionView): string | null {
  return session.active && session.currentMember ? session.currentMember : null;
}

export function tone(session: SessionView): ClusterTone {
  if (!session.active) {
    return session.tasks.some((t) => t.status === "failed") ? "failed" : "done";
  }
  if (session.tasks.some((t) => t.status === "running")) return "running";
  if (session.tasks.some((t) => t.blocked)) return "blocked";
  return "running";
}

/** One short line for the prompt footer. Must not wrap. */
export function footerLabel(session: SessionView): string {
  const { done, total } = progress(session);
  if (!session.active) {
    return total === 0 ? "cluster idle" : `cluster ${done}/${total} stopped`;
  }
  const who = activeMember(session);
  return `cluster ${done}/${total} · turn ${session.round}${who ? ` · ${who}` : ""}`;
}

export function panelLabel(session: SessionView): string {
  return session.active ? `turn ${session.round}` : "stopped";
}

/** `blocked` wins over `pending`: a task waiting on a dependency is not merely idle. */
export function taskTone(task: SessionView["tasks"][number]): ClusterTone {
  if (task.status === "done") return "done";
  if (task.status === "failed") return "failed";
  if (task.status === "running") return "running";
  return task.blocked ? "blocked" : "idle";
}

export function shortGoal(goal: string, max = 60): string {
  const text = goal.trim() || "(no goal)";
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Human wording for a stop code, used in tool output and panels. */
export function stopText(session: SessionView): string {
  if (session.active) return "";
  if (session.stoppedReason) return session.stoppedReason;
  return session.stoppedCode || "stopped";
}
