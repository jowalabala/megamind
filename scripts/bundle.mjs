// Bundles a Node service (api, worker) into one ESM file, so the runtime image needs no
// node_modules and no TypeScript tooling. Usage: node scripts/bundle.mjs <entry> <outfile>
/* global process, console */
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
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
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
console.log(`bundled ${entry} -> ${outfile}`);
