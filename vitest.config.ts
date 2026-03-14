import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/indexer/**/*.test.ts',
      'tests/util/ensure-python-deps.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Thresholds apply globally (not per-file)
      thresholds: {
        lines: 88,
        branches: 74,
        functions: 88,
        statements: 88,
      },
    },
  },
});
