# Task Result: task-009 - Add Output Format Sections to Agent Definition Files

## Changes Made
- `.github/agents/adjudicator.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `selectedOption`, `rationale`, `tradeoffs`, `risks`), concrete example, and non-conformance warning
- `.github/agents/code-migrator.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `taskId`, `parity`, `issues`, `metrics`), concrete example, and non-conformance warning
- `.github/agents/parity-verifier.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `taskId`, `parity`, `issues`), concrete example, and non-conformance warning
- `.github/agents/test-writer.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `testsWritten`, `testsPassed`, `testsFailed`), concrete example, and non-conformance warning
- `.github/agents/failure-recovery.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `taskId`, `failureType`, `strategyApplied`, `attempts`, `scopeReduced`), concrete example, and non-conformance warning
- `.github/agents/final-parity-checker.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `missingFiles`, `stubsFound`, `buildPassed`, `testsPassed`, `testsFailed`), concrete example, and non-conformance warning
- `.github/agents/e2e-test-crafter.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `suitesPlanned`, `suitesCompleted`, `scenariosTotal`, `scenariosPassing`, `scenariosFailing`), concrete example, and non-conformance warning
- `.github/agents/documentation-writer.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `documentsWritten`), concrete example, and non-conformance warning
- `.github/agents/migration-runner.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `projectName`, `orchestratorLaunched`), concrete example, and non-conformance warning
- `.github/agents/impact-assessor.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `totalFiles`, `totalLoc`, `riskCount`), concrete example, and non-conformance warning
- `.github/agents/knowledge-builder.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `modulesDocumented`, `largeFilesAnalyzed`), concrete example, and non-conformance warning
- `.github/agents/large-file-analyzer.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `linesOfCode`, `topLevelDeclarations`, `chunksRecommended`), concrete example, and non-conformance warning
- `.github/agents/migration-planner.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `totalTasks`, `simpleCount`, `moderateCount`, `complexCount`), concrete example, and non-conformance warning
- `.github/agents/migration-orchestrator.agent.md`: Added `## Output Format` section with `aamf-json` schema (base + `currentPhase`, `completedTasks`, `failedTasks`, `overallStatus`), concrete example, and non-conformance warning

## Files Modified
- .github/agents/adjudicator.agent.md
- .github/agents/code-migrator.agent.md
- .github/agents/parity-verifier.agent.md
- .github/agents/test-writer.agent.md
- .github/agents/failure-recovery.agent.md
- .github/agents/final-parity-checker.agent.md
- .github/agents/e2e-test-crafter.agent.md
- .github/agents/documentation-writer.agent.md
- .github/agents/migration-runner.agent.md
- .github/agents/impact-assessor.agent.md
- .github/agents/knowledge-builder.agent.md
- .github/agents/large-file-analyzer.agent.md
- .github/agents/migration-planner.agent.md
- .github/agents/migration-orchestrator.agent.md

## Files Created
- (none)

## Notes
- Base schema fields shared across all agents: `agent`, `status`, `outputFiles`, `notes`
- Each agent has additional agent-specific fields reflecting its unique outputs and concerns
- The `aamf-json` example block is always the last fenced code block in each file, followed only by the non-conformance warning blockquote
- No existing content was removed or altered in any file — sections were appended at the end of each file
