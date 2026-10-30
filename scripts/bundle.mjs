// Bundles a Node program (api, worker, bridge) into one ESM file, so it runs without
// node_modules or TypeScript tooling. Usage: node scripts/bundle.mjs <entry> <outfile> [--bin]
// --bin adds a shebang and makes the output executable (the bridge's `mm` command).
/* global process, console */
import { build } from "esbuild";

import { chmodSync } from "node:fs";

const [entry, outfile, ...flags] = process.argv.slice(2);
const bin = flags.includes("--bin");
if (!entry || !outfile) {
  console.error("usage: bundle.mjs <entry.ts> <out.js>");
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "linked",
  // Optional native/peer modules that the bundled libraries probe for but don't need.
  external: ["pg-native", "@cfworker/json-schema"],
  // Some bundled CommonJS code calls require(); give ESM output a real one.
  banner: {
    js:
      (bin ? "#!/usr/bin/env node\n" : "") +
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
if (bin) chmodSync(outfile, 0o755);
console.log(`bundled ${entry} -> ${outfile}`);
