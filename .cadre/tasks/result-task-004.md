# Task Result: task-004 - Refactor Orchestrator Phase Handlers to Use structuredOutput

## Changes Made
- `runtime/src/core/orchestrator.ts`: Added `phase3PlanResult` private field to store Phase 3 agent result; updated `executePhase3` to store `planResult`; refactored `executePhase4` to read tasks from `structuredOutput` when `outputParsed` is `true`, falling back to `ResultParser.parseMigrationPlan` with warning; refactored `executePhase5` to read fixes from `structuredOutput` when `outputParsed` is `true`, falling back to `ResultParser.parseFinalParityReport` with warning; updated `recordTokens` to prefer `structuredOutput.tokenUsage` over the existing `tokenUsage` field.

## Files Modified
- runtime/src/core/orchestrator.ts

## Files Created
- (none)

## Notes
- Phase 3 stores its `AgentResult` in `this.phase3PlanResult` so Phase 4 can access it without changing the method signatures.
- The original fileExists guard in Phase 4 was moved inside the fallback branch, preserving the same error path for the legacy (non-structured-output) case.
- Phase 5 no longer needs the separate `reportPath` fileExists guard when `outputParsed` is `true`; the guard remains in the fallback branch.
- `recordTokens` now explicitly checks `structuredOutput.tokenUsage` first, though the agent-launcher already writes this value to `result.tokenUsage` when available — the explicit preference is now documented in code.
- TypeScript build passes with no errors.
