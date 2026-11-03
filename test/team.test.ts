import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AGENT_PREFIX,
  CLUSTER_ID,
  MANAGED_MARKER,
  agentsDir,
  agentIdFor,
  renderAgent,
  renderClusterAgent,
  syncAgents,
  syncClusterAgent,
  toMembers,
} from "../src/team.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clustercode-agents-"));
  process.env.CLUSTERCODE_AGENTS_DIR = dir;
});

afterEach(() => {
  delete process.env.CLUSTERCODE_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("agent ids", () => {
  it("prefixes member ids once", () => {
    assert.equal(agentIdFor("coder"), "clustercode-coder");
    assert.equal(agentIdFor("clustercode-coder"), "clustercode-coder");
    assert.equal(CLUSTER_ID, "clustercode");
    assert.equal(AGENT_PREFIX, "clustercode-");
  });

  it("honours the directory override", () => {
    assert.equal(agentsDir(), dir);
  });
});

describe("renderAgent", () => {
  const spec = { id: "coder", role: "write code", color: "#22C55E" };

  it("quotes the description so YAML does not read it as a flow sequence", () => {
    const text = renderAgent(spec, [spec]);
    assert.match(text, /^---\ndescription: "\[team\/coder\] write code"$/m);
  });

  it("hides members from the mode picker by default", () => {
    assert.match(renderAgent(spec, [spec]), /^hidden: true$/m);
  });

  it("carries an optional model override", () => {
    assert.match(renderAgent({ ...spec, model: "anthropic/claude" }, [spec]), /^model: "anthropic\/claude"$/m);
  });

  it("denies edit tool calls for a read-only seat", () => {
    const text = renderAgent({ id: "reviewer", role: "review", readOnly: true }, [spec]);
    assert.match(text, /permissions:/);
    assert.match(text, /action: "tool\.use"/);
    assert.match(text, /resource: "edit:\*"/);
    assert.match(text, /effect: deny/);
  });

  it("stamps the management marker and the roster", () => {
    const text = renderAgent(spec, [spec, { id: "tester", role: "test" }]);
    assert.ok(text.includes(MANAGED_MARKER));
    assert.match(text, /- tester: test/);
  });
});

describe("renderClusterAgent", () => {
  it("stays visible in the mode picker", () => {
    const text = renderClusterAgent();
    assert.doesNotMatch(text, /^hidden: true$/m);
    assert.match(text, /^mode: primary$/m);
  });

  it("explains the hand-off and the verify gate", () => {
    const text = renderClusterAgent();
    assert.match(text, /cluster mode/);
    assert.match(text, /verify/);
  });
});

describe("syncAgents", () => {
  const specs = [
    { id: "architect", role: "plan" },
    { id: "coder", role: "code" },
  ];

  it("writes one file per member", () => {
    const result = syncAgents(specs);
    assert.deepEqual(result.written.sort(), ["clustercode-architect.md", "clustercode-coder.md"]);
    assert.ok(existsSync(join(dir, "clustercode-coder.md")));
  });

  it("never overwrites a hand-written file", () => {
    writeFileSync(join(dir, "clustercode-coder.md"), "# mine\n", "utf8");
    const result = syncAgents(specs);
    assert.deepEqual(result.skipped, ["clustercode-coder.md"]);
    assert.equal(readFileSync(join(dir, "clustercode-coder.md"), "utf8"), "# mine\n");
  });

  it("removes managed files of members that left but keeps hand-written ones", () => {
    syncAgents([...specs, { id: "tester", role: "test" }]);
    writeFileSync(join(dir, "clustercode-ghost.md"), "# hand written\n", "utf8");

    const result = syncAgents(specs);
    assert.deepEqual(result.removed, ["clustercode-tester.md"]);
    assert.ok(!existsSync(join(dir, "clustercode-tester.md")));
    assert.ok(existsSync(join(dir, "clustercode-ghost.md")));
  });
});

describe("syncClusterAgent", () => {
  it("writes the Shift+Tab entry point", () => {
    const result = syncClusterAgent();
    assert.equal(result.written, true);
    assert.ok(readFileSync(result.path, "utf8").includes(MANAGED_MARKER));
  });

  it("leaves a hand-written clustercode.md alone", () => {
    const path = join(dir, "clustercode.md");
    writeFileSync(path, "# mine\n", "utf8");
    const result = syncClusterAgent();
    assert.equal(result.written, false);
    assert.equal(result.skipped, true);
    assert.equal(readFileSync(path, "utf8"), "# mine\n");
  });

  it("takes the file over when adopt is set", () => {
    const path = join(dir, "clustercode.md");
    writeFileSync(path, "# mine\n", "utf8");
    const result = syncClusterAgent({ adopt: true });
    assert.equal(result.written, true);
    assert.ok(readFileSync(path, "utf8").includes(MANAGED_MARKER));
  });
});

describe("toMembers", () => {
  it("maps specs to runtime seats", () => {
    assert.deepEqual(toMembers([{ id: "coder", role: "code", color: "#fff" }]), [
      { id: "coder", agentId: "clustercode-coder", role: "code", color: "#fff" },
    ]);
  });
});
