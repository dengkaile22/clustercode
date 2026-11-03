# Development

## Layout

```
src/
  state.ts        task DAG, rotation, counters, fingerprint   (pure)
  scheduler.ts    decide() + commit(): the only guard order  (pure)
  plan.ts         goal → DAG, JSON repair, cycle detection    (pure except the model call)
  store.ts        cached + serialised persistence, FileStorage
  team.ts         member specs → agent markdown on disk
  tools.ts        the six tools, verify gate, team building
  snapshot.ts     in-memory snapshot published to the RPC
  rpc.ts          the RPC contract (types only, no runtime imports)
  status.ts       display wording shared by both UIs
  index.ts        server entry: hooks, commands, services, heartbeat
  tui.tsx         terminal entry
  gui.tsx         desktop entry (bundled to dist/gui-experimental.cjs)
test/
  *.test.ts       node --test suites
  support/        fake host (harness.ts)
tools/
  check-entrypoints.mjs   reproduce the host's exports probe
  check-tui.mjs           compile + wiring check for the terminal half
  check-gui.mjs           bundle + wiring check for the desktop half
build.mjs         desktop bundle + TUI compile check
```

Rule of thumb: if a piece of logic needs a fake host to test, it belongs in a pure module and the
entry file only wires it up. `scheduler.ts` exists for that reason.

## Module boundaries

`test/architecture.test.ts` reads the source and fails when a boundary is crossed, so this table is
a check rather than advice:

| Module | May import |
|---|---|
| `state.ts` | nothing |
| `scheduler.ts`, `plan.ts` | `state.ts` |
| `status.ts` | `rpc.ts` (types) |
| `store.ts` | `node:fs/promises`, `state.ts` |
| `snapshot.ts` | `state.ts`, `rpc.ts` |
| `rpc.ts` | `@opencode/plugin` (types only) |
| `team.ts` | `node:fs`, `state.ts` |
| `tools.ts` | `node:child_process`, `state`, `store`, `team`, `plan` |
| `index.ts` | everything server-side; wiring only |
| `tui.tsx`, `gui.tsx` | `solid-js`, the host SDK, `rpc.ts`, `status.ts` |

Two consequences worth keeping: the UI halves cannot import server internals (that would create a
second source of truth), and the pure core cannot import the host SDK (that would make it
untestable without an OpenCode process).

## Reference checkout of OpenCode

`opencode/` holds a shallow clone of the host repository, used to check the plugin API against the
real implementation instead of guessing. It is **git-ignored**: it is a development reference, not a
dependency, and it is far too large to vendor.

```powershell
git clone --depth 1 --single-branch --branch dev https://github.com/anomalyco/opencode.git opencode
```

Refresh it when a host upgrade breaks something:

```powershell
git -C opencode fetch --depth 1 origin dev
git -C opencode reset --hard FETCH_HEAD
```

Places worth reading before changing this plugin:

| Question | File |
|---|---|
| What does `setup(ctx)` receive? | `packages/plugin/src/promise/plugin.ts` |
| Which session hooks exist and what shape are their events? | `packages/plugin/src/promise/session.ts` |
| How do `tool.transform` / `command.transform` work? | `packages/plugin/src/promise/tool.ts`, `command.ts` |
| What does `rpc.register` expect? | `packages/plugin/src/promise/rpc.ts` |
| Which TUI slots exist? | `packages/plugin/src/tui/context.ts` (`SlotMap`) |
| What do `Panel` / `ComposerPill` / `Command` accept? | `packages/plugin/src/gui/registries.ts` |

The installed `@opencode/plugin` version in `package.json` is what the typecheck actually runs
against. If the reference checkout and the installed types disagree, the installed package wins.

## Test strategy

`npm run test` uses `node --test` with native TypeScript type stripping: no bundler, no transpiler,
no model, no network. 187 assertions currently.

- **Pure logic** (state, scheduler, plan, status) is tested directly.
- **Host interaction** goes through `test/support/harness.ts`, a fake context implementing exactly
  what the plugin touches: `storage`, `session.hook`, `session.synthetic`, `session.switchAgent`,
  `agent.reload`, `tool.transform`, `command.transform`, `rpc.register`, `experimental.generate`.
- **Verify gate** tests spawn real `node -e` processes, including a timeout kill.
- **Agent file writing** tests point `CLUSTERCODE_AGENTS_DIR` at a temp directory, so a test run
  never touches `~/.config/opencode/agents`.

Driving a whole turn in a test looks like this:

```ts
const h = makeHarness({ dir });
const dispose = await plugin.setup(h.ctx);
await h.callTool("cluster_plan", { goal: "x", tasks: [{ id: "t1", title: "a" }] });
await h.idle();                       // runs experimental.idle
assert.equal(h.synthetics[0].resume, true);
```

## Adding a tool

1. Add it in `tools.ts` inside `registerTools`.
2. Give it a JSON Schema `input`; the host validates against it before calling `execute`.
3. Return `{ content: "..." }`. Keep the text actionable: the model reads it as the tool result.
4. Test it through `harness.callTool` and assert the returned text, not internal state only.

## Changing the RPC contract

The host turns the JSON Schema into a closed-object decoder. Any field present in the payload but
missing from the schema makes the whole call fail with `rpc.invalid_output`, and both panels go
blank. Therefore:

1. Add the field to the View interface **and** to the schema in `rpc.ts`.
2. Keep the value a plain `string` / `number` / `boolean` / array / object. No `null`, no `undefined`:
   use `""`, `-1`, or `false` to mean "none".
3. Run `npm run test`. `test/rpc.test.ts` walks a realistic payload against the schema and fails if
   the two drifted apart.

## Debugging an empty panel

1. Check the server log for the RPC call:
   - `500` with `rpc.invalid_output` → schema/payload mismatch (see above).
   - `500` with `rpc.invalid_input` → the client sent a body that failed the input schema.
2. The TUI panel prints the failure reason instead of pretending there is no cluster. The desktop
   panel prints `RPC failed: ...` at the top.
3. Rebuilt the GUI or changed `exports`? Restart the desktop app and the server. The host probes
   entry points once, at startup.

## Pitfalls that already cost a debugging session

- **YAML frontmatter**: a `description` that starts with `[` is parsed as a flow sequence and the
  whole agent file silently disappears from the list. `JSON.stringify` produces a quoted scalar;
  `test/team.test.ts` keeps it quoted.
- **Policy action names**: a read-only seat must deny `tool.use` with resource `edit:*`. An
  `action: edit` rule matches nothing and grants write access while looking safe.
- **RPC output schema**: the host decodes it as a closed object. One unlisted field is
  `rpc.invalid_output` and a permanently empty panel. `test/rpc.test.ts` compares payload to schema.
- **`resume: false`**: the injected message waits for a wake-up an idle session never receives.
- **Timers**: a plugin reload that does not clear `setInterval` stacks another heartbeat. `setup`
  clears the module-level handles first and `unref()`s them.
- **Windows text encoding**: rewriting UTF-8 files through PowerShell text pipelines can corrupt
  them. Use the editor or Node with an explicit `utf8`.

## Verify gate notes

`runVerify` uses `spawn` with `shell: true`, not `execSync`: a synchronous call inside the OpenCode
server process freezes the event loop for every session. It runs in `ctx.location.directory`, caps
output at 8 kB and kills the process after 120 s.

A `verify` command is executed for real on the user's machine. Treat anything a model writes there
as untrusted input: quote paths, avoid destructive commands, and remember that a passing `verify`
is evidence, not a sandbox.
