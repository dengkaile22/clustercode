/**
 * clustercode — server half.
 *
 * Three paths keep a run alive:
 *   1. `experimental.idle`  — hands the next turn back at the end of every turn (main path, zero delay)
 *   2. heartbeat timer      — recovery for interrupted sessions, process restarts and missed idle hooks
 *   3. `cluster_auto`       — the plugin calls the model itself to compile a goal into a task DAG
 *
 * Both paths build their decision with the same `decide()` function, so the guard
 * order cannot drift between them.
 */

import { ClusterSnapshot } from "./rpc.ts";
import { advanceCursor, commit, decide, turnMessage } from "./scheduler.ts";
import { publish, readSnapshot } from "./snapshot.ts";
import { type ClusterState, MIN_HEARTBEAT_MS } from "./state.ts";
import { ClusterStore } from "./store.ts";
import { CLUSTER_ID, syncClusterAgent } from "./team.ts";
import { type Runtime, registerTools } from "./tools.ts";

/** Prefix of every injected system snippet. The idempotency check keys on it. */
export const MARK = "[clustercode]";
/** How often the heartbeat timer looks for due clusters. The real interval is per session. */
const TICK_MS = 15_000;
/** First heartbeat pass after boot, to pick up runs interrupted by a crash. */
const BOOT_DELAY_MS = 8_000;

/** Plugin-level singletons: a reload must clear the old timers or they stack up. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

function clusterCard(state: ClusterState, agentId?: string): string | null {
  const inClusterMode = agentId === CLUSTER_ID;
  if (!state.active && !inClusterMode) return null;

  // The cluster is idle but the user switched to cluster mode: explain how it works.
  if (!state.active) {
    return [
      `${MARK} You are in cluster mode, but this session has no queued work.`,
      `If the request splits into two or more independently verifiable steps, call cluster_auto({ goal })`,
      `to build the task DAG (or cluster_plan to write the tasks yourself).`,
      `If it is a single small edit, just do it — do not start a long run for that.`,
      `Once a run starts the plugin hands back the next turn automatically; no need to ask the user.`,
    ].join("\n");
  }

  const roster =
    state.team.length > 0
      ? `Seats rotate: ${state.team.map((m) => `${m.id} (${m.role})`).join(" -> ")}. ` +
        `Your role for this turn comes from the system prompt; just do that job.`
      : "";

  return [
    `${MARK} You are working inside a long-running cluster. Do not wait for user confirmation.`,
    `Goal: ${state.goal}`,
    roster,
    `Use cluster_status to inspect the queue. Every finished task must be reported with cluster_update`,
    `(status "done" or "failed"). Marking done runs the task's verify command for real.`,
    `The run stops by itself when the queue drains.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Recent activity decides whether waking the session is safe. Unknown = idle (better one extra call than a stall). */
async function isSessionIdle(ctx: any, sessionID: string): Promise<boolean> {
  try {
    const info = await ctx.session.get({ sessionID });
    const busy = Number(info?.time?.busy ?? 0);
    const idle = Number(info?.time?.idle ?? 0);
    return idle >= busy;
  } catch {
    return true;
  }
}

/**
 * Wake every cluster that asked for it.
 *
 * Because the stop guards live in `decide()`, a cluster that hit its round cap or
 * went stagnant is stopped here too instead of being woken for one extra turn.
 */
export async function heartbeatTick(ctx: any, store: ClusterStore, now = Date.now()): Promise<void> {
  let all: Array<{ sessionID: string; state: ClusterState }>;
  try {
    all = await store.scanAll();
  } catch {
    return;
  }

  for (const { sessionID, state } of all) {
    if (!state.active || !state.heartbeat) continue;

    const cooldown = Math.max(MIN_HEARTBEAT_MS, state.heartbeatMs || 60_000);
    if (state.lastWakeAt && now - state.lastWakeAt < cooldown) continue;

    const decision = decide(state);
    if (decision.type === "wait") continue;
    if (decision.type === "stop") {
      commit(state, decision, now);
      await store.save(sessionID, state);
      publish(sessionID, state);
      continue;
    }

    if (!(await isSessionIdle(ctx, sessionID))) continue;

    state.lastWakeAt = now;
    commit(state, decision, now);
    await store.save(sessionID, state);
    publish(sessionID, state);

    try {
      await ctx.session.synthetic({
        sessionID,
        text:
          `${MARK} heartbeat wake-up · turn ${state.round}\n` +
          (decision.task
            ? `Continue with ${decision.task.id}: ${decision.task.title}\n` +
              `When done call cluster_update(id="${decision.task.id}", status="done").`
            : `No runnable task left; check dependencies with cluster_status.`),
        description: "clustercode-heartbeat",
        resume: true,
      });
      console.log(`[clustercode] heartbeat woke ${sessionID} (turn ${state.round})`);
    } catch (err) {
      console.log(`[clustercode] heartbeat wake-up failed for ${sessionID}: ${String((err as Error)?.message ?? err)}`);
    }
  }
}

/** Start a run for a session: update the state, publish it and inject the first turn. */

