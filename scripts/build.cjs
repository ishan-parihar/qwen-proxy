const esbuild = require('esbuild');
const fs = require('fs');

// Ensure dist directory exists
if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist', { recursive: true });
}

// Build CLI as CJS
esbuild.buildSync({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  sourcemap: false,
  define: {
    'import.meta.url': '""',
  },
});

// Build server as ESM
esbuild.buildSync({
  entryPoints: ['src/server.js'],
  outfile: 'dist/server.mjs',
  platform: 'node',
  format: 'esm',
  bundle: true,
  external: ['express'],
  sourcemap: false,
});

// Create CLI wrapper (this must be CJS, so we use .cjs trick)
const wrapper = `#!/usr/bin/env node
require('./cli.cjs');
`;
fs.writeFileSync('dist/qwen-proxy', wrapper);
fs.chmodSync('dist/qwen-proxy', '755');

console.log('Build complete!');
