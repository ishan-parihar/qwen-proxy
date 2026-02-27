const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Ensure dist directory exists
if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist', { recursive: true });
}

// Build CLI as CJS
console.log('Building CLI...');
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
  external: ['express'],
});

// Build server as ESM with accounts bundled
console.log('Building server...');
esbuild.buildSync({
  entryPoints: ['src/server.js'],
  outfile: 'dist/server.mjs',
  platform: 'node',
  format: 'esm',
  bundle: true,
  external: ['express'],
  sourcemap: false,
});

// Create CLI wrapper
const wrapper = `#!/usr/bin/env node
require('./cli.cjs');
`;
fs.writeFileSync('dist/qwen-proxy', wrapper);
fs.chmodSync('dist/qwen-proxy', '755');

// Copy accounts module to dist
if (!fs.existsSync('dist/accounts')) {
  fs.mkdirSync('dist/accounts', { recursive: true });
}

console.log('Build complete!');
