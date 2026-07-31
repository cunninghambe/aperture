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
          // Preload for the vault window only. The one preload that exposes a
          // plaintext-returning method, loaded by a window the agent cannot
          // address.
          vault: resolve('src/preload/vault.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          vault: resolve('src/renderer/vault.html'),
        },
      },
    },
  },
});
