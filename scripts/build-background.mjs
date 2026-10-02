import { build } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
await build({
  configFile: false,
  build: {
    target: 'es2022',
    emptyOutDir: false,
    minify: false,
    lib: { entry: 'src/background.ts', name: 'TabviewBackground', formats: ['iife'], fileName: () => 'background.js' },
  },
});
await mkdir('dist/licenses', { recursive: true });
await copyFile('LICENSE', 'dist/LICENSE');
await copyFile('node_modules/@nozbe/microfuzz/LICENSE', 'dist/licenses/microfuzz.txt');
