# Task: task-003 - Integrate parseAamfOutput into AgentLauncher with Fallback

**Description:** Update `AgentLauncher.launchCliMode` to call `parseAamfOutput` after execution and populate the new fields on `AgentResult`. Missing blocks fall back gracefully; present-but-invalid blocks force `success = false`.
**Files:** runtime/src/core/agent-launcher.ts
**Dependencies:** task-001, task-002
**Complexity:** moderate
**Acceptance Criteria:**
- After agent execution, `parseAamfOutput` is called with stdout and the matching per-agent schema
- When parsing succeeds: `structuredOutput` is populated, `outputParsed` is `true`
- When the aamf-json block is absent: a warning is logged, `outputParsed` is `false`, and `success` is unchanged
- When the block is present but invalid: `outputParsed` is `false`, `parseError` is set, and `success` is forced to `false`
- When `structuredOutput.tokenUsage` is present it is used instead of the regex-based `parseTokenUsage` result