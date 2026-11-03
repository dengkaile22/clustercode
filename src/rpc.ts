/**
 * The RPC contract between the server half and the UI halves (TUI and Desktop).
 *
 * This module imports types only — it must stay free of runtime dependencies,
 * because the TUI process does not resolve `@opencode/plugin` to the same instance
 * the server uses.
 *
 * Rule that cost a debugging session once: the output schema has to list every
 * field the snapshot can contain. The host turns JSON Schema into a closed object
 * decoder, so a `{ type: "object" }` shell makes every call fail with
 * `rpc.invalid_output` and the panel stays empty forever. `test/rpc.test.ts`
 * asserts the schema covers the payload field by field.
 */

import type { Rpc } from "@opencode/plugin";

export interface TeamMemberView {
  id: string;
  role: string;
  /** Empty string when no colour is configured. Never null: the decoder types it as string. */
  color: string;
}

export interface TaskView {
  id: string;
  title: string;
  status: string;
  /** Empty string when the task follows rotation. */
  member: string;
  blocked: boolean;
  /** Empty string when the task has no acceptance command. */
  verify: string;
  note: string;
}

export interface SessionView {
  sessionID: string;
  goal: string;
  active: boolean;
  round: number;
  /** Empty string when the cluster is still running. */
  stoppedReason: string;
  /** `finished` | `max-rounds` | `stagnant` | `deadlock` | `user` | "". */
  stoppedCode: string;
  heartbeat: boolean;
  heartbeatMs: number;
  /** -1 means "no cap". Numbers only: the decoder has no null branch. */
  maxRounds: number;
  team: TeamMemberView[];
  /** Member taking the next turn; empty string when there is no team. */
  currentMember: string;
  tasks: TaskView[];
  updatedAt: number;
}

export interface SnapshotView {
  updatedAt: number;
  sessions: SessionView[];
}

type Value = Rpc.PortableDefinition["methods"][string]["output"];

const str: Value = { type: "string" };
const num: Value = { type: "number" };
const bool: Value = { type: "boolean" };

/** Objects always list their fields; `additionalProperties` stays open so new fields do not break old clients. */
const obj = (properties: Record<string, Value>): Value => ({
  type: "object",
  properties,
  additionalProperties: true,
});

const arr = (items: Value): Value => ({ type: "array", items });

export const TeamMemberSchema: Value = obj({ id: str, role: str, color: str });

export const TaskSchema: Value = obj({
  id: str,
  title: str,
  status: str,
  member: str,
  blocked: bool,
  verify: str,
  note: str,
});

export const SessionSchema: Value = obj({
  sessionID: str,
  goal: str,
  active: bool,
  round: num,
  stoppedReason: str,
  stoppedCode: str,
  heartbeat: bool,
  heartbeatMs: num,
  maxRounds: num,
  team: arr(TeamMemberSchema),
  currentMember: str,
  tasks: arr(TaskSchema),
  updatedAt: num,
});

export const SnapshotSchema: Value = obj({ updatedAt: num, sessions: arr(SessionSchema) });

export const RPC_ID = "clustercode.snapshot";

export const ClusterSnapshot: Rpc.PortableDefinition = {
  id: RPC_ID,
  methods: {
    get: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: SnapshotSchema,
    },
  },
  events: {},
};
