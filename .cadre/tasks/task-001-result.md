# Task Result: task-001 - Extend AgentResult Interface

## Changes Made
- `runtime/src/agents/types.ts`: Added `structuredOutput?: Record<string, unknown>`, `outputParsed: boolean`, and `parseError?: string` fields to the `AgentResult` interface.

## Files Modified
- runtime/src/agents/types.ts

## Files Created
- (none)

## Notes
- Pre-existing build errors in `src/util/process.ts` (missing `@types/node`) are unrelated to this change and were present before the task.
- No errors introduced in `types.ts` by this change.
