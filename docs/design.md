# Design

This document is the map between the *ideas* clustercode inherited from
[无限制 agent 群](../README.md#lineage) (`unlimited-agent-cluster`) and the code that holds
them. Every principle lists where it lives and what fails when it is violated. If a principle
cannot point at a test, it is a slogan — and slogans do not survive a refactor.

## Principles

### 1. One trigger, one scheduler

A turn ends, and exactly one place decides what happens next. The fast path is
`experimental.idle`; the recovery path is the heartbeat timer. Both call `decide()` in
`scheduler.ts`, so the guard order is written once.

Why it matters: the original project had the guards inline in the idle hook and a second,
slightly different copy in the heartbeat. That is how "the heartbeat wakes a run that already
hit its round cap" happens.

- Code: `src/scheduler.ts` (`decide`, `commit`), `src/index.ts` (both callers)
- Tests: `test/plugin.test.ts` (heartbeat applies the cap), `test/scheduler.test.ts` (order)

### 2. `resume: true` closes the loop

`session.synthetic({ resume: true })` runs the injected message inside the same execution.
With `resume: false` the message waits for the next wake-up, and an idle session never gets
one: the run stops silently and nothing reports an error.

- Code: `src/index.ts` (idle hook, heartbeat, resume command)
- Tests: `test/plugin.test.ts` asserts `resume === true` on every injected turn

### 3. Evidence over self-assessment

A model marking its own work `done` is not evidence. When a task carries `verify`, the plugin
executes that command before accepting `done`, and returns the tail of the output when it fails.
`skipVerify` exists for the case where the command itself is broken, not as a shortcut.

- Code: `runVerify` + the gate in `src/tools.ts`
- Tests: `test/tools.test.ts` (failing, passing, skipped, timeout)

### 4. Stop before continuing on a broken premise

A failed dependency does **not** satisfy a dependency. When the graph can no longer make
progress — a cycle, or a failed upstream task — the run stops immediately with a reason, instead
of spinning until the stagnation counter notices.

- Code: `depsSatisfied`, `isDeadlocked`, `decide()`'s `deadlock` branch
- Tests: `test/state.test.ts`, `test/scheduler.test.ts`

### 5. Cheap progress detection

Progress is a status fingerprint: `id | status` per task. Notes and timestamps deliberately do
not count, otherwise a model could "make progress" by rewriting the same note forever.

- Code: `fingerprint`, `nextStagnant` in `src/state.ts`
- Tests: `test/state.test.ts` (ignores notes, resets on status change)

### 6. Yield by default

Three concrete yields, all inherited from the original:

- **Background work** — a running subagent or shell wins; those jobs wake the same hook when
  they finish, so racing them corrupts the turn count.
- **Other plugins** — `retry` and `permission.evaluate` belong to whoever already owns them.
  clustercode does not register either, because two plugins writing `event.decision` is a
  coin flip.
- **Prompt cache** — the injected system card is constant, and an idempotency check keeps it to
  one copy, so the cache is not invalidated every turn.

- Code: `src/index.ts` (background guard, the "deliberately NOT registered" block, card check)
- Tests: `test/plugin.test.ts` (background wait, card injected once)

### 7. Files are the API

The host has no "create agent" call. A seat is a markdown file plus `agent.reload()`. Files the
plugin writes carry `<!-- managed-by: clustercode -->`; a same-named file without the marker is
the user's and is never overwritten or deleted. Shrinking a team removes only managed orphans.

- Code: `src/team.ts`
- Tests: `test/team.test.ts` (marker, adopt, skip hand-written, orphan cleanup)

### 8. One data path

Server state → in-memory snapshot → RPC → both UIs. The panels never read the server's memory or
disk, so a desktop attached to a remote server behaves like a local one. Both halves share the
display functions in `status.ts`, so the footer and the panel cannot disagree about the numbers.

- Code: `src/snapshot.ts`, `src/rpc.ts`, `src/status.ts`
- Tests: `test/rpc.test.ts` (payload vs schema), `test/status.test.ts`

### 9. Empty string, never `null`

The RPC decoder is generated from JSON Schema and has no null branch for these fields. "No
member", "no stop reason", "no verify command" are `""`; "no round cap" is `-1`. A missing field
is worse than an empty one: it fails the whole call.

- Code: `src/snapshot.ts`, `src/rpc.ts`
- Tests: `test/rpc.test.ts` walks a realistic payload against the schema field by field

### 10. Measured numbers only

The original project's notes record a documentation incident: an assertion count was written by
hand, drifted, and nobody noticed. Here every number in the docs comes from a command that can
be re-run, and `npm run check` is the gate.

- Code: `package.json` scripts, `tools/check-*.mjs`
- Enforced by: CI on Ubuntu and Windows

## Module boundaries

Enforced by `test/architecture.test.ts`, which reads the source and fails on a crossed boundary.

| Module | May import | Role |
|---|---|---|
| `state.ts` | nothing | data + DAG + counters |
| `scheduler.ts` | `state.ts` | the guard order, once |
| `plan.ts` | `state.ts` | goal → DAG, repairs, cycles |
| `status.ts` | `rpc.ts` (types) | display wording |
| `store.ts` | `node:fs/promises`, `state.ts` | persistence |
| `snapshot.ts` | `state.ts`, `rpc.ts` | snapshot projection |
| `rpc.ts` | `@opencode/plugin` (types only) | the wire contract |
| `team.ts` | `node:fs`, `state.ts` | seats on disk |
| `tools.ts` | `node:child_process`, `state`, `store`, `team`, `plan` | the model-facing surface |
| `index.ts` | everything server-side | wiring only |
| `tui.tsx` / `gui.tsx` | `solid-js`, host SDK, `rpc.ts`, `status.ts` | rendering only |

The UI rows are the important ones: a panel that starts importing `tools.ts` or `store.ts` is the
beginning of two sources of truth.

## Parity with 无限制 agent 群

| Idea / feature | Original | clustercode | Covered by |
|---|---|---|---|
| Idle-driven continuation | `src/index.ts` | `src/index.ts` | `test/plugin.test.ts` |
| Five guards in order | inline in hook + heartbeat | `decide()` | `test/scheduler.test.ts` |
| Team rotation + cursor | `src/state.ts` `pickMember` | same | `test/state.test.ts`, `test/plugin.test.ts` |
| Switch failure degrades | `switchAgent` try/catch | same | `test/plugin.test.ts` |
| Task DAG + deadlock | `isDeadlocked` | same, plus `deadlock` stop code | `test/state.test.ts` |
| verify gate | `runVerify` + gate | same | `test/tools.test.ts` |
| Stagnation fingerprint | `fingerprint` | same | `test/state.test.ts` |
| 24h heartbeat | `heartbeatTick` | same, guards evaluated before cooldown | `test/plugin.test.ts` |
| Crash recovery | `scanAll` at boot | same | `test/store.test.ts` |
| Auto planning + repairs | `src/plan.ts` | same | `test/plan.test.ts` |
| Managed agent files | `src/team.ts` | same, `clustercode-` prefix | `test/team.test.ts` |
| Shift+Tab cluster mode | `cluster.md` | `clustercode.md` | `test/team.test.ts` |
| Read-only reviewer | `tool.use` + `edit:*` | same | `test/team.test.ts` |
| Snapshot RPC | `clustercode.snapshot` | same | `test/rpc.test.ts` |
| TUI footer + panel | `src/tui.tsx` | same | `tools/check-tui.mjs` |
| Desktop panel + pill + menus | `src/gui.tsx` | same | `tools/check-gui.mjs` |
| Entry probing | `check-entrypoints.mjs` | same | `tools/check-entrypoints.mjs` |
| Test harness with fake host | `test/simulate.ts` | `test/support/harness.ts` | `test/*.test.ts` |

## Deliberate divergences

| Change | Why |
|---|---|
| English runtime text and docs | the repository is public beyond one language community |
| `clustercode` / `clustercode-<id>` file names | both plugins can be installed side by side without fighting over `cluster.md` |
| One `decide()` for idle and heartbeat | removes the duplicated guard order, the original's weakest seam |
| `stoppedCode` next to `stoppedReason` | a UI or script can branch on the reason without parsing prose |
| `cluster_plan({ append: true })` | the original replaced the whole queue; appending preserves progress |
| `cluster_retry` | failed tasks can be retried without rebuilding the queue |
| No `state.json` snapshot file | the RPC is the only data path; a file that goes stale confused users |
| Guardrail warning in the tool result | the original only warned in the README; the tool now says it |
| Architecture test | module boundaries were notes; now they fail the build |
| `FileStorage` backend | lets the core run outside the plugin (tests, local inspection) |

## Non-goals

- **Permission bypass.** Sandboxing and permission policy belong to the host and to plugins that
  own that area. clustercode never registers `permission.evaluate`.
- **Retry policy.** Yielding is deliberate; see principle 6.
- **Parallel lanes.** A session runs one turn at a time. Parallelism is what background subagents
  are for, and the idle hook yields to them.
- **A sandbox for `verify`.** The gate runs a real shell command in the session directory. It is
  evidence, not isolation.
- **Vendoring the host.** `opencode/` is a development reference and is git-ignored; the plugin
  depends on `@opencode/plugin`, not on a copy of it.
