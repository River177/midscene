import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/main.js',
  // Prefer CommonJS builds of workspace packages when available
  conditions: ['require', 'node', 'default'],
  // Electron is provided by the runtime – never bundle it
  external: [
    'electron',
    // Native addons that cannot be bundled
    'sharp',
    'canvas',
    // Node built-ins (esbuild handles these automatically for platform:node,
    // but listing 'fsevents' explicitly avoids macOS-only warnings on other OSes)
    'fsevents',
  ],
  // Keep dynamic imports as-is so runtime resolution still works
  splitting: false,
  sourcemap: false,
  minify: false,
  // Suppress warnings from packages that use dynamic require patterns
  logLevel: 'warning',
});

console.log('Build complete: dist/main.js');
