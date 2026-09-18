import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Integration tests need a running database. The address comes from .env locally and
// from the workflow environment in CI, never from a default inside the code.
const env = loadEnv('', process.cwd(), '');

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    env,
  },
});
