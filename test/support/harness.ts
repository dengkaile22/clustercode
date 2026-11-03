/**
 * Fake OpenCode host for tests.
 *
 * It implements only the surface the plugin actually touches, so a test can drive
 * whole turns (idle hook -> tool call -> next idle hook) without an OpenCode
 * process, a model, or network access.
 */

import { MemoryStorage } from "../../src/store.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  execute: (input: Record<string, unknown>, context: { sessionID: string }) => Promise<{
    content: string;
  }>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  execute: (input: { sessionID: string }) => Promise<void>;
}

export interface SyntheticCall {
  sessionID: string;
  text: string;
  description?: string;
  resume?: boolean;
}

export interface HarnessOptions {
  /** Working directory for verify commands. */
  dir?: string;
  /** Fake `ctx.experimental.generate.text`. */
  generate?: (prompt: string) => Promise<{ text?: string }>;
  /** Make `switchAgent` throw, to exercise the degradation path. */
  switchAgentError?: string;
  /** Session busy/idle timestamps for the heartbeat idle probe. */
  sessionBusy?: number;
  sessionIdle?: number;
}

export interface Harness {
  ctx: any;
  storage: MemoryStorage;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  synthetics: SyntheticCall[];
  switches: Array<{ sessionID: string; agent: string }>;
  reloads: number;
  rpc: { definition: any; handlers: any } | null;
  runHook: (name: string, event: unknown) => Promise<void>;
  callTool: (name: string, input?: Record<string, unknown>, sessionID?: string) => Promise<{ content: string }>;
  runCommand: (name: string, sessionID?: string) => Promise<void>;
  idle: (sessionID?: string, background?: unknown[]) => Promise<void>;
}

export const TEST_SESSION = "ses_test";

export function makeHarness(options: HarnessOptions = {}): Harness {
  const storage = new MemoryStorage();
  const hooks = new Map<string, Array<(event: any) => Promise<void> | void>>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const synthetics: SyntheticCall[] = [];
  const switches: Array<{ sessionID: string; agent: string }> = [];
  let reloads = 0;
  let rpc: Harness["rpc"] = null;

  const registration = { dispose: async () => {} };

  const ctx = {
    location: { directory: options.dir ?? process.cwd() },
    storage,
    agent: {
      reload: async () => {
        reloads += 1;
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        const list = hooks.get(name) ?? [];
        list.push(callback);
        hooks.set(name, list);
        return registration;
      },
      synthetic: async (input: SyntheticCall) => {
        synthetics.push(input);
        return { id: `msg_${synthetics.length}` };
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        if (options.switchAgentError) throw new Error(options.switchAgentError);
        switches.push(input);
      },
      get: async () => ({
        time: { busy: options.sessionBusy ?? 0, idle: options.sessionIdle ?? Date.now() },
      }),
    },
    command: {
      transform: async (callback: (editor: { add: (definition: CommandDefinition) => void }) => void) => {
        callback({ add: (definition) => commands.set(definition.name, definition) });
        return registration;
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (definition: ToolDefinition) => void }) => void) => {
        callback({ add: (definition) => tools.set(definition.name, definition) });
        return registration;
      },
    },
    rpc: {
      register: async (definition: any, handlers: any) => {
        rpc = { definition, handlers };
        return { ...registration, events: { emit: async () => {} } };
      },
    },
    experimental: {
      generate: {
        text:
          options.generate ??
          (async () => ({
            text: JSON.stringify({
              tasks: [
                { id: "t1", title: "first task", dependsOn: [] },
                { id: "t2", title: "second task", dependsOn: ["t1"] },
              ],
            }),
          })),
      },
    },
  };

  return {
    ctx,
    storage,
    tools,
    commands,
    synthetics,
    switches,
    get reloads() {
      return reloads;
    },
    get rpc() {
      return rpc;
    },
    runHook: async (name, event) => {
      for (const callback of hooks.get(name) ?? []) await callback(event);
    },
    callTool: async (name, input = {}, sessionID = TEST_SESSION) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} was not registered`);
      return tool.execute(input, { sessionID });
    },
    runCommand: async (name, sessionID = TEST_SESSION) => {
      const command = commands.get(name);
      if (!command) throw new Error(`command ${name} was not registered`);
      await command.execute({ sessionID });
    },
    idle: async (sessionID = TEST_SESSION, background: unknown[] = []) => {
      for (const callback of hooks.get("experimental.idle") ?? []) {
        await callback({ sessionID, background });
      }
    },
  };
}
