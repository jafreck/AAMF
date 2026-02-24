# Scout Report

## Relevant Files

| File | Reason |
|------|--------|
| `runtime/src/agents/types.ts` | Must extend `AgentResult` with `structuredOutput`, `outputParsed`, and `parseError` fields |
| `runtime/src/agents/result-parser.ts` | Must add `parseAamfOutput(stdout, schema)` static method plus `AamfOutputBase` Zod schema and per-agent schema registry |
| `runtime/src/core/agent-launcher.ts` | Must integrate `parseAamfOutput` post-execution and set `AgentResult.success = false` on parse/validation failure |
| `runtime/src/core/orchestrator.ts` | Phase 3, 4, 5 handlers must be refactored to consume `AgentResult.structuredOutput` instead of file-system / regex parsing; token usage extraction must be updated |
| `runtime/tests/result-parser.test.ts` | Must add `parseAamfOutput` tests covering valid blocks, missing blocks, malformed JSON, and schema violations |
| `runtime/tests/agent-launcher.test.ts` | Must update to exercise the new post-execution parsing path |
| `runtime/tests/orchestrator.test.ts` | Must update mock launcher and phase handler assertions to reflect structured output flow |
| `runtime/tests/e2e-smoke.test.ts` | E2E smoke test likely needs updating for structured output expectations |
| `runtime/tests/e2e-full-migration.test.ts` | Full migration e2e test will need updating for new flow |
| `.github/agents/adjudicator.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/code-migrator.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/parity-verifier.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/test-writer.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/failure-recovery.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/final-parity-checker.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/e2e-test-crafter.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/documentation-writer.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/migration-runner.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/impact-assessor.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/knowledge-builder.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/large-file-analyzer.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/migration-planner.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `.github/agents/migration-orchestrator.agent.md` | Add `## Output Format` section with `aamf-json` block schema |
| `runtime/tests/helpers/mocks.ts` | Mock launcher `AgentResult` must include the new fields |

## Dependency Map

- `result-parser.ts` imports `types.ts` (`MigrationTask`) and `../util/fs.js`
- `agent-launcher.ts` imports `types.ts` (`AgentInvocation`, `AgentResult`), `result-parser.ts` (`ResultParser`), `../config/schema.js`, `../util/process.js`, `../util/fs.js`, `../logging/logger.js`
- `orchestrator.ts` imports `types.ts`, `result-parser.ts`, `agent-launcher.ts`, `../config/schema.js`, `../execution/*`, `../budget/*`, `../logging/logger.js`, `../util/fs.js`, `../util/process.js`
- New `aamf-output-schema.test.ts` will depend on `result-parser.ts` (the schema registry)
- `tests/helpers/mocks.ts` is consumed by `orchestrator.test.ts`, `agent-launcher.test.ts`, and all e2e tests
- Agent `.md` files have no code dependencies — they are prompt instructions only

## Test Files

- `runtime/tests/result-parser.test.ts` — covers `ResultParser` (good coverage of existing methods; **missing** `parseAamfOutput`)
- `runtime/tests/agent-launcher.test.ts` — covers `AgentLauncher` (existing launch paths; **missing** structured-output parsing path)
- `runtime/tests/orchestrator.test.ts` — covers `MigrationOrchestrator` phase handlers (will need updates for structured output)
- `runtime/tests/e2e-smoke.test.ts` — smoke e2e test
- `runtime/tests/e2e-full-migration.test.ts` — full migration e2e test
- `runtime/tests/e2e-jq-csharp.test.ts`, `e2e-lz4-rust.test.ts`, `e2e-protobuf-upb-rust.test.ts`, `e2e-sqlite-csharp.test.ts`, `e2e-zstd-rust.test.ts` — language-specific e2e tests
- **Gap**: No `aamf-output-schema.test.ts` yet — must be created for per-agent Zod schema tests

## Estimated Change Surface

