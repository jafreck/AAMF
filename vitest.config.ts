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
      exclude: [
        // Phase 0/1 step files are deterministic (Lore IndexBuilder + task-graph)
        // and require a real KB database to test. Covered by e2e tests.
        'src/flow/steps/kb-indexing.ts',
        'src/flow/steps/task-graph.ts',
        'src/flow/index.ts',
        // agent-launcher delegates to @cadre-dev/framework; tested via e2e.
        'src/core/agent-launcher.ts',
      ],
      // Thresholds apply globally (not per-file)
      // Raised after comprehensive step-level unit tests for flow DSL:
      // wave-barrier mode, command recovery, runtime FlowRunner integration,
      // scaffold verification, error paths, and phase cursor helpers.
      thresholds: {
        lines: 86,
        branches: 70,
        functions: 88,
        statements: 85,
      },
    },
  },
});
