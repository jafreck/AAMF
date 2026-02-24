# Task Result: task-006 - Add parseAamfOutput Tests and Schema Tests

## Changes Made
- `runtime/tests/aamf-output-schema.test.ts`: Created new test file with valid and invalid cases for all 14 per-agent schemas (MigrationOrchestratorOutput through MigrationRunnerOutput). Each schema gets one passing test (correct agent literal + valid status) and one failing test (wrong agent literal).

## Files Modified
- (none)

## Files Created
- runtime/tests/aamf-output-schema.test.ts

## Notes
- `result-parser.test.ts` already contained full `parseAamfOutput` coverage (valid block, last-of-multiple, missing block, malformed JSON, schema validation failure) from a prior task — no changes were needed there.
- All 312 tests pass after adding the new file.
