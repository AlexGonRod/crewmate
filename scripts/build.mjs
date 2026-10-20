import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { platform } from 'node:process';

await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/crew.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  packages: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

if (platform !== 'win32') {
  chmodSync('dist/crew.js', 0o755);
}
