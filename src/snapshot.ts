/**
 * In-memory snapshot store shared by the RPC handler and (indirectly) both UIs.
 *
 * The server half publishes on every state change; the UI halves poll the RPC and
 * never read this structure directly. Keeping it in memory avoids a state file that
 * goes stale and confuses users ("the panel shows a cluster that ended yesterday").
 */

import { type ClusterState, depsSatisfied, nextTask, pickMember } from "./state.ts";
import type { SessionView, SnapshotView } from "./rpc.ts";

const sessions = new Map<string, SessionView>();

function toView(sessionID: string, state: ClusterState): SessionView {
  const current = nextTask(state);
  const { member } = pickMember(state, current);
  return {
    sessionID,
    goal: state.goal,
    active: state.active,
    round: state.round,
    stoppedReason: state.stoppedReason ?? "",
    stoppedCode: state.stoppedCode ?? "",
    heartbeat: state.heartbeat,
    heartbeatMs: state.heartbeatMs,
    maxRounds: state.maxRounds === null ? -1 : state.maxRounds,
    team: state.team.map((m) => ({ id: m.id, role: m.role, color: m.color ?? "" })),
    currentMember: state.active ? (member?.id ?? "") : "",
    tasks: state.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      member: t.member ?? "",
      blocked: t.status === "pending" && !depsSatisfied(state, t),
      verify: t.verify ?? "",
      note: t.note ?? "",
    })),
    updatedAt: Date.now(),
  };
}

/** Record the state of one session. Cheap: no I/O, safe to call on every turn. */
export function publish(sessionID: string, state: ClusterState): void {
  sessions.set(sessionID, toView(sessionID, state));
}

export function unpublish(sessionID: string): void {
  sessions.delete(sessionID);
}

/**
 * Snapshot for the RPC handler. The JSON round-trip removes `undefined` values:
 * the host decodes against the schema and treats `undefined` as a type error.
 */
export function readSnapshot(now = Date.now()): SnapshotView {
  const payload = { updatedAt: now, sessions: [...sessions.values()] };
  return JSON.parse(JSON.stringify(payload)) as SnapshotView;
}

/** Test hook: start from a clean store. */
export function resetSnapshots(): void {
  sessions.clear();
}

export function snapshotSize(): number {
  return sessions.size;
}
