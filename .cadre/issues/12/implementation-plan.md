# Implementation Plan — Issue #12: Structured `aamf-json` Output Parsing

## task-001 – Extend AgentResult Interface

**Description:** Add `structuredOutput`, `outputParsed`, and `parseError` fields to the `AgentResult` interface in `agents/types.ts` so downstream consumers can distinguish parsed structured output from raw stdout.
**Files:** `runtime/src/agents/types.ts`
**Dependencies:** none
**Complexity:** simple
**Acceptance Criteria:**
- `AgentResult` has an optional `structuredOutput?: Record<string, unknown>` field
- `AgentResult` has a required `outputParsed: boolean` field
- `AgentResult` has an optional `parseError?: string` field
- Existing fields are unchanged and the TypeScript build passes

---

## task-002 – Add AamfOutputBase Schema and parseAamfOutput to ResultParser

**Description:** Define a common `AamfOutputBase` Zod schema (fields: `status`, `agent`, `taskId`, `tokenUsage`, `notes`) and per-agent schemas extending it, then add a `parseAamfOutput(stdout, schema)` static method to `ResultParser` that extracts the last `aamf-json` fenced block from stdout and validates it against the provided schema.
**Files:** `runtime/src/agents/result-parser.ts`
**Dependencies:** task-001
**Complexity:** complex
**Acceptance Criteria:**
- `AamfOutputBase` Zod schema is exported from `result-parser.ts` with fields: `status` (enum: `completed|failed|needs-review`), `agent` (string), `taskId` (string), `tokenUsage` (optional object with `prompt`, `completion`, `total`), `notes` (optional string)
- Per-agent Zod schemas are exported for all 14 named agents (adjudicator, code-migrator, parity-verifier, test-writer, failure-recovery, final-parity-checker, e2e-test-crafter, documentation-writer, migration-runner, impact-assessor, knowledge-builder, large-file-analyzer, migration-planner, migration-orchestrator)
- `ResultParser.parseAamfOutput(stdout: string, schema: z.ZodTypeAny)` static method is exported
- The method extracts the **last** fenced ` ```aamf-json ` block from stdout
- Returns `{ data, parsed: true }` on success and `{ parsed: false, error: string }` on missing block, malformed JSON, or schema validation failure
- When no `aamf-json` block is present, the error message clearly states "missing aamf-json block"

---

## task-003 – Integrate parseAamfOutput into AgentLauncher with Fallback

**Description:** Update `AgentLauncher.launchCliMode` to call `parseAamfOutput` after execution and populate the new `structuredOutput`, `outputParsed`, and `parseError` fields on `AgentResult`. When the block is absent, log a warning and fall back gracefully (backward-compatible mode: keep `success` as-is based on exit code). When the block is present but malformed or schema-invalid, set `success = false` and `parseError`.
**Files:** `runtime/src/core/agent-launcher.ts`
**Dependencies:** task-001, task-002
**Complexity:** moderate
**Acceptance Criteria:**
- After agent execution, `parseAamfOutput` is called with the agent's stdout and the matching per-agent schema
- When parsing succeeds: `structuredOutput` is populated, `outputParsed` is `true`, and `parseError` is undefined
- When the `aamf-json` block is absent: a warning is logged, `outputParsed` is `false`, and `success` is unchanged (fallback to exit-code-based logic)
- When the block is present but invalid (bad JSON or schema error): `outputParsed` is `false`, `parseError` is set, and `success` is forced to `false`
- When `structuredOutput.tokenUsage` is present it is used instead of the regex-based `parseTokenUsage` result

---

## task-004 – Refactor Orchestrator Phase Handlers to Use structuredOutput

**Description:** Refactor the phase 3, 4, and 5 handlers in `orchestrator.ts` to consume `AgentResult.structuredOutput` instead of file-system reads or regex-based markdown parsing where the data is available. Update token-usage recording to prefer `structuredOutput.tokenUsage`.
**Files:** `runtime/src/core/orchestrator.ts`
**Dependencies:** task-001, task-002, task-003
**Complexity:** complex
**Acceptance Criteria:**
- Phase 4 migration-planner handler reads the task list from `structuredOutput` when `outputParsed` is `true`, and falls back to `ResultParser.parseMigrationPlan` (file read) with a warning when not
- Phase 5 final-parity-checker handler reads fixes from `structuredOutput` when `outputParsed` is `true`, and falls back to `ResultParser.parseFinalParityReport` (file read) with a warning when not
- `recordTokens` (or equivalent) prefers `structuredOutput.tokenUsage` over the existing `tokenUsage` field when both are available
- All existing integration paths continue to work correctly when `outputParsed` is `false` (backward compatibility)
- TypeScript build passes with no errors

---

## task-005 – Update Test Helpers and Mocks

**Description:** Update `runtime/tests/helpers/mocks.ts` to include the new `outputParsed`, `structuredOutput`, and `parseError` fields on all mock `AgentResult` objects so that dependent tests compile and run correctly.
**Files:** `runtime/tests/helpers/mocks.ts`
**Dependencies:** task-001
**Complexity:** simple
**Acceptance Criteria:**
- All mock `AgentResult` factory functions/objects include `outputParsed: false` (or appropriate value) as a default
- No TypeScript compilation errors in the helpers module
- Existing tests that import mocks continue to pass without modification

---

## task-006 – Add parseAamfOutput Tests and Schema Tests

**Description:** Add `parseAamfOutput` test cases to `result-parser.test.ts` covering valid blocks, missing blocks, malformed JSON, and schema violations. Create a new `aamf-output-schema.test.ts` file with schema validation tests for each per-agent schema.
**Files:** `runtime/tests/result-parser.test.ts`, `runtime/tests/aamf-output-schema.test.ts`
**Dependencies:** task-002
**Complexity:** moderate
**Acceptance Criteria:**
- `result-parser.test.ts` includes tests for: valid `aamf-json` block (extracts last block when multiple exist), missing block (returns `parsed: false` with appropriate error), malformed JSON block (returns `parsed: false`), and schema validation failure (returns `parsed: false`)
- `runtime/tests/aamf-output-schema.test.ts` is created and contains at least one valid and one invalid case for each of the 14 per-agent schemas
- All new tests pass when running `npm test`

---

## task-007 – Update Agent Launcher and Orchestrator Unit Tests

**Description:** Update `agent-launcher.test.ts` to exercise the new post-execution parsing path (success, missing block fallback, invalid block failure). Update `orchestrator.test.ts` mock expectations and phase handler assertions to reflect the structured output flow.
**Files:** `runtime/tests/agent-launcher.test.ts`, `runtime/tests/orchestrator.test.ts`
**Dependencies:** task-003, task-004, task-005
**Complexity:** moderate
**Acceptance Criteria:**
- `agent-launcher.test.ts` includes tests covering: agent with valid `aamf-json` output sets `outputParsed: true` and `structuredOutput`; agent with missing block sets `outputParsed: false` and preserves exit-code-based success; agent with invalid block sets `outputParsed: false`, `parseError`, and `success: false`
- `orchestrator.test.ts` is updated so that mock `AgentResult` objects include `outputParsed` and phase handler assertions reflect the new structured-output consumption path
- All existing and new tests pass when running `npm test`

---

## task-008 – Update E2E Tests for Structured Output Flow

**Description:** Update `e2e-smoke.test.ts` and `e2e-full-migration.test.ts` to account for the new `outputParsed` field on `AgentResult` and any changed orchestrator behaviour caused by the structured output refactor.
**Files:** `runtime/tests/e2e-smoke.test.ts`, `runtime/tests/e2e-full-migration.test.ts`
**Dependencies:** task-004, task-005, task-007
**Complexity:** moderate
**Acceptance Criteria:**
- E2E smoke and full-migration tests compile without TypeScript errors
- Tests that assert on `AgentResult` shape include the new fields
- All e2e tests pass (or are marked as skipped if they require a live Copilot process, consistent with existing skip behaviour)

---

## task-009 – Add Output Format Sections to Agent Definition Files

**Description:** Add an `## Output Format` section to each of the 14 agent `.agent.md` files in `.github/agents/`. Each section must specify the `aamf-json` block schema, a valid output example, and a warning that non-conforming output will cause the agent run to fail.
**Files:** `.github/agents/adjudicator.agent.md`, `.github/agents/code-migrator.agent.md`, `.github/agents/parity-verifier.agent.md`, `.github/agents/test-writer.agent.md`, `.github/agents/failure-recovery.agent.md`, `.github/agents/final-parity-checker.agent.md`, `.github/agents/e2e-test-crafter.agent.md`, `.github/agents/documentation-writer.agent.md`, `.github/agents/migration-runner.agent.md`, `.github/agents/impact-assessor.agent.md`, `.github/agents/knowledge-builder.agent.md`, `.github/agents/large-file-analyzer.agent.md`, `.github/agents/migration-planner.agent.md`, `.github/agents/migration-orchestrator.agent.md`
**Dependencies:** task-002
**Complexity:** moderate
**Acceptance Criteria:**
- Each of the 14 agent files has an `## Output Format` section
- Each section includes: a description of the `aamf-json` fenced block requirement, the JSON schema fields (including any agent-specific fields beyond `AamfOutputBase`), a concrete valid example block, and a warning statement that non-conforming output will be rejected by the runtime
- The `aamf-json` block must be the last fenced code block in the agent's output
- No existing content in any file is removed or altered

