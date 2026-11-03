# clustercode

**A long-running agent cluster for [OpenCode](https://github.com/anomalyco/opencode).**
The model writes its own task DAG, the plugin hands the next turn back at the end of every
turn, team members rotate through the seats, and the queue runs until it drains.

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [Français](docs/README.fr.md) · [日本語](docs/README.ja.md) · [Español](docs/README.es.md) · [Português](docs/README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## Why

OpenCode V2 (plugin API 2.x, `Plugin.define`) rewrote the plugin surface: 1.x plugins fail to
load on 2.x. V2 ships background subagents, compaction and warming, but it does not ship two
things an unattended run needs:

1. **Continuation** — when a turn ends, nothing starts the next one. You keep pressing enter.
2. **Seat rotation** — one agent does everything, instead of a planner, a coder, a reviewer and
   a tester taking turns.

`clustercode` adds exactly those two, plus the guard rails that make leaving a run alone for
24 hours a reasonable idea.

## What you get

| Feature | What it does |
|---|---|
| **Task DAG** | `dependsOn` between tasks. A task is only runnable when every dependency is `done`. |
| **Auto planning** | `cluster_auto({ goal })` calls the model once, off-session, to compile a goal into a DAG. Nothing pollutes the conversation. |
| **Seat rotation** | Members are real agent files (`clustercode-<id>.md`). The plugin swaps seats with `switchAgent` between turns. A task can pin a member. |
| **Verify gate** | Marking a task `done` runs its `verify` command for real. Non-zero exit code refuses the update and returns the output. |
| **24h heartbeat** | With `heartbeat: true`, idle sessions are woken again after a cooldown, so an interrupted run resumes without you. |
| **Guards** | Background work, finished queue, deadlock, round cap and stagnation, evaluated in one place and in one order. |
| **Three entry points** | Server (hooks, tools, RPC), TUI (footer status + `/cluster` panel), Desktop (side panel + composer pill + menu entries). |
| **Append & retry** | `cluster_plan({ append: true })` grows a live queue. `cluster_retry` puts failed tasks back. |

## Design principles

Seven rules the code is built around. Each one has a test; [docs/design.md](docs/design.md) maps
principle → module → test, and lists the deliberate divergences from the original project.

1. **One trigger, one scheduler.** The idle hook and the heartbeat both call `decide()`; the guard
   order exists once.
2. **`resume: true` closes the loop.** Without it an idle session waits for a wake-up it never gets.
3. **Evidence over self-assessment.** `done` runs the acceptance command; the model's opinion is not
   evidence.
4. **Stop on a broken premise.** A failed dependency is not satisfied, and a deadlocked graph stops
   immediately with a reason.
5. **Yield by default.** Background subagents win, other plugins own permissions and retries, and the
   system card is constant so the prompt cache stays warm.
6. **Files are the API.** A seat is a managed markdown file; hand-written files are never touched.
7. **One data path.** Snapshot → RPC → both UIs, with shared display functions.

## Install

Clone, then point OpenCode at the **directory** (not a file) in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

The host finds each half through `package.json` → `exports`:

| exports | Half | Contents |
|---|---|---|
| `.` | server | tools, hooks, commands, RPC, heartbeat |
| `./tui` | terminal | footer status segment, `/cluster` panel |
| `./gui-experimental` | desktop | side panel, composer pill, menu/tab/command entries (`dist/*.cjs`) |

Two operational rules:

- The desktop half is **pre-built**. Run `npm run build` after a fresh clone, otherwise the
  desktop panel has no entry point.
- The host probes `exports` **once, at startup**. After changing `exports` or rebuilding the GUI,
  restart the server and the desktop app. `opencode reload` only re-reads config.
  `npm run check:entry` verifies the probe before you restart.

Requires the OpenCode 2.x plugin host (`@opencode/plugin >= 2.0.27 < 3`). Development scripts
need Node 22.18+.

## Quick start

1. Restart OpenCode so the plugin loads.
2. Press **Shift+Tab** until you reach the `clustercode` agent. That mode exists exactly for this:
   it tells the model to hand work to the queue instead of grinding alone.
3. Ask for something, or drive the tools directly:

```
cluster_auto({ "goal": "add a --json flag to the config loader, with tests and docs" })
```

```
cluster_plan({
  "goal": "harden the importer",
  "tasks": [
    { "id": "t1", "title": "reject files over 10 MB", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "document the limit", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. Watch it: `/cluster` opens the panel. In the TUI the prompt footer shows
   `cluster 2/5 · turn 3 · coder`; on the desktop a pill above the composer shows the same run.
5. Brake with `/cluster-stop`. Continue with `/cluster-resume`.

First run advice: keep `maxRounds: 5` until you trust the plan. `maxRounds: null` plus a wide-open
permission profile really does run until the queue is empty.

## Tools

| Tool | Purpose |
|---|---|
| `cluster_auto` | Goal in, generated DAG out, run starts. Builds the default team if there is none. |
| `cluster_plan` | Explicit queue. `dependsOn`, `verify`, `member`, `maxRounds`, `maxStagnant`, `heartbeat`, `append`. |
| `cluster_update` | Report `pending` / `running` / `done` / `failed`. `done` goes through the verify gate. |
| `cluster_status` | Turn, queue, next seat, blocked tasks, heartbeat, stop reason. |
| `cluster_team` | Create or replace the roster. `adoptCluster: true` takes over a hand-written `clustercode.md`. |
| `cluster_retry` | Reset failed tasks to `pending`, clear the stop reason and keep going. |

Commands: `/cluster-stop`, `/cluster-resume`, `/cluster` (panel).

## Built-in roster

Delete or replace it with `cluster_team({ members: [...] })`. Each member supports `id`, `role`,
`color`, `extra` and `model`.

| id | Job | Notes |
|---|---|---|
| `architect` | Break down the work, fix interfaces, write the plan | writes no production code |
| `coder` | Implement the plan | verifies its own change |
| `reviewer` | Read-only review | frontmatter denies `edit:*` tool calls |
| `tester` | Run tests, reproduce bugs, prove acceptance criteria | trusts only real output |

The `reviewer` seat is a **policy** restriction, not a sandbox. If an agent must not touch the
file system at all, restrict it at the OS level.

Member agents are written as `mode: primary` + `hidden: true`, so they never clutter the
Shift+Tab picker; only `clustercode` itself is user-visible. Switching does not check those flags,
so hiding a seat does not stop the rotation. Shrinking the team deletes the managed files that are
no longer needed and leaves hand-written files alone — to remove everything, delete
`clustercode*.md` from `~/.config/opencode/agents`.

## How a turn works

```
experimental.idle
   ├─ background work still running?  → wait (it wakes us again when it ends)
   ├─ queue finished?                 → stop (finished)
   ├─ graph deadlocked?               → stop (deadlock)
   ├─ round cap reached?              → stop (max-rounds)
   ├─ next turn would be stagnant?    → stop (stagnant)
   └─ otherwise
        switchAgent(next seat)  → cursor advances only on success
        round += 1, save, publish snapshot
        synthetic({ resume: true, text: "turn N, task tX, report with cluster_update" })
```

`resume: true` is the load-bearing detail. Without it the injected text waits for a future wake-up
and an idle session never gets one — the run silently stops. The heartbeat path calls the same
`decide()` function, so a cluster that hit its round cap is stopped there too instead of being
woken for one extra turn.

## Architecture

```
core (pure, testable)
  state.ts      task DAG, rotation, counters, fingerprint
  scheduler.ts  decide() + commit(): the guard order lives here once
  plan.ts       goal → DAG, JSON repair, cycle detection
  store.ts      cached, write-serialised persistence + FileStorage
        │
server (src/index.ts)
  idle hook · context card · commands · tools · heartbeat · snapshot RPC
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI (src/tui.tsx)                 Desktop (dist/gui-experimental.cjs)
   footer status + /cluster panel     side panel + composer pill + commands
```

The two UI halves only read the RPC. They never touch server memory or disk, so a desktop attached
to a remote server behaves the same as a local one. Both share the display wording in `status.ts`,
so the footer and the panel cannot disagree about the numbers.

## Guards and cost

- **Stagnation**: default 12 turns without a status change. `maxStagnant: 0` disables it; then
  `maxRounds` is your only backstop.
- **Round cap**: `null` by default. Set it for the first runs.
- **Deadlock**: a cycle or a failed upstream task stops the run immediately with an explanation,
  instead of spinning until the stagnation counter fires.
- **Heartbeat**: `cluster_auto` defaults it on, `cluster_plan` defaults it off. Minimum interval
  15 s, default 60 s. It respects the round cap and the stagnation guard.

Every guard is evaluated in `decide()`; there is no second copy of the rules.

## Coexistence

clustercode deliberately does not claim the parts of the host that another plugin may already own:

| Area | Who owns it |
|---|---|
| Permissions, long shell timeouts | your permissions plugin (`permission.evaluate` is never registered) |
| Retry backoff | your retry plugin (`retry` is never registered — two plugins writing `event.decision` is a coin flip) |
| System prompt | the host; clustercode only *appends* one constant card, once per turn |
| Model choice per seat | you, via the `model` field on a member |

Two plugins that both register `retry` cannot both win: the last registration decides. That is why
this one stays out of it, and why `cluster_auto` documents the round cap instead of silently
running forever.

## Verified

```
npm run check
  typecheck (tsc --noEmit, TSX included)
  187 test assertions (node --test, no model, no network)
  architecture invariants: module boundaries, read from the source and enforced
  documentation invariants: six languages agree on the numbers, links resolve
  build: dist/gui-experimental.cjs + TUI compile check
  entry probe: server / tui / desktop all resolve
  TUI wiring + desktop wiring
```

What the checks do **not** prove: real rendering (needs a live TUI / desktop app) and a full
unattended run against a real model (needs tokens). Everything else is covered by tests.

## Development

```powershell
npm install
npm run check        # everything above, in order
npm run test         # assertions only
npm run typecheck
npm run build        # desktop bundle + TUI compile check
npm run check:entry  # reproduce the host's exports probe
```

Tests redirect the agent directory with `CLUSTERCODE_AGENTS_DIR`, so they never write your real
`~/.config/opencode/agents`.

`docs/design.md` maps each principle to its module and its test, lists the parity table against
the original project and the deliberate divergences. `docs/development.md` explains the reference
checkout of the OpenCode source under `opencode/` and how to re-check the host API against it.

## Known limitations

- **Sequential, one lane per session.** The cluster runs one turn at a time; parallelism belongs to
  background subagents, which the idle hook deliberately yields to.
- **`cluster_plan` replaces the queue** unless you pass `append: true`.
- **`experimental.idle` is experimental.** A host upgrade can change its shape; after upgrading,
  run `npm run check` first.
- **The verify gate is policy-level.** It runs a shell command; it is not a sandbox.
- **The RPC output schema must list every snapshot field.** The host decodes it as a closed object,
  so a missing field turns into `rpc.invalid_output` and empty panels. `test/rpc.test.ts` walks the
  payload against the schema, so adding a field without the schema fails in CI, not in the client.
- **Empty strings mean "none".** `currentMember`, `stoppedReason`, `member`, `color` and `verify`
  are `""` rather than `null`; the decoder has no null branch.
- **Rendering needs a restart.** The host only probes plugin entry points at startup.

## Lineage

`clustercode` is an independent rewrite of the ideas in **无限制 agent 群** (`unlimited-agent-cluster`),
an OpenCode V2 plugin written in Chinese. What changed in this project:

- English runtime text, comments and docs, so the repo is usable outside one language community.
- `clustercode` / `clustercode-<id>` file names, so both plugins can be installed side by side
  without touching each other's agents.
- One `decide()` for the idle hook and the heartbeat, instead of two copies of the guard order.
- Machine-readable `stoppedCode` alongside the human reason.
- Incremental `append` and `cluster_retry`.
- A schema-coverage test for the RPC payload, which is the bug that used to blank both panels.

## License

MIT. See [LICENSE](LICENSE).
