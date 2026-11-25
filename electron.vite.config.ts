import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileIcons, isIconAsset } from './scripts/fileIconsPlugin';

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), fileIcons()],
    // Pierre's highlighting worker imports Shiki grammars on demand, which needs an ES module worker.
    worker: { format: 'es' },
    build: {
      assetsInlineLimit: (file: string) => (isIconAsset(file) ? false : undefined),
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
