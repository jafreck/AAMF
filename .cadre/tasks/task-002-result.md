# Task Result: task-002 - Add AamfOutputBase Schema and parseAamfOutput to ResultParser

## Changes Made
- `runtime/src/agents/result-parser.ts`: Added `AamfOutputBase` Zod schema with `status`, `agent`, `taskId` (optional), `tokenUsage` (optional), and `notes` (optional) fields. Added 14 per-agent schemas (one per named agent) extending `AamfOutputBase` with a literal `agent` field. Added `ResultParser.parseAamfOutput(stdout, schema)` static method that extracts the last `aamf-json` fenced block from stdout, parses JSON, validates against the provided schema, and returns `{ data, parsed: true }` on success or `{ parsed: false, error }` on failure.

## Files Modified
- runtime/src/agents/result-parser.ts

## Files Created
- (none)

## Notes
- `parseAamfOutput` uses the last `aamf-json` block (not the first) to allow agents to emit intermediate blocks and have the final one win.
- Missing block produces error: `'missing aamf-json block'` as required.
- All 232 existing tests continue to pass; build is clean.
