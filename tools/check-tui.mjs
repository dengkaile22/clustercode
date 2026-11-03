/**
 * TUI wiring check.
 *
 * The terminal half is TSX compiled by the host with `@opentui/solid`, so it cannot
 * be imported by Node here. What can be verified without a live terminal:
 *   1. every import resolves and the JSX compiles,
 *   2. the two contributions the panel depends on are present (footer slot + panel slot),
 *   3. the `/cluster` slash command is registered.
 *
 * Rendering itself still needs a real TUI. This check fails when the file stops
 * compiling or a contribution disappears, which is the realistic regression.
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [resolve(root, "src/tui.tsx")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  // Everything the TUI host provides at runtime. Bundling these would drag the
  // whole OpenTUI renderer and its Node builtins into the check.
  external: [
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "solid-js",
    "solid-js/*",
  ],
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "silent",
});

const output = result.outputFiles.map((file) => file.text).join("\n");
const failures = [];

const expect = (needle, label) => {
  if (output.includes(needle)) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL  ${label} (missing ${JSON.stringify(needle)})`);
};

expect('"prompt.footer.status"', "registers the prompt footer status slot");
expect('"session.panel"', "registers the session panel slot");
expect('name: "cluster"', "registers the /cluster slash command");
expect("ClusterSnapshot", "reads the snapshot RPC");
expect('id: "clustercode"', "declares the plugin id");

if (failures.length > 0) {
  console.error(`\n${failures.length} TUI wiring problem(s).`);
  process.exit(1);
}
console.log("\nTUI wiring ok (rendering still needs a live TUI)");
