/**
 * The tools the model can call.
 *
 * Design principle: the model writes its own plan, and the plugin only hands the
 * next turn back at the end of each one. Teams work the same way — the model picks
 * the seats, the plugin rotates them. That is what makes an unattended run possible
 * without a human pressing enter.
 */

import { spawn } from "node:child_process";
import {
  type ClusterState,
  type Task,
  type TaskStatus,
  type TeamMember,
  MAX_TASKS,
  blockedTasks,
  brief,
  counts,
  emptyState,
  isDeadlocked,
  isFinished,
  nextTask,
  pickMember,
  stagnantLimit,
  DEFAULT_HEARTBEAT_MS,
  MIN_HEARTBEAT_MS,
} from "./state.ts";
import type { ClusterStore } from "./store.ts";
import {
  DEFAULT_TEAM,
  type MemberSpec,
  syncAgents,
  syncClusterAgent,
  toMembers,
} from "./team.ts";
import { type PlannedTask, generatePlan, toRuntimeTasks, validatePlan } from "./plan.ts";

/** What the tools need from the hosting plugin. Kept small so tests can fake it. */
export interface Runtime {
  store: ClusterStore;
  publish: (sessionID: string, state: ClusterState) => void;
  /** Working directory used for `verify` commands. */
  cwd?: string;
}

type Editor = { add: (tool: unknown) => void };

const MAX_OUTPUT = 8_000;

/**
 * Run an acceptance command. Exit code 0 means the task is really done.
 *
 * `spawn` instead of `execSync` on purpose: the plugin lives inside the OpenCode
 * server process, and a synchronous call freezes the event loop — heartbeat, hooks
 * and every other session included — until the command returns.
 */
export function runVerify(
  command: string,
  cwd?: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: boolean; out: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      done({ ok: false, out: String((err as Error)?.message ?? err) });
      return;
    }

    let out = "";
    const append = (chunk: unknown) => {
      if (out.length >= MAX_OUTPUT) return;
      out += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done({ ok: false, out: `${out}\n(killed after ${Math.round(timeoutMs / 1000)}s)`.trim() });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, out: [out, err?.message].filter(Boolean).join("\n").trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, out: out.trim().slice(-1_500) });
    });
  });
}

/** Build the member markdown files, reload the agent list, store the roster. */
export async function buildTeam(
  ctx: any,
  runtime: Runtime,
  sessionID: string,
  specs: MemberSpec[],
  options: { adoptCluster?: boolean } = {},
): Promise<{ state: ClusterState; report: string }> {
  const result = syncAgents(specs);

  let reloadNote = "agent list reloaded";
  try {
    await ctx?.agent?.reload?.();
  } catch (err) {
    reloadNote = `agent reload failed: ${String((err as Error)?.message ?? err)} (reopen OpenCode to pick up new members)`;
  }

  // The Shift+Tab mode. Written if missing, left alone when hand written unless adopted.
  const clusterAgent = syncClusterAgent({ adopt: options.adoptCluster === true });

  const state = await runtime.store.load(sessionID);
  state.team = toMembers(specs);
  state.cursor = 0;
  await runtime.store.save(sessionID, state);
  runtime.publish(sessionID, state);

  const lines = [
    `team ready: ${specs.map((s) => s.id).join(" -> ")}`,
    `agent directory: ${result.dir}`,
    `wrote ${result.written.length}${result.written.length ? `: ${result.written.join(", ")}` : ""}`,
  ];
  if (result.skipped.length) {
    lines.push(
      `skipped ${result.skipped.length} same-named file(s) not managed by clustercode: ${result.skipped.join(", ")}` +
        ` (delete them or adopt to take over)`,
    );
  }
  if (result.removed.length) lines.push(`removed stale members: ${result.removed.join(", ")}`);
  lines.push(
    clusterAgent.written
      ? `cluster mode (Shift+Tab): wrote ${clusterAgent.path}`
      : `cluster mode (Shift+Tab): kept existing file — ${clusterAgent.reason ?? "already present"}`,
  );
  lines.push(reloadNote);
  return { state, report: lines.join("\n") };
}

