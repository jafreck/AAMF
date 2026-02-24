## Requirements

1. Add a `parseAamfOutput(stdout, schema)` static method to `ResultParser` that extracts the **last** `aamf-json` fenced block from stdout, parses the JSON, and validates it against a provided Zod schema.
2. Define a common `AamfOutputBase` Zod schema (fields: `status`, `agent`, `taskId`, `tokenUsage`, `notes`) and per-agent schemas extending it for all 14 agents listed in the issue.
3. Extend the `AgentResult` interface in `agents/types.ts` with three new fields: `structuredOutput?: Record<string, unknown>`, `outputParsed: boolean`, and `parseError?: string`.
4. Update `AgentLauncher` to call `parseAamfOutput` after execution and set `AgentResult.success = false` (with `parseError`) when the block is missing, malformed, or schema-invalid — regardless of exit code.
5. Attach the parsed structured data to `AgentResult.structuredOutput` when parsing succeeds.
6. Refactor `Orchestrator` phase handlers (phases 3, 4, 5) to consume `AgentResult.structuredOutput` instead of file-system reads or regex-based markdown parsing.
7. Replace token usage scraping from stdout with extraction from `structuredOutput.tokenUsage`.
8. Update all 14 agent definition files in `.github/agents/` to include an `## Output Format` section specifying the `aamf-json` block schema, a valid output example, and a warning that non-conforming output will be rejected.
9. Add tests for `parseAamfOutput` in `result-parser.test.ts` covering valid blocks, missing blocks, malformed JSON, and schema violations.
10. Add a new `aamf-output-schema.test.ts` file with schema validation tests for each agent type.
11. Update existing orchestrator and e2e tests to expect the new structured output flow.
12. During the transition period, the runtime must gracefully fall back to legacy parsing with a logged warning when the `aamf-json` block is absent (backward compatibility).

## Change Type

feature

## Scope Estimate

large

## Affected Areas

- `runtime/src/agents/types.ts` — extend `AgentResult`; add Zod schemas per agent
- `runtime/src/agents/result-parser.ts` — add `parseAamfOutput()` and schema registry
- `runtime/src/core/agent-launcher.ts` — integrate post-execution structured output parsing
- `runtime/src/core/orchestrator.ts` — refactor phase handlers to use `structuredOutput`
- `.github/agents/*.agent.md` — all 14+ agent definition files need `## Output Format` sections
- `runtime/tests/result-parser.test.ts` — new tests for `parseAamfOutput`
- `runtime/tests/aamf-output-schema.test.ts` — new file for per-agent schema tests
- `runtime/tests/orchestrator.test.ts` — update to expect structured output
- `runtime/tests/e2e-*.test.ts` — update e2e tests as needed

## Ambiguities

- The issue table lists 14 agents but the `.github/agents/` directory contains 24 `.agent.md` files; it is unclear which 10 additional agents (e.g., `code-reviewer`, `code-writer`, `codebase-scout`, `conflict-resolver`, `fix-surgeon`, `implementation-planner`, `integration-checker`, `issue-analyst`, `pr-composer`, `migration-runner`) require `aamf-json` output and what their schemas should be.
- The issue simultaneously requires failing agents with missing `aamf-json` output AND supporting backward-compatible fallback to legacy parsing — the exact condition that triggers failure vs. fallback is not precisely defined.
- It is unclear whether the transition/backward-compatibility period is time-bounded or feature-flagged, and how it will be removed once all agents are updated.
- The `structuredOutput` field is typed as `Record<string, unknown>` but could benefit from generics — no decision is made in the issue on the final typing strategy.

```cadre-json
{
  "requirements": [
    "Add a parseAamfOutput(stdout, schema) static method to ResultParser that extracts the last aamf-json fenced block from stdout, parses the JSON, and validates it against a provided Zod schema",
    "Define a common AamfOutputBase Zod schema and per-agent schemas extending it for all 14 agents listed in the issue",
    "Extend AgentResult interface in agents/types.ts with structuredOutput, outputParsed, and parseError fields",
    "Update AgentLauncher to call parseAamfOutput after execution and set AgentResult.success = false when the block is missing, malformed, or schema-invalid regardless of exit code",
    "Attach the parsed structured data to AgentResult.structuredOutput when parsing succeeds",
    "Refactor Orchestrator phase handlers (phases 3, 4, 5) to consume AgentResult.structuredOutput instead of file-system reads or regex-based markdown parsing",
    "Replace token usage scraping from stdout with extraction from structuredOutput.tokenUsage",
    "Update all 14 agent definition files in .github/agents/ to include an Output Format section specifying the aamf-json block schema, a valid example, and a non-conformance warning",
    "Add tests for parseAamfOutput in result-parser.test.ts covering valid blocks, missing blocks, malformed JSON, and schema violations",
    "Add a new aamf-output-schema.test.ts file with schema validation tests for each agent type",
    "Update existing orchestrator and e2e tests to expect the new structured output flow",
    "During the transition period the runtime must gracefully fall back to legacy parsing with a logged warning when the aamf-json block is absent"
  ],
  "changeType": "feature",
  "scope": "large",
  "affectedAreas": [
    "runtime/src/agents/types.ts",
    "runtime/src/agents/result-parser.ts",
    "runtime/src/core/agent-launcher.ts",
    "runtime/src/core/orchestrator.ts",
    ".github/agents/",
    "runtime/tests/result-parser.test.ts",
    "runtime/tests/aamf-output-schema.test.ts",
    "runtime/tests/orchestrator.test.ts",
    "runtime/tests/e2e-*.test.ts"
  ],
  "ambiguities": [
    "The issue table lists 14 agents but the .github/agents/ directory contains 24 files; it is unclear which additional agents require aamf-json output and what their schemas should be",
    "The issue simultaneously requires failing agents with missing aamf-json output AND supporting backward-compatible fallback to legacy parsing — the exact condition triggering failure vs. fallback is not precisely defined",
    "It is unclear whether the transition/backward-compatibility period is time-bounded or feature-flagged and how it will be removed",
    "The structuredOutput field typing strategy (generic vs Record<string, unknown>) is not decided in the issue"
  ]
}
```
