/**
 * Replicates how the OpenCode host discovers a plugin: it reads package.json,
 * resolves the `exports` subpaths and probes each half. A wrong `exports` entry is
 * the classic "the plugin loads but the panel never appears" bug, so this runs in CI.
 *
 * Usage: node tools/check-entrypoints.mjs   (run `npm run build` first)
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ok  ${message}`);
    return;
  }
  failures.push(message);
  console.log(`FAIL  ${message}`);
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const requiredHalves = {
  ".": "server",
  "./tui": "tui",
  "./gui-experimental": "desktop",
};

for (const [subpath, half] of Object.entries(requiredHalves)) {
  const target = pkg.exports?.[subpath];
  check(typeof target === "string", `exports["${subpath}"] exists (${half} half)`);
  if (typeof target !== "string") continue;

  const file = join(root, target);
  check(existsSync(file), `exports["${subpath}"] -> ${target} exists`);
  if (!existsSync(file)) continue;
  check(statSync(file).size > 0, `exports["${subpath}"] -> ${target} is not empty`);

  if (half === "desktop") {
    check(/\.(cjs|js)$/.test(target), `desktop half points at a bundled .cjs/.js (${target})`);
  }
}

// The server half is plain TypeScript; Node can import it directly for a smoke test.
const serverEntry = join(root, pkg.exports["."] ?? "src/index.ts");
try {
  const mod = await import(pathToFileURL(serverEntry).href);
  const plugin = mod.default;
  check(plugin?.id === pkg.name, `server entry default.id === "${pkg.name}" (got "${plugin?.id}")`);
  check(typeof plugin?.setup === "function", "server entry default.setup is a function");
} catch (err) {
  check(false, `server entry imports cleanly: ${String(err?.message ?? err)}`);
}

// A plugin installed from a directory needs its entry points in `files`.
const files = pkg.files ?? [];
check(files.includes("src"), "package.files ships src/");
check(files.includes("dist"), "package.files ships dist/");

if (failures.length > 0) {
  console.error(`\n${failures.length} entry point problem(s).`);
  process.exit(1);
}
console.log("\nentry points ok");
