#!/usr/bin/env node
/**
 * Bundles functions/src/index.ts (+ ../shared domain logic and its small deps) into lib/index.js.
 * Runtime dependencies listed in package.json stay external — Cloud Build installs them.
 * Run: `npm run build` (also the firebase.json predeploy step).
 */
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await rm(join(here, 'lib'), { recursive: true, force: true });

const result = await build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // ESM bundle: give bundled CommonJS code a working `require` if it ever needs one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs);
const sharedCount = inputs.filter((p) => p.includes('shared/')).length;
console.log(`functions: bundled ${inputs.length} modules (${sharedCount} from ../shared) → lib/index.js`);
