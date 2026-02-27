const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

console.log('Building CLI...');

// Build CLI as CJS (avoiding ESM shebang issues in Node 25)
esbuild.buildSync({
  entryPoints: ['src/cli.js'],
  outfile: 'dist/cli.cjs',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  bundle: true,
  minify: false,
  define: {
    'import.meta.url': '""',
  },
  external: [], // Bundle everything
});

console.log('Building server...');

// Build server as ESM
esbuild.buildSync({
  entryPoints: ['src/server.js'],
  outfile: 'dist/server.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: true,
  minify: false,
  external: [], // Bundle everything
});

// Create CLI wrapper script
const wrapperPath = path.join(__dirname, '..', 'dist', 'qwen-proxy');
fs.writeFileSync(wrapperPath, '#!/usr/bin/env node\nrequire("./cli.cjs");');
fs.chmodSync(wrapperPath, '755');

console.log('Build complete!');