8 source/test files require code changes; 14 agent markdown files require documentation additions. The most complex changes are in `orchestrator.ts` (refactoring 3 phase handlers away from file-system/regex parsing) and `result-parser.ts` (new method + schema registry). The `agent-launcher.ts` change is moderate (integrating parse call + fallback logic). The `types.ts` change is low-risk and additive. The agent `.md` files are straightforward documentation additions. Risk areas include the backward-compatibility fallback condition (must not break agents that haven't been updated yet) and the token-usage extraction migration (currently regex-based in `parseTokenUsage`; shifting to `structuredOutput.tokenUsage` changes the data path relied upon by the orchestrator).

```cadre-json
{
  "relevantFiles": [
    { "path": "runtime/src/agents/types.ts", "reason": "Must extend AgentResult with structuredOutput, outputParsed, and parseError fields" },
    { "path": "runtime/src/agents/result-parser.ts", "reason": "Must add parseAamfOutput(stdout, schema) static method plus AamfOutputBase Zod schema and per-agent schema registry" },
    { "path": "runtime/src/core/agent-launcher.ts", "reason": "Must integrate parseAamfOutput post-execution and set AgentResult.success = false on parse/validation failure" },
    { "path": "runtime/src/core/orchestrator.ts", "reason": "Phase 3, 4, 5 handlers must be refactored to consume AgentResult.structuredOutput; token usage extraction must be updated" },
    { "path": "runtime/tests/result-parser.test.ts", "reason": "Must add parseAamfOutput tests covering valid blocks, missing blocks, malformed JSON, and schema violations" },
    { "path": "runtime/tests/agent-launcher.test.ts", "reason": "Must update to exercise the new post-execution parsing path" },
    { "path": "runtime/tests/orchestrator.test.ts", "reason": "Must update mock launcher and phase handler assertions to reflect structured output flow" },
    { "path": "runtime/tests/e2e-smoke.test.ts", "reason": "E2E smoke test likely needs updating for structured output expectations" },
    { "path": "runtime/tests/e2e-full-migration.test.ts", "reason": "Full migration e2e test will need updating for new flow" },
    { "path": "runtime/tests/helpers/mocks.ts", "reason": "Mock launcher AgentResult must include the new fields" },
    { "path": ".github/agents/adjudicator.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/code-migrator.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/parity-verifier.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/test-writer.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/failure-recovery.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/final-parity-checker.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/e2e-test-crafter.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/documentation-writer.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/migration-runner.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/impact-assessor.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/knowledge-builder.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/large-file-analyzer.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/migration-planner.agent.md", "reason": "Add Output Format section with aamf-json block schema" },
    { "path": ".github/agents/migration-orchestrator.agent.md", "reason": "Add Output Format section with aamf-json block schema" }
  ],
  "dependencyMap": {
    "runtime/src/agents/types.ts": [],
    "runtime/src/agents/result-parser.ts": ["runtime/src/agents/types.ts", "runtime/src/util/fs.ts"],
    "runtime/src/core/agent-launcher.ts": ["runtime/src/agents/types.ts", "runtime/src/agents/result-parser.ts", "runtime/src/config/schema.ts", "runtime/src/util/process.ts", "runtime/src/util/fs.ts", "runtime/src/logging/logger.ts"],
    "runtime/src/core/orchestrator.ts": ["runtime/src/agents/types.ts", "runtime/src/agents/result-parser.ts", "runtime/src/core/agent-launcher.ts", "runtime/src/config/schema.ts", "runtime/src/execution/parallel-executor.ts", "runtime/src/execution/retry.ts", "runtime/src/budget/token-tracker.ts", "runtime/src/logging/logger.ts", "runtime/src/util/fs.ts"],
    "runtime/tests/result-parser.test.ts": ["runtime/src/agents/result-parser.ts"],
    "runtime/tests/agent-launcher.test.ts": ["runtime/src/core/agent-launcher.ts", "runtime/tests/helpers/mocks.ts"],
    "runtime/tests/orchestrator.test.ts": ["runtime/src/core/orchestrator.ts", "runtime/tests/helpers/mocks.ts", "runtime/src/agents/types.ts"],
    "runtime/tests/helpers/mocks.ts": ["runtime/src/agents/types.ts", "runtime/src/core/agent-launcher.ts"]
  },
  "testFiles": [
    "runtime/tests/result-parser.test.ts",
    "runtime/tests/agent-launcher.test.ts",
    "runtime/tests/orchestrator.test.ts",
    "runtime/tests/e2e-smoke.test.ts",
    "runtime/tests/e2e-full-migration.test.ts",
    "runtime/tests/e2e-jq-csharp.test.ts",
    "runtime/tests/e2e-lz4-rust.test.ts",
    "runtime/tests/e2e-protobuf-upb-rust.test.ts",
    "runtime/tests/e2e-sqlite-csharp.test.ts",
    "runtime/tests/e2e-zstd-rust.test.ts"
  ],
  "estimatedChanges": [
    { "path": "runtime/src/agents/types.ts", "linesEstimate": 15 },
    { "path": "runtime/src/agents/result-parser.ts", "linesEstimate": 120 },
    { "path": "runtime/src/core/agent-launcher.ts", "linesEstimate": 40 },
    { "path": "runtime/src/core/orchestrator.ts", "linesEstimate": 80 },
    { "path": "runtime/tests/result-parser.test.ts", "linesEstimate": 80 },
    { "path": "runtime/tests/agent-launcher.test.ts", "linesEstimate": 40 },
    { "path": "runtime/tests/orchestrator.test.ts", "linesEstimate": 50 },
    { "path": "runtime/tests/helpers/mocks.ts", "linesEstimate": 15 },
    { "path": "runtime/tests/e2e-smoke.test.ts", "linesEstimate": 20 },
    { "path": "runtime/tests/e2e-full-migration.test.ts", "linesEstimate": 20 },
    { "path": ".github/agents/adjudicator.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/code-migrator.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/parity-verifier.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/test-writer.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/failure-recovery.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/final-parity-checker.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/e2e-test-crafter.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/documentation-writer.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/migration-runner.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/impact-assessor.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/knowledge-builder.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/large-file-analyzer.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/migration-planner.agent.md", "linesEstimate": 25 },
    { "path": ".github/agents/migration-orchestrator.agent.md", "linesEstimate": 25 }
  ]
}
```
