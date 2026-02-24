# Task: task-006 - Add parseAamfOutput Tests and Schema Tests

**Description:** Add `parseAamfOutput` test cases to `result-parser.test.ts` and create a new `aamf-output-schema.test.ts` with schema validation tests for each per-agent schema.
**Files:** runtime/tests/result-parser.test.ts, runtime/tests/aamf-output-schema.test.ts
**Dependencies:** task-002
**Complexity:** moderate
**Acceptance Criteria:**
- `result-parser.test.ts` includes tests for: valid block (extracts last when multiple exist), missing block, malformed JSON block, and schema validation failure
- `runtime/tests/aamf-output-schema.test.ts` is created with at least one valid and one invalid case for each of the 14 per-agent schemas
- All new tests pass when running `npm test`