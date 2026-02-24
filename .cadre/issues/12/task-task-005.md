# Task: task-005 - Update Test Helpers and Mocks

**Description:** Update `runtime/tests/helpers/mocks.ts` to include the new `outputParsed`, `structuredOutput`, and `parseError` fields on all mock `AgentResult` objects.
**Files:** runtime/tests/helpers/mocks.ts
**Dependencies:** task-001
**Complexity:** simple
**Acceptance Criteria:**
- All mock `AgentResult` factory functions/objects include `outputParsed: false` as a default
- No TypeScript compilation errors in the helpers module
- Existing tests that import mocks continue to pass without modification