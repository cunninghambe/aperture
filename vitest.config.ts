import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Path aliases mirroring tsconfig, so tests can import modules that use them
 * (tabs.ts pulls in @privacy/containers, for instance).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@main': resolve('src/main'),
      '@mcp': resolve('src/mcp'),
      '@privacy': resolve('src/privacy'),
      '@vault': resolve('src/vault'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
