// Build: host plugin (lib/index.js) and the agent sub-plugin (lib/agent.js) as Node ESM.
// Shared code goes to lib/chunks/ so both entries share one runtime instance in the DSH process.
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });
await build({
  entryPoints: { index: 'src/index.ts', agent: 'src/agent/plugin.ts' },
  outdir: 'lib',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built lib/index.js and lib/agent.js');
