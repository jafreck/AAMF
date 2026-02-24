# Task: task-009 - Add Output Format Sections to Agent Definition Files

**Description:** Add an `## Output Format` section to each of the 14 agent `.agent.md` files specifying the `aamf-json` block schema, a valid output example, and a warning that non-conforming output will cause the agent run to fail.
**Files:** .github/agents/adjudicator.agent.md, .github/agents/code-migrator.agent.md, .github/agents/parity-verifier.agent.md, .github/agents/test-writer.agent.md, .github/agents/failure-recovery.agent.md, .github/agents/final-parity-checker.agent.md, .github/agents/e2e-test-crafter.agent.md, .github/agents/documentation-writer.agent.md, .github/agents/migration-runner.agent.md, .github/agents/impact-assessor.agent.md, .github/agents/knowledge-builder.agent.md, .github/agents/large-file-analyzer.agent.md, .github/agents/migration-planner.agent.md, .github/agents/migration-orchestrator.agent.md
**Dependencies:** task-002
**Complexity:** moderate
**Acceptance Criteria:**
- Each of the 14 agent files has an `## Output Format` section
- Each section includes the `aamf-json` block requirement description, JSON schema fields (base + agent-specific), a concrete valid example, and a non-conformance warning
- The `aamf-json` block must be described as the last fenced code block in the agent's output
- No existing content in any file is removed or altered