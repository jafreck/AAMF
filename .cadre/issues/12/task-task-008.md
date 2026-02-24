# Task: task-008 - Update E2E Tests for Structured Output Flow

**Description:** Update `e2e-smoke.test.ts` and `e2e-full-migration.test.ts` to account for the new `outputParsed` field on `AgentResult` and any changed orchestrator behaviour.
**Files:** runtime/tests/e2e-smoke.test.ts, runtime/tests/e2e-full-migration.test.ts
**Dependencies:** task-004, task-005, task-007
**Complexity:** moderate
**Acceptance Criteria:**
- E2E smoke and full-migration tests compile without TypeScript errors
- Tests that assert on `AgentResult` shape include the new fields
- All e2e tests pass or are skipped consistent with existing skip behaviour