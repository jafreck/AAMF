# Task Result: task-003 - Integrate parseAamfOutput into AgentLauncher with Fallback

## Changes Made
- `runtime/src/core/agent-launcher.ts`: Added imports for all per-agent Zod schemas and `z` from zod. Added module-level `agentOutputSchemas` map from `AgentName` to schema. After building `agentResult` in `launchCliMode`, calls `ResultParser.parseAamfOutput` with the agent's schema and handles three cases: success (populate `structuredOutput`, set `outputParsed: true`, prefer structured `tokenUsage`), absent block (warn and leave `success` unchanged), invalid block (set `parseError`, force `success: false`).

## Files Modified
- runtime/src/core/agent-launcher.ts

## Files Created
- (none)

## Notes
- Distinguishes "missing block" from "present but invalid" by checking `parseResult.error === 'missing aamf-json block'`, matching the exact string returned by `ResultParser.parseAamfOutput`.
- The `AgentName` import was added alongside `AgentResult` to type the schema map correctly.
- Build and all 312 tests pass after changes.
