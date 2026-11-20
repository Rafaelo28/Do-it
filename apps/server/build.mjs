import { build } from 'esbuild';

// Eigene Workspace-Pakete werden eingebaut, npm-Pakete bleiben extern (node_modules im Image).
await build({
  entryPoints: { main: 'src/main.ts', worker: 'src/worker-main.ts' },
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
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@do-it/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('Server gebaut: dist/main.js, dist/worker.js');