function startMessage(state: ClusterState): string {
  const first = nextTask(state);
  const { member } = pickMember(state, first);
  const head = `\n${brief(state)}\n`;
  const who = member
    ? `First turn goes to ${member.id} (${member.role}).`
    : first
      ? `Start with ${first.id}.`
      : "No runnable task; check dependencies.";
  const tail = first
    ? ` When it is done call cluster_update(id="${first.id}", status="done"); the plugin hands back the next turn automatically.`
    : "";
  return head + who + tail;
}

function stateFor(
  base: { goal: string; tasks: Task[]; team: TeamMember[] },
  input: Record<string, unknown>,
  previous: ClusterState,
): ClusterState {
  return {
    ...emptyState(),
    active: true,
    goal: base.goal,
    tasks: base.tasks,
    team: base.team,
    cursor: 0,
    round: 0,
    stagnant: 0,
    lastFingerprint: "",
    maxRounds: Number(input.maxRounds) > 0 ? Math.floor(Number(input.maxRounds)) : null,
    maxStagnant: stagnantLimit(input.maxStagnant),
    heartbeat: input.heartbeat === true,
    heartbeatMs: Math.max(MIN_HEARTBEAT_MS, Number(input.heartbeatMs) || DEFAULT_HEARTBEAT_MS),
    createdAt: previous.createdAt,
    stoppedCode: "",
  };
}

function dagLines(tasks: Task[]): string {
  return tasks
    .map((t) => {
      const deps = t.dependsOn?.length ? ` <- ${t.dependsOn.join(",")}` : "";
      const verify = t.verify ? " [verify]" : "";
      return `  ${t.id} ${t.title}${deps}${verify}`;
    })
    .join("\n");
}

/** Manual task shape accepted by `cluster_plan`. */
interface ManualTask {
  id?: string;
  title: string;
  member?: string;
  dependsOn?: string[];
  verify?: string;
}

