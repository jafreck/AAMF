# Task: task-002 - Add AamfOutputBase Schema and parseAamfOutput to ResultParser

**Description:** Define a common `AamfOutputBase` Zod schema and per-agent schemas extending it, then add a `parseAamfOutput(stdout, schema)` static method to `ResultParser` that extracts the last `aamf-json` fenced block and validates it against the provided schema.
**Files:** runtime/src/agents/result-parser.ts
**Dependencies:** task-001
**Complexity:** complex
**Acceptance Criteria:**
- `AamfOutputBase` Zod schema is exported with fields: `status`, `agent`, `taskId`, `tokenUsage` (optional), `notes` (optional)
- Per-agent Zod schemas are exported for all 14 named agents
- `ResultParser.parseAamfOutput(stdout, schema)` static method is exported
- The method extracts the last fenced aamf-json block from stdout
- Returns `{ data, parsed: true }` on success and `{ parsed: false, error: string }` on missing block, malformed JSON, or schema validation failure
- When no aamf-json block is present, the error message clearly states 'missing aamf-json block'