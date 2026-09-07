import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [],
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
