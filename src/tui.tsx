/** @jsxImportSource @opentui/solid */
/**
 * TUI half: a status segment in the prompt footer plus a `/cluster` panel.
 *
 * Data comes from the server half over RPC (`ClusterSnapshot`). The two halves can
 * be different processes, so this file never reads the server's memory or disk.
 * When the RPC is not there (plugin not loaded, older host) it degrades to showing
 * the reason instead of pretending there is no cluster.
 */

import { For, Show, createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { ClusterSnapshot, type SnapshotView } from "./rpc.ts";
import {
  TASK_GLYPH,
  TONE_COLOR,
  clusterFor,
  footerLabel,
  progress,
  shortGoal,
  stopText,
  taskTone,
  tone,
} from "./status.ts";

const POLL_MS = 2_000;
const PANEL_NAME = "cluster";

export default Plugin.define({
  id: "clustercode",
  setup(ctx) {
    const [snapshot, setSnapshot] = createSignal<SnapshotView | null>(null);
    const [error, setError] = createSignal<string | null>(null);

    const load = async () => {
      try {
        const next = (await ctx.client.rpc(ClusterSnapshot).get({})) as SnapshotView;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        setSnapshot(null);
        setError(String((err as Error)?.message ?? err));
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    timer.unref?.();

    const sessions = () => snapshot()?.sessions ?? [];
    const current = (sessionID: string | undefined) => clusterFor(snapshot(), sessionID);

    const disposeFooter = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const view = () => current(input.sessionID);
        return (
          <Show when={view()}>
            {(session) => (
              <box flexShrink={0} flexDirection="row" gap={1}>
                <text fg={TONE_COLOR[tone(session())]}>{TASK_GLYPH[tone(session())]}</text>
                <text fg="#94A3B8">{footerLabel(session())}</text>
              </box>
            )}
          </Show>
        );
      },
    });

    const disposePanel = ctx.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL_NAME}>
          <box
            flexDirection="column"
            width="100%"
            height="100%"
            paddingLeft={1}
            paddingRight={1}
            gap={1}
          >
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg="#E2E8F0">
                <b>clustercode</b>
              </text>
              <text fg="#64748B">
                {sessions().filter((s) => s.active).length} running / {sessions().length} cluster(s)
              </text>
            </box>

            <Show when={error()}>
              <text fg="#F87171">snapshot RPC failed: {error()}</text>
              <text fg="#64748B">
                The server half did not register ClusterSnapshot or returned an invalid payload. If this
                survives a restart, the plugin version and the client version do not match.
              </text>
            </Show>

            <Show when={!error() && sessions().length === 0}>
              <text fg="#64748B">
                No cluster yet. Switch to clustercode mode and call cluster_auto or cluster_plan.
              </text>
            </Show>

            <scrollbox flexGrow={1} minHeight={0}>
              <box flexDirection="column" gap={1}>
                <For each={sessions()}>
                  {(session) => (
                    <box flexDirection="column" gap={0} paddingBottom={1}>
                      <box flexDirection="row" gap={1}>
                        <text fg={TONE_COLOR[tone(session)]}>{TASK_GLYPH[tone(session)]}</text>
                        <text fg="#E2E8F0">
                          {session.active ? `turn ${session.round}` : stopText(session) || "stopped"}
                        </text>
                        <text fg="#64748B">
                          {progress(session).done}/{progress(session).total}
                        </text>
                        <Show when={session.heartbeat}>
                          <text fg="#64748B">♥ heartbeat</text>
                        </Show>
                      </box>
                      <text fg="#94A3B8">{shortGoal(session.goal)}</text>
                      <Show when={session.team.length > 0}>
                        <text fg="#64748B">
                          {session.team
                            .map((m) => (m.id === session.currentMember ? `[${m.id}]` : m.id))
                            .join(" -> ")}
                        </text>
                      </Show>
                      <For each={session.tasks}>
                        {(task) => (
                          <box flexDirection="row" gap={1}>
                            <text fg={TONE_COLOR[taskTone(task)]}>{TASK_GLYPH[taskTone(task)]}</text>
                            <text fg={taskTone(task) === "done" ? "#64748B" : "#CBD5E1"}>
                              {task.id} {task.title}
                            </text>
                            <Show when={task.blocked}>
                              <text fg="#F59E0B">waiting</text>
                            </Show>
                          </box>
                        )}
                      </For>
                    </box>
                  )}
                </For>
              </box>
            </scrollbox>

            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg="#475569">esc closes · /cluster reopens</text>
            </box>
          </box>
        </Show>
      ),
    });

    // `/cluster` toggles the panel. Same ui.panel mechanism the built-in diff panel uses.
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "clustercode.panel",
          title: "clustercode panel",
          description: "Task queue, team rotation and stop reason",
          group: "Agent",
          slash: { name: "cluster" },
          run() {
            const active = ctx.ui.panel.current();
            if (active?.name === PANEL_NAME) {
              ctx.ui.panel.close();
              return;
            }
            ctx.ui.panel.open(PANEL_NAME, { presentation: "panel" });
          },
        },
      ],
    }));

    return () => {
      clearInterval(timer);
      disposeFooter();
      disposePanel();
    };
  },
});
