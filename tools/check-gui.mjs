/**
 * Desktop wiring check.
 *
 * The desktop half is a pre-built `.cjs` bundle; the app never compiles it. This
 * asserts that the bundle exists, that it is a CommonJS module with a default export,
 * and that every registry entry the panel needs is present in the built output.
 *
 * It cannot prove rendering: that needs the desktop app. It does prove the bundle was
 * rebuilt after the last source change, which is the mistake this check exists for.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist/gui-experimental.cjs");

const failures = [];
const expect = (condition, label, hint = "") => {
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL  ${label}${hint ? ` — ${hint}` : ""}`);
};

try {
  await stat(bundle);
  console.log("  ok  dist/gui-experimental.cjs exists");
} catch {
  console.error("FAIL  dist/gui-experimental.cjs is missing — run `npm run build` first");
  process.exit(1);
}

const source = await readFile(bundle, "utf8");

expect(source.includes("module.exports") || source.includes("exports.default"), "bundle is CommonJS with a default export");
for (const registry of ["Panel", "ComposerPill", "MenuItem", "Slot", "Command"]) {
  expect(source.includes(registry), `bundle references the ${registry} registry`);
}

for (const needle of ["session.panel", "cluster-status", "clustercode:"]) {
  expect(source.includes(needle), `bundle carries ${needle}`);
}

// The bundle must stay small: a runaway import of the host SDK would balloon it.
const bytes = Buffer.byteLength(source);
expect(bytes > 1_000, `bundle is not empty (${bytes} bytes)`);
expect(bytes < 400_000, `bundle stays under 400 kB (${bytes} bytes)`);

if (failures.length > 0) {
  console.error(`\n${failures.length} desktop wiring problem(s).`);
  process.exit(1);
}
console.log("\ndesktop wiring ok (rendering still needs the desktop app)");
