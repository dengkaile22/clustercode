# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-04

First public version. An independent rewrite of the ideas in `unlimited-agent-cluster`
(无限制 agent 群) for the OpenCode V2 plugin API.

### Added

- **Task DAG** with `dependsOn`. A task runs only when every dependency is `done`; a failed
  dependency blocks its downstream tasks instead of letting them run on a broken premise.
- **Automatic planning**: `cluster_auto` compiles one goal into a DAG through a single off-session
  model call, then repairs the answer (duplicate ids, unknown members, dangling dependencies,
  cycles, task cap).
- **Team rotation**: members are real agent files (`clustercode-<id>.md`) written to the agent
  directory and reloaded; the plugin swaps seats with `switchAgent` between turns.
- **Verify gate**: marking a task `done` executes its `verify` command for real and refuses the
  update on a non-zero exit code, returning the tail of the output.
- **24h heartbeat** with per-cluster cooldown, session-busy probe and `resume: true` wake-ups.
- **Guards** in a single `decide()` used by both the idle hook and the heartbeat: background work,
  finished queue, deadlock, round cap, stagnation.
- **Tools**: `cluster_auto`, `cluster_plan`, `cluster_update`, `cluster_status`, `cluster_team`,
  `cluster_retry`.
- **Commands**: `/cluster-stop`, `/cluster-resume`.
- **TUI half**: prompt-footer status segment and a `/cluster` panel, reading the snapshot over RPC.
- **Desktop half**: side panel, composer capsule, "+" menu entry, tab-strip button and command
  palette entry, bundled to `dist/gui-experimental.cjs`.
- **Machine-readable `stoppedCode`** (`finished`, `max-rounds`, `stagnant`, `deadlock`, `user`)
  alongside the human-readable reason.
- **Incremental queues**: `cluster_plan({ append: true })`.
- **Retry**: `cluster_retry` resets failed tasks and clears the stop reason.
- **Persistence** with an in-memory cache and per-session serialised writes, plus a `FileStorage`
  backend for environments without plugin storage.
- **Documentation** in English, Simplified Chinese, French, Japanese, Spanish and Portuguese.
- **Checks**: typecheck, 170 test assertions, desktop bundle, TUI compile check, host-style entry
  probe, TUI wiring check, desktop wiring check.

### Notes

- Requires the OpenCode 2.x plugin host (`@opencode/plugin >= 2.0.27 < 3`).
- `experimental.idle` is an experimental host hook; a host upgrade may change its shape.
- The desktop bundle must be rebuilt after changes; the TUI half is compiled by the host.
