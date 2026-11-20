import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// npm-Pakete des Servers bleiben extern (liegen im Image unter node_modules),
// alles andere – eigene Workspace-Pakete und deren kleine Abhängigkeiten – wird eingebaut.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = new Set(Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@do-it/')));
const nameOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

await build({
  entryPoints: { main: 'src/main.ts', worker: 'src/worker-main.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  plugins: [
    {
      name: 'externals',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('node:')) return { path: args.path, external: true };
          return external.has(nameOf(args.path)) ? { path: args.path, external: true } : undefined;
        });
      },
    },
  ],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('Server gebaut: dist/main.js, dist/worker.js, dist/cli.js');
