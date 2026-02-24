# Task: task-004 - Refactor Orchestrator Phase Handlers to Use structuredOutput

**Description:** Refactor phase 3, 4, and 5 handlers in `orchestrator.ts` to consume `AgentResult.structuredOutput` instead of file-system reads or regex-based markdown parsing, with fallback to legacy parsing when `outputParsed` is false.
**Files:** runtime/src/core/orchestrator.ts
**Dependencies:** task-001, task-002, task-003
**Complexity:** complex
**Acceptance Criteria:**
- Phase 4 migration-planner handler reads tasks from `structuredOutput` when `outputParsed` is `true`, falls back to `ResultParser.parseMigrationPlan` with a warning when not
- Phase 5 final-parity-checker handler reads fixes from `structuredOutput` when `outputParsed` is `true`, falls back to `ResultParser.parseFinalParityReport` with a warning when not
- Token recording prefers `structuredOutput.tokenUsage` over the existing `tokenUsage` field when both are available
- All existing integration paths continue to work when `outputParsed` is `false`
- TypeScript build passes with no errors