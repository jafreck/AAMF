# Task: task-001 - Extend AgentResult Interface

**Description:** Add `structuredOutput`, `outputParsed`, and `parseError` fields to the `AgentResult` interface in `agents/types.ts` so downstream consumers can distinguish parsed structured output from raw stdout.
**Files:** runtime/src/agents/types.ts
**Dependencies:** none
**Complexity:** simple
**Acceptance Criteria:**
- `AgentResult` has an optional `structuredOutput?: Record<string, unknown>` field
- `AgentResult` has a required `outputParsed: boolean` field
- `AgentResult` has an optional `parseError?: string` field
- Existing fields are unchanged and the TypeScript build passes