# AAMF — Agent Architecture for Migration Framework

A framework of 14 single-purpose Copilot agents designed for migrating extremely large legacy codebases (100k+ lines). Every agent runs as a headless, out-of-process CLI invocation of the same model. Context window saturation is minimized at every level.

## Agent Inventory

| # | Agent | File | Purpose | Leaf? |
|---|-------|------|---------|-------|
| 1 | Migration Runner | `migration-runner.prompt.md` | Top-level entry point, launches orchestrator | — |
| 2 | Migration Orchestrator | `migration-orchestrator.prompt.md` | Phase coordination, checkpointing, resume | — |
| 3 | Impact Assessor | `impact-assessor.prompt.md` | Codebase analysis, cost/effort estimation | ✅ |
| 4 | Knowledge Builder | `knowledge-builder.prompt.md` | Investigates codebase, builds knowledge base | — |
| 5 | Large File Analyzer | `large-file-analyzer.prompt.md` | Decomposes large files for piecemeal migration | ✅ |
| 6 | Migration Planner | `migration-planner.prompt.md` | Creates ordered migration task breakdown | — |
| 7 | Adjudicator | `adjudicator.prompt.md` | Decides between competing plans/solutions | ✅ |
| 8 | Code Migrator | `code-migrator.prompt.md` | Writes migrated code for a single task | — |
| 9 | Parity Verifier | `parity-verifier.prompt.md` | Verifies behavioral equivalence source↔target | ✅ |
| 10 | Test Writer | `test-writer.prompt.md` | Writes unit tests for migrated code | ✅ |
| 11 | Final Parity Checker | `final-parity-checker.prompt.md` | Post-migration completeness audit | ✅ |
| 12 | E2E Test Crafter | `e2e-test-crafter.agent.md` | Plans E2E test suites, delegates writing to test-writer | — |
| 13 | Documentation Writer | `documentation-writer.prompt.md` | Documents the migrated codebase | ✅ |
| 14 | Failure Adjudicator | `failure-adjudicator.agent.md` | Diagnoses failures, plans fixes, reduces scope | — |

## Agent Hierarchy

```
migration-runner
└── migration-orchestrator
    ├── impact-assessor ◆
    ├── knowledge-builder
    │   └── large-file-analyzer ◆
    ├── migration-planner
    │   └── adjudicator ◆
    ├── code-migrator
    │   ├── parity-verifier ◆
    │   ├── test-writer ◆
    │   └── failure-adjudicator
    │       ├── adjudicator ◆
    │       └── migration-planner (re-plan)
    ├── final-parity-checker ◆
    ├── e2e-test-crafter
    │   └── test-writer ◆
    └── documentation-writer ◆

◆ = leaf agent (no sub-agents)
```

## Migration Phases

```
Phase 1: Impact Assessment ──→ impact-assessor
Phase 2: Knowledge Base    ──→ knowledge-builder + large-file-analyzer
Phase 3: Planning          ──→ migration-planner + adjudicator
Phase 4: Code Migration    ──→ code-migrator ↔ parity-verifier ↔ test-writer ↔ failure-adjudicator (loop)
Phase 5: Final Parity      ──→ final-parity-checker (may loop back to Phase 4)
Phase 6: E2E Tests         ──→ e2e-test-crafter
Phase 7: Documentation     ──→ documentation-writer
```

## Progress Tracking

All progress is tracked in `.aamf/migration/{projectName}/`:

```
.aamf/migration/{projectName}/
├── progress.md                  # Live status dashboard
├── checkpoints.json             # Resume state for orchestrator
├── impact-assessment.md         # Phase 1 output
├── knowledge-base/              # Phase 2 output
│   ├── index.md
│   ├── architecture.md
│   ├── patterns.md
│   ├── data-models.md
│   ├── integrations.md
│   ├── modules/{name}.md
│   └── large-files/{name}.analysis.md
├── migration-plan.md            # Phase 3 output
├── parity-reports/              # Phase 4 per-task reports
│   └── task-{id}.md
├── final-parity-report.md       # Phase 5 output
├── e2e-test-plan.md             # Phase 6 plan
└── documentation/               # Phase 7 output
    ├── architecture-guide.md
    ├── api-reference.md
    ├── migration-summary.md
    ├── developer-guide.md
    ├── known-issues.md
    └── decision-log.md
```

## Key Design Principles

1. **Out-of-Process Execution**: Every agent is invoked as a headless CLI process — never as an in-process sub-agent.
2. **Context Window Discipline**: Agents read only what they need. The knowledge base serves as a compact substitute for source code.
3. **Checkpoint & Resume**: The orchestrator checkpoints after every phase/task. Migrations are resumable from any failure point.
4. **Parallelizable Read-Only Agents**: Impact assessor, knowledge builder, large file analyzer, parity verifier, and final parity checker can run concurrently.
5. **Serial Code Writing**: Code migrator and test writer run serially to avoid conflicts.
6. **Adjudicated Decisions**: Key decisions go through the adjudicator, which evaluates competing proposals.
7. **Failure Adjudication Loop**: Failures trigger diagnosis → competing fix strategies → adjudication → fix attempt → re-verify, with scope reduction as a valid strategy.
