import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The Temporal worker loads a native module and runs workflows in its own VM sandbox: forked processes are the
    // safe pool for it.
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
