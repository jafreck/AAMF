# AAMF — Autonomous Agent Migration Framework

[![CI](https://github.com/jafreck/AAMF/actions/workflows/ci.yml/badge.svg)](https://github.com/jafreck/AAMF/actions/workflows/ci.yml)

AAMF is a TypeScript runtime that orchestrates AI agents to migrate extremely large legacy codebases from one technology stack to another. It manages the full lifecycle — analysis, planning, code translation, verification, and documentation — by spawning out-of-process Copilot CLI invocations and coordinating them through a seven-phase pipeline with checkpointing, budgeting, and failure recovery.

Typical use cases include porting a 100k+ line Python monolith to TypeScript, a COBOL system to Go, or a Java codebase to Rust.

## Repository Layout

- `runtime/` — migration orchestration runtime, agent execution, checkpointing, KB server.
- `lore/` — extracted knowledge-base indexing project (source walking, parsing, extraction, SQLite index + embeddings).

---

## Projects Ported Using AAMF

| Project | Source | Target | Model | Repository |
|---------|--------|--------|-------|------------|
| lz4 compression library | C | Rust | claude-sonnet-4.6 | [jafreck/lz4r](https://github.com/jafreck/lz4r) |

---

## How It Works

AAMF treats the migration as a pipeline of **7 sequential phases**, each driven by purpose-built agents defined as `.agent.md` prompt files. The runtime never performs reasoning itself — it is pure execution machinery that launches agents, feeds them minimal context, collects their output, and decides what to run next.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AAMF Runtime                                 │
│                                                                     │
│  migration.config.json ──► MigrationRuntime                         │
│                               │                                     │
│                         Orchestrator                                │
│                           │     │                                   │
│            ┌──────────────┘     └──────────────┐                    │
│            ▼                                   ▼                    │
│     ContextBuilder                       AgentLauncher              │
│     (writes JSON)                     (spawns processes)            │
│            │                                   │                    │
│            │         ┌───────────┐             │                    │
│            └────────►│ context   │─────────────┘                    │
│                      │  .json    │                                  │
│                      └───────────┘                                  │
│                            │                                        │
│              ┌─────────────┼─────────────┐                          │
│              ▼             ▼             ▼                          │
│         copilot CLI   copilot CLI   copilot CLI                     │
│         (agent A)     (agent B)     (agent C)                       │
│              │             │             │                          │
│              └─────────────┼─────────────┘                          │
│                            ▼                                        │
│                      ResultParser                                   │
│                            │                                        │
│              ┌─────────────┼─────────────┐                          │
│              ▼             ▼             ▼                          │
│         Checkpoint    ProgressWriter  TokenTracker                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### The Seven Phases

| Phase | Name | Agents | Parallel | Critical |
|-------|------|--------|----------|----------|
| 1 | **Impact Assessment** | `impact-assessor` | No | Yes |
| 2 | **Knowledge Base Construction** | `knowledge-builder`, `large-file-analyzer` | Yes | Yes |
| 3 | **Migration Planning** | `migration-planner`, `adjudicator` | No | Yes |
| 4 | **Iterative Migration** | `code-migrator`, `parity-verifier`, `test-writer`, `failure-recovery` | Partial | Yes |
| 5 | **Final Parity Verification** | `final-parity-checker` | No | No |
| 6 | **E2E Testing & Documentation** | `e2e-test-crafter`, `documentation-writer` | Yes | No |
| 7 | **Completion** | *(none — summary only)* | — | No |

Critical phases abort the migration on failure. Non-critical phases (5, 6) log issues but allow the pipeline to continue.

---

## Runtime ↔ Agent Interaction Model

Every agent runs **out-of-process**. The runtime never calls an LLM directly during the pipeline — it delegates all reasoning to agent invocations.

### Invocation Lifecycle

```
1. ContextBuilder writes a minimal JSON context file
     └─ Contains file paths (not contents), config, phase/task metadata

2. AgentLauncher spawns the agent
     └─ `copilot --agent <name> --context <path> [--model <model>]`

3. Environment variables are injected:
     AAMF_PROGRESS_DIR   → .aamf/migration/{projectName}
     AAMF_CONTEXT_FILE   → path to the context JSON
     AAMF_PHASE          → current phase number
     AAMF_TASK_ID        → task identifier (Phase 4)

4. The agent reads its context, performs reasoning, writes output files

5. AgentLauncher collects:
     ├─ Exit code (0 = success)
     ├─ stdout/stderr → log file
     ├─ Output files detected in the progress directory
     └─ Token usage parsed from output

6. ResultParser structures the output for the next phase
```

### Context Window Management

Context saturation is the primary constraint when migrating large codebases. AAMF minimizes context usage through several mechanisms:

- **File paths, not contents.** Context files contain paths to source files, not their full text. Agents read only what they need.
- **Per-agent scoping.** Each agent type receives a tailored context with only the inputs relevant to its task — the impact assessor sees the source tree, the code migrator sees one task's files plus its knowledge-base entry.
- **Large file decomposition.** Files exceeding `largeFileThreshold` (default: 500 lines) are flagged during Phase 2 and documented by dedicated `large-file-analyzer` agents. Phase 3 then splits them into separate migration tasks capped at `maxLinesPerTask` lines each.
- **Single-purpose agents.** Each of the 14 agent types has a narrow responsibility, keeping its system prompt focused and its working set small.

### Execution

Agents are launched via the Copilot CLI: `copilot --agent <name> --context <path> [--model <model>]`. The CLI loads the `.agent.md` file and runs it as a child process, returning an `AgentResult` to the runtime.

---

## Agent Catalog

AAMF defines 14 specialized agent roles. Each corresponds to a `.agent.md` file in the configured `copilot.agentDir` (default: `.github/agents/`).

| Agent | Phase | Purpose |
|-------|-------|---------|
| `migration-orchestrator` | — | Top-level coordination logic (mirrored by the runtime) |
| `migration-runner` | — | Entry point agent |
| `impact-assessor` | 1 | Analyzes source codebase scope, complexity, and risk |
| `knowledge-builder` | 2 | Documents all modules, dependencies, and patterns |
| `large-file-analyzer` | 2 | Deep-dives on files too large to migrate as a single unit |
| `migration-planner` | 3 | Creates the task-level migration plan with dependency ordering |
| `adjudicator` | 3 | Decides between competing migration strategies |
| `code-migrator` | 4 | Translates source code to the target language/framework |
| `parity-verifier` | 4 | Checks behavioral equivalence between source and migrated code |
| `test-writer` | 4 | Generates unit tests for migrated code |
| `failure-recovery` | 4 | Diagnoses and fixes migration failures after retries are exhausted |
| `final-parity-checker` | 5 | Full-codebase parity sweep with loop-back fix capability |
| `e2e-test-crafter` | 6 | Creates end-to-end integration tests |
| `documentation-writer` | 6 | Produces migration documentation and guides |

---

## Execution Details by Phase

### Phase 1 — Impact Assessment

A single `impact-assessor` invocation scans the source tree and produces `impact-assessment.md`: scope, file count, complexity ratings, risk areas, and estimated effort.

### Phase 2 — Knowledge Base Construction

The `knowledge-builder` agent documents all modules, producing a structured knowledge base under `.aamf/migration/{project}/knowledge-base/`. Files exceeding the large-file threshold are then analyzed in **parallel** by multiple `large-file-analyzer` instances (up to `maxParallelAgents` concurrent).

### Phase 3 — Migration Planning

Phase 3 is a two-step flow:

1. `migration-planner` (Step 3a) reads the knowledge base + impact assessment and writes planning artifacts under `.aamf/migration/{project}/planning/` (notably `groups.json` and `strategy.md`).
2. Runtime (Step 3b) launches `task-decomposer` in parallel per module group and merges outputs into `planning/tasks-merged.json`.

Adjudication trigger contract:
- If the planner identifies multiple viable strategies, it **must** write `.aamf/migration/{project}/competing-strategies.md`.
- Runtime checks for that file and, when present, spawns `adjudicator` before task decomposition.

### Phase 4 — Iterative Migration

This is the core phase. The runtime:

1. Parses `migration-plan.md` into structured `MigrationTask` objects
2. Topologically sorts tasks by dependency
3. Processes tasks serially through a dependency-aware `TaskQueue`
4. For each task:
   - Spawns `code-migrator` with retry (up to `maxRetriesPerTask` attempts)
   - On exhaustion, escalates to `failure-recovery` for diagnosis and scope reduction
   - On success, spawns `parity-verifier` and `test-writer` **in parallel**
   - Updates checkpoint after each task completion
5. Tasks that fail all retries and recovery are marked **blocked** — the pipeline continues with remaining tasks

### Phase 5 — Final Parity Verification

The `final-parity-checker` performs a codebase-wide parity sweep. If issues are found, the runtime **loops back** — spawning `code-migrator` to fix each issue — up to 2 iterations before proceeding.

### Phase 6 — E2E Testing & Documentation

`e2e-test-crafter` and `documentation-writer` run **in parallel**. Neither is critical; failures are logged but do not abort the migration.

### Phase 7 — Completion

The runtime writes a final summary to the progress file and returns a `MigrationResult` with per-phase outcomes, token usage, and lists of failed/blocked tasks.

---

## Resilience

### Checkpointing & Resume

All state is persisted to `.aamf/migration/{projectName}/checkpoint.json` after every phase completion and task completion. The checkpoint records:

- Current phase and task
- Completed phases and tasks
- Failed/blocked tasks with error details
- Phase output file paths
- Cumulative token usage (by phase and by agent)

To resume an interrupted migration:

```bash
npx aamf migrate -c migration.config.json --resume
```

The orchestrator skips completed phases and resumes the task queue from where it left off. A backup checkpoint (`checkpoint.backup.json`) is maintained for corruption recovery.

### Retry & Failure Recovery

Failed agent invocations are retried up to `maxRetriesPerTask` times (default: 3). When all retries are exhausted, the `failure-recovery` agent is invoked to:

1. Diagnose the root cause
2. Propose a fix or reduced scope
3. Attempt recovery

If recovery succeeds, the original task is retried once more. If it still fails, the task is marked **blocked** and the pipeline continues.

Retry/recovery loops also track normalized failure signatures. `maxRepeatedFailureSignatures` (default: `2`) limits repeated identical failures per loop; when exceeded, the runtime stops that loop early instead of burning retries on equivalent failures.

When repeated-signature early-stop triggers, telemetry includes signature hash, repeat count, and stop reason in `migration.log` (`repeated-failure-detected` events) and in observability artifacts (`reports/observability/index.md`, `reports/observability/metrics.json`).

### Graceful Shutdown

On `SIGINT` or `SIGTERM`, the runtime saves the current checkpoint and writes an event to the progress file before exiting. The migration can be resumed from this point.

---

## Token Budget Management

An optional `tokenBudget` cap can be set in the config. The `TokenTracker` records usage after every agent invocation and checks thresholds:

| Threshold | Action |
|-----------|--------|
| < 80% | Continue normally |
| 80–100% | Log a warning |
| > 100% | Pause the migration (can be resumed later) |

The `CostEstimator` provides approximate USD cost estimates using per-model pricing tables (GPT-4o, Claude Sonnet, Claude Opus, etc.).

---

## Artifact Retention

By default, AAMF removes the `.aamf` checkpoint directory and the target output directory after a migration completes. To keep these artifacts for debugging or inspection:

- **Config:** set `"keepArtifacts": true` in `options`.
- **Environment variable:** set `AAMF_KEEP_ARTIFACTS=1` (takes precedence over config).

```bash
# Keep artifacts via env var
AAMF_KEEP_ARTIFACTS=1 npx aamf migrate -c migration.config.json
```

See [runtime/README.md](runtime/README.md#artifact-retention) for full details on which directories are affected and precedence rules.

---

## Progress Observability

All migration state is observable in `.aamf/migration/{projectName}/`:

```
.aamf/migration/{projectName}/
├── checkpoint.json              # Full pipeline state
├── checkpoint.backup.json       # Previous checkpoint
├── progress.md                  # Human-readable status dashboard
├── impact-assessment.md         # Phase 1 output
├── migration-plan.md            # Phase 3 output
├── final-parity-report.md       # Phase 5 output
├── knowledge-base/              # Phase 2 outputs
│   ├── module-docs/
│   └── large-files/
├── contexts/                    # Context JSON files per invocation
└── logs/                        # Per-agent stdout/stderr logs
    ├── impact-assessor-main-2026-02-21T10-30-00.log
    ├── code-migrator-task-001-2026-02-21T11-00-00.log
    └── ...
```

The `progress.md` file is updated in real-time with a phase table, task-level progress, token usage, and a timestamped event log.
The observability report also includes a repeated-signature stop summary with per-reason counts.

---

## Getting Started

### Prerequisites

- **Node.js 22+**
- A Copilot CLI installation (`copilot --agent` and `--model` support required)
- Agent definition files (`.agent.md`) in the configured agent directory

### Installation

```bash
cd runtime
npm install
npm run build
```

### Configuration

Create a `migration.config.json` in your project root:

```json
{
  "projectName": "legacy-to-ts",
  "source": {
    "path": "./legacy-app",
    "language": "python",
    "entryPoints": ["main.py"],
    "excludePatterns": ["__pycache__", ".git", "venv"]
  },
  "target": {
    "language": "typescript",
    "framework": "express",
    "outputPath": "./migrated",
    "testFramework": "vitest",
    "buildCommand": "npm run build",
    "testCommand": "npm test"
  },
  "options": {
    "maxParallelAgents": 3,
    "maxRetriesPerTask": 3,
    "maxRepeatedFailureSignatures": 2,
    "largeFileThreshold": 500,
    "maxLinesPerTask": 500,
    "tokenBudget": 2000000
  },
  "copilot": {
    "cliCommand": "copilot",
    "model": "gpt-4o",
    "agentDir": ".github/agents",
    "timeout": 300000
  }
}
```

### Usage

```bash
# Run a full migration
npx aamf migrate -c migration.config.json

# Dry run (validate config, no migration)
npx aamf migrate -c migration.config.json --dry-run

# Resume from last checkpoint
npx aamf migrate -c migration.config.json --resume

# Run a single phase
npx aamf migrate -c migration.config.json --phase 4

# Check migration status
npx aamf status -c migration.config.json

# Reset migration state
npx aamf reset -c migration.config.json

# Reset from a specific phase onward
npx aamf reset -c migration.config.json --phase 3
```

---

## Project Structure

```
runtime/
├── src/
│   ├── index.ts                     # CLI entry point (commander)
│   ├── config/
│   │   ├── schema.ts                # Zod schema for migration.config.json
│   │   └── loader.ts                # Config loader, validator, path resolver
│   ├── core/
│   │   ├── runtime.ts               # Top-level MigrationRuntime class
│   │   ├── orchestrator.ts          # 7-phase sequencer with per-phase logic
│   │   ├── agent-launcher.ts        # Spawns agents via Copilot CLI
│   │   ├── checkpoint.ts            # Checkpoint persistence and resume
│   │   ├── progress.ts              # progress.md writer
│   │   └── phase-registry.ts        # Phase definitions and ordering
│   ├── agents/
│   │   ├── types.ts                 # AgentName, AgentInvocation, AgentResult, etc.
│   │   ├── context-builder.ts       # Writes per-agent context JSON files
│   │   └── result-parser.ts         # Parses migration plans and parity reports
│   ├── execution/
│   │   ├── parallel-executor.ts     # p-limit based concurrent agent runner
│   │   ├── serial-executor.ts       # Sequential agent runner
│   │   ├── task-queue.ts            # Dependency-aware queue with topo sort
│   │   └── retry.ts                 # Retry with failure-recovery escalation
│   ├── budget/
│   │   ├── token-tracker.ts         # Per-agent/phase token accounting
│   │   └── cost-estimator.ts        # USD cost estimation by model
│   ├── logging/
│   │   ├── logger.ts                # Structured logger (console + file)
│   │   └── events.ts                # Typed event definitions
│   └── util/
│       ├── fs.ts                    # Atomic writes, ensureDir, JSON helpers
│       └── process.ts               # Child process spawn with timeout + tree kill
└── tests/
    ├── orchestrator.test.ts
    ├── agent-launcher.test.ts
    ├── checkpoint.test.ts
    ├── config-schema.test.ts
    ├── result-parser.test.ts
    ├── task-queue.test.ts
    ├── token-tracker.test.ts
    └── fixtures/
        ├── sample-config.json
        ├── sample-checkpoint.json
        └── sample-migration-plan.md
```

---

## Coverage

Run coverage locally from the `runtime/` directory:

```bash
npx vitest run --coverage
```

Coverage thresholds are enforced at **90%** for lines, branches, functions, and statements. These thresholds apply globally (not per-file). The CI workflow runs tests with coverage enabled and will fail if any threshold is not met.

---

## License

MIT — see [LICENSE](LICENSE) for details.