---

```cadre-json
[
  {
    "id": "task-001",
    "name": "Extend AgentResult Interface",
    "description": "Add `structuredOutput`, `outputParsed`, and `parseError` fields to the `AgentResult` interface in `agents/types.ts` so downstream consumers can distinguish parsed structured output from raw stdout.",
    "files": ["runtime/src/agents/types.ts"],
    "dependencies": [],
    "complexity": "simple",
    "acceptanceCriteria": [
      "`AgentResult` has an optional `structuredOutput?: Record<string, unknown>` field",
      "`AgentResult` has a required `outputParsed: boolean` field",
      "`AgentResult` has an optional `parseError?: string` field",
      "Existing fields are unchanged and the TypeScript build passes"
    ]
  },
  {
    "id": "task-002",
    "name": "Add AamfOutputBase Schema and parseAamfOutput to ResultParser",
    "description": "Define a common `AamfOutputBase` Zod schema and per-agent schemas extending it, then add a `parseAamfOutput(stdout, schema)` static method to `ResultParser` that extracts the last `aamf-json` fenced block and validates it against the provided schema.",
    "files": ["runtime/src/agents/result-parser.ts"],
    "dependencies": ["task-001"],
    "complexity": "complex",
    "acceptanceCriteria": [
      "`AamfOutputBase` Zod schema is exported with fields: `status`, `agent`, `taskId`, `tokenUsage` (optional), `notes` (optional)",
      "Per-agent Zod schemas are exported for all 14 named agents",
      "`ResultParser.parseAamfOutput(stdout, schema)` static method is exported",
      "The method extracts the last fenced aamf-json block from stdout",
      "Returns `{ data, parsed: true }` on success and `{ parsed: false, error: string }` on missing block, malformed JSON, or schema validation failure",
      "When no aamf-json block is present, the error message clearly states 'missing aamf-json block'"
    ]
  },
  {
    "id": "task-003",
    "name": "Integrate parseAamfOutput into AgentLauncher with Fallback",
    "description": "Update `AgentLauncher.launchCliMode` to call `parseAamfOutput` after execution and populate the new fields on `AgentResult`. Missing blocks fall back gracefully; present-but-invalid blocks force `success = false`.",
    "files": ["runtime/src/core/agent-launcher.ts"],
    "dependencies": ["task-001", "task-002"],
    "complexity": "moderate",
    "acceptanceCriteria": [
      "After agent execution, `parseAamfOutput` is called with stdout and the matching per-agent schema",
      "When parsing succeeds: `structuredOutput` is populated, `outputParsed` is `true`",
      "When the aamf-json block is absent: a warning is logged, `outputParsed` is `false`, and `success` is unchanged",
      "When the block is present but invalid: `outputParsed` is `false`, `parseError` is set, and `success` is forced to `false`",
      "When `structuredOutput.tokenUsage` is present it is used instead of the regex-based `parseTokenUsage` result"
    ]
  },
  {
    "id": "task-004",
    "name": "Refactor Orchestrator Phase Handlers to Use structuredOutput",
    "description": "Refactor phase 3, 4, and 5 handlers in `orchestrator.ts` to consume `AgentResult.structuredOutput` instead of file-system reads or regex-based markdown parsing, with fallback to legacy parsing when `outputParsed` is false.",
    "files": ["runtime/src/core/orchestrator.ts"],
    "dependencies": ["task-001", "task-002", "task-003"],
    "complexity": "complex",
    "acceptanceCriteria": [
      "Phase 4 migration-planner handler reads tasks from `structuredOutput` when `outputParsed` is `true`, falls back to `ResultParser.parseMigrationPlan` with a warning when not",
      "Phase 5 final-parity-checker handler reads fixes from `structuredOutput` when `outputParsed` is `true`, falls back to `ResultParser.parseFinalParityReport` with a warning when not",
      "Token recording prefers `structuredOutput.tokenUsage` over the existing `tokenUsage` field when both are available",
      "All existing integration paths continue to work when `outputParsed` is `false`",
      "TypeScript build passes with no errors"
    ]
  },
  {
    "id": "task-005",
    "name": "Update Test Helpers and Mocks",
    "description": "Update `runtime/tests/helpers/mocks.ts` to include the new `outputParsed`, `structuredOutput`, and `parseError` fields on all mock `AgentResult` objects.",
    "files": ["runtime/tests/helpers/mocks.ts"],
    "dependencies": ["task-001"],
    "complexity": "simple",
    "acceptanceCriteria": [
      "All mock `AgentResult` factory functions/objects include `outputParsed: false` as a default",
      "No TypeScript compilation errors in the helpers module",
      "Existing tests that import mocks continue to pass without modification"
    ]
  },
  {
    "id": "task-006",
    "name": "Add parseAamfOutput Tests and Schema Tests",
    "description": "Add `parseAamfOutput` test cases to `result-parser.test.ts` and create a new `aamf-output-schema.test.ts` with schema validation tests for each per-agent schema.",
    "files": ["runtime/tests/result-parser.test.ts", "runtime/tests/aamf-output-schema.test.ts"],
    "dependencies": ["task-002"],
    "complexity": "moderate",
    "acceptanceCriteria": [
      "`result-parser.test.ts` includes tests for: valid block (extracts last when multiple exist), missing block, malformed JSON block, and schema validation failure",
      "`runtime/tests/aamf-output-schema.test.ts` is created with at least one valid and one invalid case for each of the 14 per-agent schemas",
      "All new tests pass when running `npm test`"
    ]
  },
  {
    "id": "task-007",
    "name": "Update Agent Launcher and Orchestrator Unit Tests",
    "description": "Update `agent-launcher.test.ts` to exercise the new post-execution parsing path and update `orchestrator.test.ts` mock expectations and phase handler assertions to reflect the structured output flow.",
    "files": ["runtime/tests/agent-launcher.test.ts", "runtime/tests/orchestrator.test.ts"],
    "dependencies": ["task-003", "task-004", "task-005"],
    "complexity": "moderate",
    "acceptanceCriteria": [
      "`agent-launcher.test.ts` includes tests for: valid aamf-json output sets `outputParsed: true`; missing block sets `outputParsed: false` with exit-code-based success preserved; invalid block sets `outputParsed: false`, `parseError`, and `success: false`",
      "`orchestrator.test.ts` mock `AgentResult` objects include `outputParsed` and phase handler assertions reflect structured-output consumption",
      "All existing and new tests pass when running `npm test`"
    ]
  },
  {
    "id": "task-008",
    "name": "Update E2E Tests for Structured Output Flow",
    "description": "Update `e2e-smoke.test.ts` and `e2e-full-migration.test.ts` to account for the new `outputParsed` field on `AgentResult` and any changed orchestrator behaviour.",
    "files": ["runtime/tests/e2e-smoke.test.ts", "runtime/tests/e2e-full-migration.test.ts"],
    "dependencies": ["task-004", "task-005", "task-007"],
    "complexity": "moderate",
    "acceptanceCriteria": [
      "E2E smoke and full-migration tests compile without TypeScript errors",
      "Tests that assert on `AgentResult` shape include the new fields",
      "All e2e tests pass or are skipped consistent with existing skip behaviour"
    ]
  },
  {
    "id": "task-009",
    "name": "Add Output Format Sections to Agent Definition Files",
    "description": "Add an `## Output Format` section to each of the 14 agent `.agent.md` files specifying the `aamf-json` block schema, a valid output example, and a warning that non-conforming output will cause the agent run to fail.",
    "files": [
      ".github/agents/adjudicator.agent.md",
      ".github/agents/code-migrator.agent.md",
      ".github/agents/parity-verifier.agent.md",
      ".github/agents/test-writer.agent.md",
      ".github/agents/failure-recovery.agent.md",
      ".github/agents/final-parity-checker.agent.md",
      ".github/agents/e2e-test-crafter.agent.md",
      ".github/agents/documentation-writer.agent.md",
      ".github/agents/migration-runner.agent.md",
      ".github/agents/impact-assessor.agent.md",
      ".github/agents/knowledge-builder.agent.md",
      ".github/agents/large-file-analyzer.agent.md",
      ".github/agents/migration-planner.agent.md",
      ".github/agents/migration-orchestrator.agent.md"
    ],
    "dependencies": ["task-002"],
    "complexity": "moderate",
    "acceptanceCriteria": [
      "Each of the 14 agent files has an `## Output Format` section",
      "Each section includes the `aamf-json` block requirement description, JSON schema fields (base + agent-specific), a concrete valid example, and a non-conformance warning",
      "The `aamf-json` block must be described as the last fenced code block in the agent's output",
      "No existing content in any file is removed or altered"
    ]
  }
]
```
