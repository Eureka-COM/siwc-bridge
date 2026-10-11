import { build } from 'esbuild';

// Browser entry in DSH's lazy CJS module format (DSH decoration plugin template).
// Only this entry is bundled; React and every DSH service come from the host.
await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2023',
  sourcemap: false,
  external: ['react'],
  plugins: [{ name: 'no-runtime-package-imports', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === 'react') return { path: args.path, external: true };
      throw new Error(`Client runtime package imports must be declared explicitly: ${args.path}`);
    });
  } }],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-siwc-bridge",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