export default {
  id: "clustercode",

  async setup(ctx: any) {
    clearTimers();

    const store = new ClusterStore(ctx.storage);
    const runtime: Runtime = {
      store,
      publish,
      cwd: ctx.location?.directory,
    };

    // ── 0. the Shift+Tab entry point ───────────────────────────────────────
    // Exactly one user-visible primary agent: `clustercode`. Team members are
    // written with hidden:true so they never clutter the mode picker.
    let clusterAgentNote = "";
    try {
      const sync = syncClusterAgent();
      clusterAgentNote = sync.written ? `wrote ${sync.path}` : (sync.reason ?? "cluster mode already present");
      if (sync.written) {
        try {
          await ctx.agent.reload();
        } catch (err) {
          clusterAgentNote += ` (reload failed: ${String((err as Error)?.message ?? err)}; reopen the client)`;
        }
      }
    } catch (err) {
      clusterAgentNote = `write failed: ${String((err as Error)?.message ?? err)}`;
    }

    const registrations: Array<{ dispose?: () => Promise<void> | void }> = [];

    // ── 1. the loop: idle hook + member rotation ───────────────────────────
    registrations.push(
      await ctx.session.hook("experimental.idle", async (event: any) => {
        const sessionID: string = event.sessionID;
        const state = await store.load(sessionID);
        if (!state.active) return;

        const background = Array.isArray(event.background) ? event.background.length : 0;
        const decision = decide(state, { background });

        if (decision.type === "wait") {
          if (decision.code === "background") {
            console.log(`[clustercode] waiting for ${decision.count} background job(s) (${sessionID})`);
          }
          return;
        }
        if (decision.type === "stop") {
          commit(state, decision);
          await store.save(sessionID, state);
          publish(sessionID, state);
          return;
        }

        // Swap the seat before injecting the turn, so the message is answered by
        // the right agent. A failed switch keeps the current agent and the run alive.
        let switchNote = "";
        if (decision.member) {
          try {
            await ctx.session.switchAgent({ sessionID, agent: decision.member.agentId });
            advanceCursor(state, decision.memberIndex);
            switchNote = ` (${decision.member.id} takes this turn)`;
          } catch (err) {
            switchNote = ` (could not switch to ${decision.member.id}, staying on the current agent: ${String(
              (err as Error)?.message ?? err,
            ).slice(0, 120)})`;
            console.log(`[clustercode] switchAgent failed:${switchNote}`);
          }
        }

        commit(state, decision);
        await store.save(sessionID, state);
        publish(sessionID, state);

        await ctx.session.synthetic({
          sessionID,
          text: turnMessage(state, decision, switchNote),
          description: "clustercode-continue",
          resume: true,
        });
      }),
    );

    // ── 2. system card ────────────────────────────────────────────────────
    // Stable text, injected once: changing it every turn would invalidate the prompt cache.
    registrations.push(
      await ctx.session.hook("context", async (event: any) => {
        const state = await store.load(event.sessionID);
        publish(event.sessionID, state);
        const card = clusterCard(state, typeof event.agent === "string" ? event.agent : undefined);
        if (!card) return;
        if (!Array.isArray(event.system)) return;
        const already = event.system.some(
          (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(MARK),
        );
        if (already) return;
        event.system.push({ type: "text", text: card });
      }),
    );

    // ── 3. commands ───────────────────────────────────────────────────────
    registrations.push(
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "cluster-stop",
          description: "Stop the clustercode run in this session (the queue is kept; /cluster-resume continues)",
          async execute(input: any) {
            const state = await store.load(input.sessionID);
            state.active = false;
            state.stoppedCode = "user";
            state.stoppedReason = "stopped by the user";
            await store.save(input.sessionID, state);
            publish(input.sessionID, state);
          },
        });
        editor.add({
          name: "cluster-resume",
          description: "Continue the clustercode run that was stopped in this session",
          async execute(input: any) {
            const state = await store.load(input.sessionID);
            if (state.tasks.length === 0) return;

            // Reset the counters that caused the stop, then let the scheduler decide.
            state.active = true;
            state.stagnant = 0;
            state.lastFingerprint = "";
            state.stoppedCode = "";
            state.stoppedReason = undefined;

            const decision = decide(state);
            if (decision.type === "continue") {
              commit(state, decision);
              await store.save(input.sessionID, state);
              publish(input.sessionID, state);
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: turnMessage(state, decision, " (resumed)"),
                description: "clustercode-resume",
                resume: true,
              });
              return;
            }
            commit(state, decision);
            await store.save(input.sessionID, state);
            publish(input.sessionID, state);
          },
        });
      }),
    );

    // ── 4. tools ──────────────────────────────────────────────────────────
    registrations.push(await registerTools(ctx, runtime));

    // ── 5. RPC for the TUI and Desktop halves ─────────────────────────────
    try {
      registrations.push(
        await ctx.rpc.register(ClusterSnapshot, {
          get: async () => readSnapshot(),
        }),
      );
    } catch (err) {
      console.log(`[clustercode] RPC registration failed (UIs will stay empty): ${String((err as Error)?.message ?? err)}`);
    }

    // ── 6. remember what was running before the restart ────────────────────
    setTimeout(() => {
      void (async () => {
        try {
          const all = await store.scanAll();
          for (const { sessionID, state } of all) publish(sessionID, state);
        } catch {
          /* a failed scan must not affect the run */
        }
      })();
    }, 2_000).unref?.();

    // ── 7. heartbeat ──────────────────────────────────────────────────────
    heartbeatTimer = setInterval(() => {
      void heartbeatTick(ctx, store).catch(() => {});
    }, TICK_MS);
    heartbeatTimer.unref?.();

    bootTimer = setTimeout(() => {
      void heartbeatTick(ctx, store).catch(() => {});
    }, BOOT_DELAY_MS);
    bootTimer.unref?.();

    console.log(
      `[clustercode] setup ok · registrations=${registrations.length} · tick=${TICK_MS}ms · ${clusterAgentNote}`,
    );

    return async () => {
      clearTimers();
      for (const registration of registrations) {
        try {
          await registration?.dispose?.();
        } catch {
          /* teardown must not throw */
        }
      }
    };
  },
};

export type { ClusterState };
