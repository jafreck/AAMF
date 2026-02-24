# Task: task-007 - Update Agent Launcher and Orchestrator Unit Tests

**Description:** Update `agent-launcher.test.ts` to exercise the new post-execution parsing path and update `orchestrator.test.ts` mock expectations and phase handler assertions to reflect the structured output flow.
**Files:** runtime/tests/agent-launcher.test.ts, runtime/tests/orchestrator.test.ts
**Dependencies:** task-003, task-004, task-005
**Complexity:** moderate
**Acceptance Criteria:**
- `agent-launcher.test.ts` includes tests for: valid aamf-json output sets `outputParsed: true`; missing block sets `outputParsed: false` with exit-code-based success preserved; invalid block sets `outputParsed: false`, `parseError`, and `success: false`
- `orchestrator.test.ts` mock `AgentResult` objects include `outputParsed` and phase handler assertions reflect structured-output consumption
- All existing and new tests pass when running `npm test`