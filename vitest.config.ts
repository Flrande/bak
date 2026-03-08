import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@flrande/bak-protocol': resolve(__dirname, 'packages/protocol/src/index.ts')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      reporter: ['text', 'html']
    }
  }
});
