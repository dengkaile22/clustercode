/**
 * Architectural invariants, enforced instead of documented.
 *
 * The original project wrote its module boundaries in a notes file. Notes drift, so
 * these checks read the actual source and fail when a boundary is crossed. They are
 * cheap (string matching on ten files) and catch the classic decay: a "pure" module
 * grows a host import, or a UI panel starts reaching into server internals.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const read = (file: string) => readFileSync(resolve(src, file), "utf8");

/** Module specifiers of the static imports. Comment text is not an import. */
const importsOf = (file: string) =>
  [...read(file).matchAll(/^import[^;]+?from\s+"([^"]+)"/gms)].map((match) => match[1]);

const PURE = ["state.ts", "scheduler.ts", "plan.ts", "status.ts"];
const HOST_FREE = [...PURE, "store.ts", "snapshot.ts"];

describe("pure core", () => {
  it("state.ts imports nothing at all", () => {
    assert.deepEqual(importsOf("state.ts"), []);
  });

  it("scheduler.ts only knows state.ts", () => {
    assert.deepEqual(importsOf("scheduler.ts"), ["./state.ts"]);
  });

  it("plan.ts only knows state.ts", () => {
    assert.deepEqual(importsOf("plan.ts"), ["./state.ts"]);
  });

  it("status.ts only knows the RPC types", () => {
    assert.deepEqual(importsOf("status.ts"), ["./rpc.ts"]);
  });

  it("no core module depends on the host SDK", () => {
    for (const file of HOST_FREE) {
      for (const specifier of importsOf(file)) {
        assert.ok(!specifier.startsWith("@opencode/"), `${file} must not import ${specifier}`);
      }
    }
  });
});

describe("host boundary", () => {
  it("only rpc.ts may touch the host, and only for types", () => {
    for (const file of ["state.ts", "scheduler.ts", "plan.ts", "store.ts", "snapshot.ts", "status.ts", "team.ts", "tools.ts"]) {
      for (const specifier of importsOf(file)) {
        assert.ok(!specifier.startsWith("@opencode/"), `${file} must not import ${specifier}`);
      }
    }
    const text = read("rpc.ts");
    assert.match(text, /import type \{[^}]*\} from "@opencode\/plugin"/);
    assert.doesNotMatch(text, /^import \{/m);
  });

  it("file system access stays in the modules that own it", () => {
    const files = ["state.ts", "scheduler.ts", "plan.ts", "status.ts", "snapshot.ts", "rpc.ts", "tools.ts", "index.ts", "tui.tsx", "gui.tsx", "store.ts", "team.ts"];
    const fsUsers = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith("node:fs"))
        .map((specifier) => `${file}:${specifier}`),
    );
    assert.deepEqual(fsUsers.sort(), ["store.ts:node:fs/promises", "team.ts:node:fs"]);
  });

  it("process spawning stays in tools.ts", () => {
    const files = ["state.ts", "scheduler.ts", "plan.ts", "store.ts", "snapshot.ts", "status.ts", "team.ts", "index.ts", "tui.tsx", "gui.tsx"];
    const spawnUsers = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith("node:child_process"))
        .map((specifier) => `${file}:${specifier}`),
    );
    assert.deepEqual(spawnUsers, []);
    assert.deepEqual(importsOf("tools.ts").filter((s) => s.startsWith("node:")), ["node:child_process"]);
  });
});

describe("UI boundary", () => {
  it("the two UI halves read the snapshot, never server internals", () => {
    const forbidden = ["./tools.ts", "./store.ts", "./team.ts", "./index.ts", "./snapshot.ts", "./plan.ts", "./scheduler.ts"];
    for (const file of ["tui.tsx", "gui.tsx"]) {
      const specifiers = importsOf(file);
      for (const banned of forbidden) {
        assert.ok(!specifiers.includes(banned), `${file} must not import ${banned}`);
      }
      assert.deepEqual(
        specifiers.filter((s) => s.startsWith("./")).sort(),
        ["./rpc.ts", "./status.ts"],
        `${file} may only import the RPC contract and the display helpers`,
      );
    }
  });

  it("snapshot.ts stays free of UI and host code", () => {
    for (const specifier of importsOf("snapshot.ts")) {
      assert.ok(!specifier.includes("solid-js"));
      assert.ok(!specifier.startsWith("@opencode/"));
    }
  });
});
