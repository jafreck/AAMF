import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['runtime/tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'runtime/tests/indexer.test.ts',
      'runtime/tests/indexer/**/*.test.ts',
      'runtime/tests/ensure-python-deps.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 88,
        branches: 74,
        functions: 88,
        statements: 88,
      },
    },
  },
});
