import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const alias = {
  '@core': resolve('src/core'),
  '@main': resolve('src/main'),
  '@mcp': resolve('src/mcp'),
  '@privacy': resolve('src/privacy'),
  '@vault': resolve('src/vault'),
  '@shared': resolve('src/shared'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          // Preload for the browser chrome UI (trusted).
          shell: resolve('src/preload/shell.ts'),
          // Preload injected into every web page (hostile territory).
          page: resolve('src/preload/page.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
