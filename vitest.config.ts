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
      // Exclude flow step files until orchestrator.test.ts is migrated
      // to test individual step functions (see PR #161 Remaining Work).
      exclude: [
        'src/flow/steps/**',
        'src/flow/checkpoint-adapter.ts',
        'src/flow/index.ts',
      ],
      // Thresholds apply globally (not per-file)
      thresholds: {
        lines: 88,
        branches: 74,
        functions: 88,
        statements: 87,
      },
    },
  },
});
