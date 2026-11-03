/**
 * The scheduler.
 *
 * One pure decision function decides what should happen at the end of a turn, and
 * one small commit function applies that decision to the state. The idle hook, the
 * heartbeat timer and `/cluster-resume` all go through here, so the guard order
 * (`finished -> deadlock -> maxRounds -> stagnant`) is written once and cannot
 * drift between the fast path and the recovery path. That drift is exactly how
 * "heartbeat wakes a run that already hit its round cap" bugs happen.
 */

import {
  type ClusterState,
  type StopCode,
  type Task,
  type TeamMember,
  fingerprint,
  isDeadlocked,
  isFinished,
  nextStagnant,
  nextTask,
  pickMember,
} from "./state.ts";

export type Decision =
  /** Not running: nothing to do. */
  | { type: "wait"; code: "idle"; reason: string }
  /** Background subagents/shells are still alive; they will wake us again. */
  | { type: "wait"; code: "background"; reason: string; count: number }
  /** The run must stop now. */
  | { type: "stop"; code: Exclude<StopCode, "">; reason: string }
  /** Hand the next turn back to the model. */
  | {
      type: "continue";
      task?: Task;
      member?: TeamMember;
      memberIndex: number;
      round: number;
      stagnant: number;
      fingerprint: string;
    };

export interface DecideInput {
  /** Number of background jobs still running for this session. */
  background?: number;
  /** Skip the `active` check, used by `/cluster-resume` before it flips the flag. */
  force?: boolean;
}

export function decide(state: ClusterState, input: DecideInput = {}): Decision {
  if (!state.active && !input.force) {
    return { type: "wait", code: "idle", reason: "cluster is not active" };
  }

  // Background work wins: those jobs wake the same hook when they finish, and
  // racing them corrupts the turn count.
  const background = input.background ?? 0;
  if (background > 0) {
    return {
      type: "wait",
      code: "background",
      reason: `waiting for ${background} background job(s)`,
      count: background,
    };
  }

  if (isFinished(state)) {
    return { type: "stop", code: "finished", reason: "all tasks are done or failed" };
  }

  if (isDeadlocked(state)) {
    return {
      type: "stop",
      code: "deadlock",
      reason:
        "task graph is deadlocked: every remaining task waits on a dependency. " +
        "Check for cycles in dependsOn or a failed upstream task.",
    };
  }

  if (state.maxRounds !== null && state.round >= state.maxRounds) {
    return { type: "stop", code: "max-rounds", reason: `round limit reached (${state.maxRounds})` };
  }

  const stagnant = nextStagnant(state);
  if (state.maxStagnant > 0 && stagnant >= state.maxStagnant) {
    return {
      type: "stop",
      code: "stagnant",
      reason: `no task progress for ${stagnant} turns in a row`,
    };
  }

  const task = nextTask(state);
  const { member, index } = pickMember(state, task);
  return {
    type: "continue",
    task,
    member,
    memberIndex: index,
    round: state.round + 1,
    stagnant,
    fingerprint: fingerprint(state),
  };
}

/**
 * Apply a decision. Only `continue` and `stop` mutate; `wait` is a no-op.
 * The cursor is *not* touched here: callers advance it after a successful agent
 * switch, so a failed switch never skips a seat.
 */
export function commit(state: ClusterState, decision: Decision, now = Date.now()): ClusterState {
  if (decision.type === "stop") {
    state.active = false;
    state.stoppedCode = decision.code;
    state.stoppedReason = decision.reason;
    state.updatedAt = now;
    return state;
  }
  if (decision.type === "continue") {
    state.round = decision.round;
    state.stagnant = decision.stagnant;
    state.lastFingerprint = decision.fingerprint;
    state.updatedAt = now;
  }
  return state;
}

/** Advance the rotation pointer after a successful `switchAgent`. */
export function advanceCursor(state: ClusterState, memberIndex: number): void {
  if (memberIndex < 0 || state.team.length === 0) return;
  state.cursor = (memberIndex + 1) % state.team.length;
}

/** Text of the synthetic message that carries the next turn. */
export function turnMessage(state: ClusterState, decision: Extract<Decision, { type: "continue" }>, switchNote = ""): string {
  const who = decision.member ? `You are ${decision.member.id} (${decision.member.role}).\n` : "";
  if (!decision.task) {
    return (
      `[clustercode] turn ${decision.round}${switchNote}\n${who}` +
      `No runnable pending task left. Run cluster_status to verify, then finish with cluster_update.`
    );
  }
  const deps = decision.task.dependsOn?.length
    ? `Dependencies satisfied: ${decision.task.dependsOn.join(", ")}.\n`
    : "";
  return (
    `[clustercode] turn ${decision.round}${switchNote}\n${who}` +
    `Continue with ${decision.task.id}: ${decision.task.title}\n` +
    deps +
    `When it is finished call cluster_update(id="${decision.task.id}", status="done"), then move on. ` +
    `Do not ask the user for confirmation.`
  );
}
