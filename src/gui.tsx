/** @jsxImportSource solid-js */
/**
 * Desktop half: a side panel with the live cluster, a capsule above the composer,
 * a "+" menu entry, a tab-strip button and a command palette entry.
 *
 * Data comes straight from the server half over RPC. The desktop may be attached to
 * a server on another machine, so nothing here reads the server's disk.
 */

import { For, Show, createSignal } from "solid-js";
import {
  ComposerPill,
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  type Context,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui";
import { ClusterSnapshot, type SessionView, type SnapshotView } from "./rpc.ts";
import {
  TASK_GLYPH,
  TONE_COLOR,
  clusterFor,
  panelLabel,
  progress,
  shortGoal,
  stopText,
  taskTone,
  tone,
} from "./status.ts";

const POLL_MS = 2_000;
const PANEL_ID = "cluster";
const PANEL_KEY = `clustercode:${PANEL_ID}`;

/** One stable object: returning a new tab object on every list() call re-renders the strip. */
const TEAM_TAB: PanelTab = { id: PANEL_ID, title: "clustercode", pinned: true };

const [snapshot, setSnapshot] = createSignal<SnapshotView | null>(null);
const [error, setError] = createSignal<string | null>(null);

function startPolling(ctx: Context): () => void {
  const tick = async () => {
    try {
      const next = (await ctx.client.rpc(ClusterSnapshot).get({})) as SnapshotView;
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err).slice(0, 160));
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function ProgressBar(props: { percent: number; color: string }) {
  return (
    <div
      style={{
        height: "3px",
        "border-radius": "2px",
        background: "rgba(148,163,184,0.18)",
        overflow: "hidden",
        "margin-bottom": "8px",
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, props.percent))}%`,
          height: "100%",
          background: props.color,
          transition: "width 240ms ease",
        }}
      />
    </div>
  );
}

function TaskRow(props: { task: SessionView["tasks"][number] }) {
  const kind = () => taskTone(props.task);
  return (
    <div style={{ display: "flex", gap: "6px", "align-items": "baseline", padding: "1px 0" }}>
      <span style={{ color: TONE_COLOR[kind()], "flex-shrink": "0", "font-size": "10px" }}>
        {TASK_GLYPH[kind()]}
      </span>
      <span
        title={props.task.note || props.task.verify || undefined}
        style={{
          opacity: props.task.status === "done" ? "0.55" : "1",
          "text-decoration": props.task.status === "done" ? "line-through" : "none",
          "line-height": "1.4",
        }}
      >
        <span style={{ opacity: "0.45", "margin-right": "4px" }}>{props.task.id}</span>
        {props.task.title}
        <Show when={props.task.blocked}>
          <span style={{ color: TONE_COLOR.blocked, "margin-left": "4px", "font-size": "9px" }}>
            waiting
          </span>
        </Show>
        <Show when={props.task.verify}>
          <span style={{ opacity: "0.4", "margin-left": "4px", "font-size": "9px" }}>verify</span>
        </Show>
      </span>
    </div>
  );
}

function SessionCard(props: { session: SessionView; highlight?: boolean }) {
  const stats = () => progress(props.session);
  const kind = () => tone(props.session);
  const member = () => (props.session.active ? props.session.currentMember : "");

  return (
    <div
      style={{
        "margin-bottom": "12px",
        padding: "10px",
        "border-radius": "8px",
        border: props.highlight ? "1px solid rgba(148,163,184,0.28)" : "1px solid transparent",
        background: props.highlight ? "rgba(148,163,184,0.06)" : "transparent",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "4px" }}>
        <span
          style={{
            width: "6px",
            height: "6px",
            "border-radius": "50%",
            background: TONE_COLOR[kind()],
            "flex-shrink": "0",
          }}
        />
        <strong style={{ "font-size": "11px", "font-weight": "600" }}>{panelLabel(props.session)}</strong>
        <span style={{ "font-size": "10px", opacity: "0.55" }}>
          {stats().done}/{stats().total}
        </span>
        <Show when={props.session.heartbeat}>
          <span style={{ "font-size": "9px", opacity: "0.5" }}>♥ heartbeat</span>
        </Show>
        <Show when={props.session.maxRounds >= 0}>
          <span style={{ "font-size": "9px", opacity: "0.4", "margin-left": "auto" }}>
            cap {props.session.maxRounds}
          </span>
        </Show>
      </div>

      <div style={{ "font-size": "10px", opacity: "0.72", "margin-bottom": "6px", "line-height": "1.45" }}>
        {shortGoal(props.session.goal, 90)}
      </div>

      <ProgressBar percent={stats().percent} color={TONE_COLOR[kind()]} />

      <Show when={!props.session.active && stopText(props.session)}>
        <div
          style={{
            "font-size": "10px",
            color: TONE_COLOR.failed,
            "margin-bottom": "6px",
            "line-height": "1.4",
          }}
        >
          {stopText(props.session)}
        </div>
      </Show>

      <Show when={props.session.team.length > 0}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px", "margin-bottom": "8px" }}>
          <For each={props.session.team}>
            {(seat) => {
              const talking = () => member() === seat.id;
              return (
                <span
                  title={seat.role}
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "4px",
                    padding: "2px 6px",
                    "border-radius": "9px",
                    "font-size": "10px",
                    border: `1px solid ${talking() ? TONE_COLOR.blocked : "transparent"}`,
                    background: talking() ? "rgba(245,158,11,0.14)" : "rgba(148,163,184,0.12)",
                    color: talking() ? TONE_COLOR.blocked : "inherit",
                    opacity: talking() ? "1" : "0.6",
                  }}
                >
                  <span
                    style={{
                      width: "5px",
                      height: "5px",
                      "border-radius": "50%",
                      background: seat.color || TONE_COLOR.idle,
                      "flex-shrink": "0",
                    }}
                  />
                  {seat.id}
                </span>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={props.session.tasks.length > 0}>
        <For each={props.session.tasks}>{(task) => <TaskRow task={task} />}</For>
      </Show>

      <div style={{ "font-size": "9px", opacity: "0.3", "margin-top": "6px" }}>
        {new Date(props.session.updatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

function TeamPanel(props: { ctx: Context; session: MountedSession }) {
  const mine = () => clusterFor(snapshot(), props.session.id);
  const others = () => (snapshot()?.sessions ?? []).filter((s) => s.sessionID !== props.session.id);
  const runningOthers = () => others().filter((s) => s.active);
  const stoppedOthers = () => others().filter((s) => !s.active);

  return (
    <div
      style={{
        padding: "10px 12px",
        "font-size": "12px",
        "overflow-y": "auto",
        height: "100%",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-bottom": "10px" }}>
        <strong style={{ "font-size": "11px", "letter-spacing": "0.3px" }}>CLUSTERCODE</strong>
        <span style={{ "font-size": "9px", opacity: "0.45" }}>
          {(snapshot()?.sessions ?? []).filter((s) => s.active).length} running
        </span>
        <div style={{ "margin-left": "auto" }}>
          <props.ctx.ui.IconButton
            icon="refresh"
            label="Refresh"
            onClick={() => void props.ctx.client.rpc(ClusterSnapshot).get({}).then(setSnapshot)}
          />
        </div>
      </div>

      <Show when={error()}>
        <div style={{ "font-size": "10px", color: TONE_COLOR.failed, "margin-bottom": "8px" }}>
          RPC failed: {error()}
        </div>
      </Show>

      <Show when={mine()}>{(session) => <SessionCard session={session()} highlight />}</Show>

      <Show when={!mine() && (snapshot()?.sessions.length ?? 0) === 0}>
        <div style={{ "font-size": "10px", opacity: "0.45", "line-height": "1.6" }}>
          No cluster yet.
          <br />
          Switch to the <code>clustercode</code> agent mode with Shift+Tab, then call <code>cluster_auto</code>{" "}
          or <code>cluster_plan</code> to start a queue. It shows up here.
        </div>
      </Show>

      <Show when={!mine() && runningOthers().length > 0}>
        <div style={{ "font-size": "9px", opacity: "0.4", margin: "4px 0 6px" }}>Other sessions</div>
        <For each={runningOthers()}>{(session) => <SessionCard session={session} />}</For>
      </Show>

      <Show when={mine() && stoppedOthers().length > 0}>
        <div style={{ "border-top": "1px solid rgba(148,163,184,0.15)", margin: "8px 0" }} />
        <For each={stoppedOthers()}>{(session) => <SessionCard session={session} />}</For>
      </Show>
    </div>
  );
}

export default Plugin.define({
  setup(ctx) {
    const stopPolling = startPolling(ctx);

    ctx.add(Panel, () => ({
      id: PANEL_ID,
      region: "side" as const,
      list: () => [TEAM_TAB],
      render: (props) => <TeamPanel ctx={ctx} session={props.session} />,
    }));

    // Above the composer: a capsule with progress, the queue and a way into the panel.
    ctx.add(ComposerPill, () => ({
      id: "cluster-status",
      order: 20,
      show: (input) => {
        const session = clusterFor(snapshot(), input.session.id);
        if (!session || (session.tasks.length === 0 && !session.active)) return undefined;
        const stats = progress(session);
        return {
          label: `cluster ${stats.done}/${stats.total}`,
          icon: "task",
          tone:
            tone(session) === "failed" ? "danger" : session.active ? "warning" : "success",
          title: shortGoal(session.goal, 120),
          rows: [
            ...session.tasks.slice(0, 6).map((task) => ({
              id: task.id,
              label: `${task.id} ${task.title}`,
              detail: task.status === "done" ? "done" : task.blocked ? "waiting" : undefined,
              tone:
                task.status === "failed"
                  ? ("danger" as const)
                  : task.status === "done"
                    ? ("success" as const)
                    : task.blocked
                      ? ("warning" as const)
                      : undefined,
            })),
            {
              id: "__open",
              label: "Open the clustercode panel",
              icon: "sidebar" as const,
              run: () => ctx.layout.open(PANEL_KEY, input.session),
            },
          ],
        };
      },
    }));

    // "+" menu on the side tab strip.
    ctx.add(MenuItem, () => ({
      menu: "session.panel" as const,
      id: "open",
      title: "clustercode",
      icon: "task" as const,
      order: 10,
      run: () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(PANEL_KEY, session);
      },
    }));

    // Shortcut button at the end of the tab strip.
    ctx.add(Slot, () => ({
      at: "session.panel.end" as const,
      order: 0,
      render: (input: { session: MountedSession }) => (
        <ctx.ui.Tooltip value="clustercode">
          <ctx.ui.IconButton
            icon="task"
            label="clustercode"
            onClick={() => ctx.layout.open(PANEL_KEY, input.session)}
          />
        </ctx.ui.Tooltip>
      ),
    }));

    // Command palette + /cluster.
    ctx.add(Command, () => ({
      id: "open",
      title: "Open the clustercode panel",
      description: "Task queue, team rotation and stop reason",
      group: "Agent",
      section: "session" as const,
      slash: { name: "cluster" },
      run: () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(PANEL_KEY, session);
      },
    }));

    return stopPolling;
  },
});
