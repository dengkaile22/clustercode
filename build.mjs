/**
 * Bundles the Desktop half to `dist/gui-experimental.cjs`.
 *
 * The GUI bundle must be pre-built: the desktop app does not compile TSX on the fly
 * the way the TUI host does with `@opentui/solid`.
 *
 * The TUI half is *not* bundled — the host compiles `src/tui.tsx` itself. This script
 * still runs it through esbuild as a compile check so a syntax or import error fails
 * `npm run check` instead of showing up as a missing panel.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const gui = await build({
  entryPoints: ["src/gui.tsx"],
  outfile: "dist/gui-experimental.cjs",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "solid-js",
  // Provided by the host: Solid runtime, plugin SDK, schema.
  external: [
    "solid-js",
    "solid-js/*",
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@opencode/schema",
    "@opencode/schema/*",
    "effect",
  ],
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "info",
  metafile: true,
});

const guiBytes = Object.values(gui.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built dist/gui-experimental.cjs (${guiBytes} bytes)`);

const tui = await build({
  entryPoints: ["src/tui.tsx"],
  bundle: false,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@opentui/solid",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "silent",
});

const tuiBytes = tui.outputFiles.reduce((sum, file) => sum + file.contents.length, 0);
console.log(`checked src/tui.tsx (${tuiBytes} bytes, compiled by the host, not written)`);