export function registerTools(ctx: any, runtime: Runtime) {
  return ctx.tool.transform((editor: Editor) => {
    editor.add({
      name: "cluster_auto",
      description:
        "Give one goal line and the plugin calls the model itself to build a dependency-aware task DAG, " +
        "then starts the run. No manual task splitting. A default team is created when there is none. " +
        "With heartbeat enabled the run survives for 24h: idle sessions are woken up again.",
      input: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Final goal, one or two sentences" },
          maxTasks: { type: "number", description: "Maximum number of generated tasks. Default 8" },
          maxRounds: { type: "number", description: "Turn cap. Omit for no cap" },
          maxStagnant: {
            type: "number",
            description: "Stop after this many turns without progress. Default 12; 0 disables the guard",
          },
          heartbeat: { type: "boolean", description: "Enable the 24h heartbeat wake-up. Default true" },
          heartbeatMs: { type: "number", description: "Heartbeat interval in ms. Default 60000" },
        },
        required: ["goal"],
      },
      async execute(input: Record<string, unknown>, context: any) {
        const sessionID = context.sessionID;
        const goal = String(input.goal ?? "").trim();
        if (!goal) return { content: "goal is empty; nothing was planned." };

        const previous = await runtime.store.load(sessionID);
        let teamNote = "";
        if (previous.team.length === 0) {
          const { report } = await buildTeam(ctx, runtime, sessionID, DEFAULT_TEAM);
          teamNote = `${report}\n\n`;
        }
        const team = (await runtime.store.load(sessionID)).team;

        let planned: Awaited<ReturnType<typeof generatePlan>>;
        try {
          planned = await generatePlan(ctx, goal, team, Number(input.maxTasks) || 8);
        } catch (err) {
          return {
            content:
              `automatic planning failed: ${String((err as Error)?.message ?? err).slice(0, 300)}\n` +
              `You can still build the queue by hand with cluster_plan.`,
          };
        }

        if (planned.tasks.length === 0) {
          return { content: `The model produced no usable task. Raw output:\n${planned.raw.slice(0, 600)}` };
        }

        const state = stateFor(
          { goal, tasks: toRuntimeTasks(planned.tasks), team },
          { ...input, heartbeat: input.heartbeat !== false },
          previous,
        );
        await runtime.store.save(sessionID, state);
        runtime.publish(sessionID, state);

        const issues = planned.issues.length
          ? `\nrepaired ${planned.issues.length} problem(s):\n` +
            planned.issues.map((i) => `  - [${i.kind}] ${i.detail}`).join("\n")
          : "";

        return {
          content:
            `${teamNote}built a ${state.tasks.length}-task workflow from the goal:\n${dagLines(state.tasks)}${issues}\n` +
            `heartbeat: ${state.heartbeat ? `on (${state.heartbeatMs / 1000}s)` : "off"}` +
            startMessage(state),
        };
      },
    });

    editor.add({
      name: "cluster_team",
      description:
        "Create or replace the agent team. Every member becomes an agent file on disk (clustercode-<id>.md) " +
        "and the agent list is reloaded; the cluster then rotates through the seats turn by turn. " +
        "Omit members for the built-in roster (architect/coder/reviewer/tester).",
      input: {
        type: "object",
        properties: {
          members: {
            type: "array",
            description: "Custom members. Omit to use the built-in roster",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Short name, e.g. architect or coder" },
                role: { type: "string", description: "One-line responsibility, ends up in the agent description" },
                color: { type: "string", description: "Six-digit hex colour, optional" },
                extra: { type: "string", description: "Extra role instructions, optional" },
                model: { type: "string", description: "Optional provider/model override for this seat" },
              },
              required: ["id", "role"],
            },
          },
          adoptCluster: {
            type: "boolean",
            description:
              "Take over an existing hand-written clustercode.md (the Shift+Tab mode). Default false: user files are never overwritten",
          },
        },
      },
      async execute(input: Record<string, unknown>, context: any) {
        const sessionID = context.sessionID;
        const list = Array.isArray(input.members) ? (input.members as Record<string, unknown>[]) : [];
        const specs: MemberSpec[] =
          list.length > 0
            ? list.map((m) => ({
                id: String(m.id),
                role: String(m.role),
                color: m.color ? String(m.color) : undefined,
                extra: m.extra ? String(m.extra) : undefined,
                model: m.model ? String(m.model) : undefined,
              }))
            : DEFAULT_TEAM;

        const { state, report } = await buildTeam(ctx, runtime, sessionID, specs, {
          adoptCluster: input.adoptCluster === true,
        });
        const tail = state.active
          ? "\nThe cluster is running; the next turn already uses the new roster."
          : "\nCall cluster_plan or cluster_auto to start a queue.";
        return { content: report + tail };
      },
    });

    editor.add({
      name: "cluster_plan",
      description:
        "Create a task queue and start the run. Tasks may carry dependsOn (ids that must be done first) and " +
        "verify (acceptance command; a non-zero exit code blocks marking the task done). The plugin hands back " +
        "the next turn after each one and rotates team members. Use append: true to add tasks to a live queue.",
      input: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What the whole queue is for, one or two sentences" },
          tasks: {
            type: "array",
            description: "Task list. With dependsOn it runs as a DAG",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task id; defaults to t1, t2, ..." },
                title: { type: "string", description: "What to do, including acceptance criteria" },
                member: { type: "string", description: "Pin to a member id; omitted = rotation" },
                dependsOn: {
                  type: "array",
                  description: "Ids that must be done before this task can run",
                  items: { type: "string" },
                },
                verify: {
                  type: "string",
                  description: "Acceptance command; exit code 0 means done, e.g. node test/simulate.ts",
                },
              },
              required: ["title"],
            },
          },
          maxRounds: { type: "number", description: "Maximum turns. Omit or 0 for no cap" },
          maxStagnant: {
            type: "number",
            description: "Stop after this many turns without progress. Default 12; 0 disables the guard",
          },
          withTeam: {
            type: "boolean",
            description: "Create the built-in team first when there is none. Default true",
          },
          heartbeat: { type: "boolean", description: "Enable the 24h heartbeat wake-up. Default false" },
          heartbeatMs: { type: "number", description: "Heartbeat interval in ms. Default 60000" },
          append: {
            type: "boolean",
            description: "Append to the existing queue instead of replacing it. Default false",
          },
        },
        required: ["goal", "tasks"],
      },
      async execute(input: Record<string, unknown>, context: any) {
        const sessionID = context.sessionID;
        const list = Array.isArray(input.tasks) ? (input.tasks as ManualTask[]) : [];
        if (list.length === 0) {
          return { content: "The task list is empty; nothing was started. Give at least one task." };
        }

        const previous = await runtime.store.load(sessionID);
        let teamNote = "";
        if (previous.team.length === 0 && input.withTeam !== false) {
          const { report } = await buildTeam(ctx, runtime, sessionID, DEFAULT_TEAM);
          teamNote = `\n${report}\n`;
        }

        const latest = await runtime.store.load(sessionID);
        const append = input.append === true;
        const existing = append ? latest.tasks : [];
        if (existing.length + list.length > MAX_TASKS) {
          return { content: `refusing to build more than ${MAX_TASKS} tasks; split the work into several runs.` };
        }

        const { tasks: planned, issues } = validatePlan({ tasks: list }, latest.team, {
          knownIds: existing.map((t) => t.id),
        });

        const tasks = [...existing, ...toRuntimeTasks(planned)];
        const state = stateFor({ goal: String(input.goal ?? "").trim(), tasks, team: latest.team }, input, previous);
        await runtime.store.save(sessionID, state);
        runtime.publish(sessionID, state);

        const warn = isDeadlocked(state) ? "\nwarning: the DAG has unrunnable dependencies (cycle or failed upstream)." : "";
        const issuesText = issues.length
          ? `\nrepaired ${issues.length} problem(s):\n${issues.map((i) => `  - [${i.kind}] ${i.detail}`).join("\n")}`
          : "";
        const total = state.tasks.length;
        return {
          content:
            `${append ? `appended ${planned.length} task(s); queue now has ${total}` : `created a ${total}-task queue and started the run`}.${teamNote}\n` +
            `${brief(state)}${warn}${issuesText}` +
            startMessage(state),
        };
      },
    });

    editor.add({
      name: "cluster_update",
      description:
        "Update one task. When marking done and the task has a verify command (or you pass one), the plugin runs it for " +
        "real: a non-zero exit code refuses the update and returns the output. Call this for every finished task, " +
        "otherwise the stagnation guard stops the run.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task id, e.g. t1" },
          status: {
            type: "string",
            enum: ["pending", "running", "done", "failed"],
            description: "New status",
          },
          note: { type: "string", description: "One line: what changed, where it is stuck, why it failed" },
          verify: {
            type: "string",
            description: "Ad-hoc acceptance command overriding the task's own verify. Only runs for status=done",
          },
          skipVerify: {
            type: "boolean",
            description: "Skip the acceptance command. Only when the command itself cannot run",
          },
        },
        required: ["id", "status"],
      },
      async execute(input: Record<string, unknown>, context: any) {
        const sessionID = context.sessionID;
        const state = await runtime.store.load(sessionID);
        const task = state.tasks.find((t) => t.id === input.id);
        if (!task) {
          const list = state.tasks.map((t) => t.id).join(", ") || "(empty)";
          return { content: `There is no task ${String(input.id)}. Existing: ${list}` };
        }

        const status = String(input.status) as TaskStatus;
        if (!["pending", "running", "done", "failed"].includes(status)) {
          return { content: `invalid status ${status}` };
        }

        // The acceptance gate: "done" needs evidence.
        if (status === "done" && input.skipVerify !== true) {
          const command = String(input.verify ?? task.verify ?? "").trim();
          if (command) {
            const result = await runVerify(command, runtime.cwd ?? ctx?.location?.directory);
            if (!result.ok) {
              return {
                content:
                  `verify failed; refusing to mark ${task.id} as done.\n` +
                  `command: ${command}\noutput (tail):\n${result.out || "(no output)"}\n\n` +
                  `Fix it and retry. If the command itself is wrong, pass skipVerify: true.`,
              };
            }
            task.note = [task.note, `verify passed: ${command}`].filter(Boolean).join("; ");
          }
        }

        task.status = status;
        if (input.note) task.note = String(input.note);
        task.updatedAt = Date.now();

        if (isFinished(state)) {
          state.active = false;
          state.stoppedCode = "finished";
          state.stoppedReason = "all tasks are done or failed";
        }
        await runtime.store.save(sessionID, state);
        runtime.publish(sessionID, state);

        const c = counts(state);
        const blocked = blockedTasks(state).length;
        const tail = state.active
          ? `${c.pending + c.running} task(s) left${blocked ? ` (${blocked} waiting on deps)` : ""}; the next turn starts automatically at the end of this one.`
          : `cluster stopped: ${state.stoppedReason}`;
        return { content: `${task.id} -> ${task.status}\n${tail}` };
      },
    });

    editor.add({
      name: "cluster_retry",
      description:
        "Put failed tasks back into the queue and restart the run. Without options every failed task is reset. " +
        "Progress counters restart, so a previously stopped run can continue.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reset only this task id" },
        },
      },
      async execute(input: Record<string, unknown>, context: any) {
        const sessionID = context.sessionID;
        const state = await runtime.store.load(sessionID);
        const target = input.id ? state.tasks.find((t) => t.id === input.id) : undefined;

        if (input.id && !target) {
          return { content: `There is no task ${String(input.id)}.` };
        }
        const reset = target ? [target] : state.tasks.filter((t) => t.status === "failed");
        if (reset.length === 0) {
          return { content: "Nothing to retry: no failed task in the queue." };
        }
        for (const task of reset) {
          task.status = "pending";
          task.attempts = (task.attempts ?? 0) + 1;
          task.updatedAt = Date.now();
        }
        state.active = true;
        state.stagnant = 0;
        state.lastFingerprint = "";
        state.stoppedCode = "";
        state.stoppedReason = undefined;
        await runtime.store.save(sessionID, state);
        runtime.publish(sessionID, state);

        return {
          content:
            `reset ${reset.length} task(s) to pending: ${reset.map((t) => t.id).join(", ")}\n` +
            `${brief(state)}${startMessage(state)}`,
        };
      },
    });

    editor.add({
      name: "cluster_status",
      description:
        "Show cluster progress: turn, queue, team rotation, dependency blocks, heartbeat state and why it stopped.",
      input: { type: "object", properties: {} },
      async execute(_input: unknown, context: any) {
        const state = await runtime.store.load(context.sessionID);
        if (state.tasks.length === 0 && state.team.length === 0) {
          return { content: "No cluster yet. Start one with cluster_auto (automatic) or cluster_plan (manual)." };
        }
        const current = nextTask(state);
        const { member } = pickMember(state, current);
        const blocked = blockedTasks(state);
        const c = counts(state);

        return {
          content: [
            state.active ? brief(state) : `stopped (${state.stoppedReason ?? "not started"})`,
            `goal: ${state.goal || "(none)"}`,
            state.team.length
              ? `team: ${state.team.map((m) => m.id).join(" -> ")} | next seat: ${member?.id ?? "?"}`
              : "team: none (solo run, or call cluster_team)",
            `heartbeat: ${state.heartbeat ? `on (${state.heartbeatMs / 1000}s)` : "off"}` +
              (state.lastWakeAt ? ` | last wake ${new Date(state.lastWakeAt).toLocaleTimeString()}` : ""),
            `stagnation guard: ${state.maxStagnant > 0 ? `stop after ${state.maxStagnant} turns without progress` : "disabled"}` +
              ` (currently ${state.stagnant})`,
            `round cap: ${state.maxRounds === null ? "none" : state.maxRounds}`,
            `done ${c.done}/${c.total}, failed ${c.failed}`,
            current ? `next task: ${current.id} ${current.title}` : "next task: none (check dependencies)",
            blocked.length
              ? `blocked: ${blocked.map((t) => `${t.id}<-${(t.dependsOn ?? []).join(",")}`).join("; ")}`
              : "",
            ...state.tasks.map(
              (t) =>
                `  [${t.status}] ${t.id} ${t.title}` +
                `${t.member ? ` @${t.member}` : ""}` +
                `${t.dependsOn?.length ? ` <-${t.dependsOn.join(",")}` : ""}` +
                `${t.verify ? " [verify]" : ""}` +
                `${t.attempts ? ` (attempt ${t.attempts + 1})` : ""}` +
                `${t.note ? ` — ${t.note}` : ""}`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });
  });
}

export type { PlannedTask };
