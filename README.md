# AAMF — Autonomous Agent Migration Framework

[![CI](https://github.com/jafreck/AAMF/actions/workflows/ci.yml/badge.svg)](https://github.com/jafreck/AAMF/actions/workflows/ci.yml)

AAMF is a TypeScript runtime that orchestrates AI agents to migrate extremely large legacy codebases from one technology stack to another. It manages the full lifecycle — analysis, planning, code translation, verification, and documentation — by spawning out-of-process agent invocations (Copilot CLI or Claude Code) and coordinating them through a multi-phase pipeline with checkpointing, budgeting, observability, and failure adjudication.

Typical use cases include porting a 100k+ line Python monolith to TypeScript, a COBOL system to Go, or a C library to Rust.

## Repository Layout

- `src/` — migration orchestration runtime, agent execution, checkpointing, observability, KB MCP server.
- `tests/` — unit, integration, and end-to-end tests mirroring the `src/` layout.
- `agents/` — Markdown prompt templates for each agent role.
- `docs/` — configuration reference and additional documentation.
- `@jafreck/lore` (npm package) — extracted knowledge-base indexing library (source walking, tree-sitter parsing, SQLite index, embeddings, MCP server) consumed by the runtime as `@jafreck/lore`.

---

## Projects Ported Using AAMF

| Project | Source | Target | Model | Repository |
|---------|--------|--------|-------|------------|
| lz4 compression library | C | Rust | claude-sonnet-4.6 | [jafreck/lz4r](https://github.com/jafreck/lz4r) |

---

## How It Works

AAMF treats the migration as a pipeline of **up to 9 phases** (7 standard + 2 optional), each driven by purpose-built agents defined as `.agent.md` prompt files. The runtime never performs reasoning itself — it is pure execution machinery that launches agents, feeds them minimal context, collects their output, and decides what to run next.

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
│         Agent CLI     Agent CLI     Agent CLI                       │
│         (agent A)     (agent B)     (agent C)                       │
│              │             │             │                          │
│              └─────────────┼─────────────┘                          │
│                            ▼                                        │
│                      ResultParser                                   │
│                            │                                        │
│              ┌─────────────┼─────────────┐                          │
│              ▼             ▼             ▼                          │
│         Checkpoint    ProgressWriter  TokenTracker                  │
│              │                            │                         │
│              ▼                            ▼                         │
│         MetricsCollector          ReportGenerator                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### The Pipeline Phases

| Phase | Name | Agents | Optional | Critical |
|-------|------|--------|----------|----------|
| 0 | **KB Indexing** | *(runtime logic — Lore)* | Yes | Yes |
| 1 | **Impact Assessment** | `impact-assessor` | No | Yes |
| 2 | **Knowledge Base Construction** | `knowledge-builder` | No | Yes |
| 3 | **Migration Planning** | `migration-planner`, `task-decomposer`, `adjudicator` | No | Yes |
| 4 | **Iterative Migration** | `code-migrator`, `parity-verifier`, `test-writer`, `failure-adjudicator` | No | Yes |
| 5 | **Final Parity Verification** | `final-parity-checker` | No | No |
| 6 | **E2E Testing & Documentation** | `e2e-test-crafter`, `documentation-writer` | No | No |
| 8 | **Idiomatic Refactor** | `idiomatic-reviewer`, `idiomatic-refactorer` | Yes | No |
| 7 | **Completion** | *(none — summary only)* | No | No |

> Phase 0 requires `options.kbIndex.enabled` (or `AAMF_USE_KB_INDEX=1`). Phase 8 requires `options.idiomaticRefactor.enabled`. Execution order is 0→1→2→3→4→5→6→8→7. Critical phases abort the migration on failure. Non-critical phases log issues but allow the pipeline to continue.

---

## Runtime ↔ Agent Interaction Model

Every agent runs **out-of-process**. The runtime never calls an LLM directly during the pipeline — it delegates all reasoning to agent invocations.

### Dual Runtime Support

AAMF supports two agent runtimes, selected by `agentRuntime` in the config:

| Runtime | CLI Command | Agent Directory | MCP Config Flag |
|---------|-------------|-----------------|-----------------|
| **Copilot** (default) | `copilot --agent <name>` | `.github/agents/` | `--additional-mcp-config` |
| **Claude Code** | `claude --agent <name>` | `.claude/agents/` | `--mcp-config` |

Both runtimes follow the same lifecycle. The `AgentLauncher` delegates to either `CopilotRunner` or `ClaudeCodeRunner`.

### Invocation Lifecycle

```
1. ContextBuilder writes a minimal JSON context file
     └─ Contains file paths (not contents), config, phase/task metadata
     └─ Phase 3 context includes ExecutionStrategy for planner awareness

2. AgentLauncher spawns the agent
     └─ <cli> --agent <name> -p <prompt> [--model <model>]
     └─ MCP config injected for KB server access when available
     └─ VS Code environment variables stripped from child process

3. Environment variables are injected:
     AAMF_PROGRESS_DIR   → .aamf/migration/{projectName}
     AAMF_CONTEXT_FILE   → path to the context JSON
     AAMF_PHASE          → current phase number
     AAMF_TASK_ID        → task identifier (Phase 4)

4. The agent reads its context, performs reasoning, writes output files
     └─ stdout/stderr streamed live to .live.log files
     └─ 30s heartbeat logs agent activity
     └─ 10s output directory polling detects new files

5. AgentLauncher collects:
     ├─ Exit code (0 = success)
     ├─ stdout/stderr → log file
     ├─ Output files detected in the progress directory
     ├─ Token usage parsed from output (including cached tokens and premium requests)
     └─ Timing metrics (spawn-to-first-output, queue delay)

6. ResultParser structures the output for the next phase
     └─ Metrics recorded to JSONL observability log
```

### Context Window Management

Context saturation is the primary constraint when migrating large codebases. AAMF minimizes context usage through several mechanisms:

- **File paths, not contents.** Context files contain paths to source files, not their full text. Agents read only what they need.
- **Per-agent scoping.** Each agent type receives a tailored context with only the inputs relevant to its task — the impact assessor sees the source tree, the code migrator sees one task's files plus its knowledge-base entry.
- **Single-purpose agents.** Each of the 16 agent types has a narrow responsibility, keeping its system prompt focused and its working set small.

### Knowledge Base Access via MCP

When Phase 0 (KB Indexing) is enabled, the runtime builds a SQLite knowledge-base index from source code using `@jafreck/lore`. After indexing, it starts an in-process HTTP MCP server (`KbServerProcess`) on a random local port. The MCP server exposes the knowledge base for agent queries via the Model Context Protocol.

Agent invocations receive the server's URL through MCP config injection, giving every agent efficient access to the indexed codebase (file content, symbols, dependencies, and optional semantic/embedding search) without saturating its context window.

---

## Agent Catalog

AAMF defines 16 specialized agent roles. Each corresponds to a `.agent.md` file in the configured agent directory (`.github/agents/` for Copilot, `.claude/agents/` for Claude Code).

| Agent | Phase | Purpose |
|-------|-------|---------|
| `migration-orchestrator` | — | Top-level coordination logic (mirrored by the runtime) |
| `migration-runner` | — | Entry point agent |
| `impact-assessor` | 1 | Analyzes source codebase scope, complexity, and risk |
| `knowledge-builder` | 2 | Documents all modules, dependencies, and patterns |
| `migration-planner` | 3 | Creates the task-level migration plan with dependency ordering |
| `task-decomposer` | 3 | Decomposes module groups into granular migration tasks |
| `adjudicator` | 3 | Decides between competing migration strategies |
| `code-migrator` | 4 | Translates source code to the target language/framework |
| `parity-verifier` | 4 | Checks behavioral equivalence between source and migrated code |
| `test-writer` | 4 | Generates unit tests for migrated code |
| `failure-adjudicator` | 4 | Decides whether exhausted retries are fixed, false positives, real gaps, or inconclusive |
| `final-parity-checker` | 5 | Full-codebase parity sweep with loop-back fix capability |
| `e2e-test-crafter` | 6 | Creates end-to-end integration tests |
| `documentation-writer` | 6 | Produces migration documentation and guides |
| `idiomatic-reviewer` | 8 | Reviews migrated code for target-language idiom violations |
| `idiomatic-refactorer` | 8 | Refactors flagged non-idiomatic code patterns |

---

## Execution Details by Phase

### Phase 0 — KB Indexing (Optional)

When `options.kbIndex.enabled` is set (or `AAMF_USE_KB_INDEX=1`), the runtime uses `@jafreck/lore` to build a SQLite knowledge-base index from the source codebase. This phase:

1. Computes a source fingerprint and skips rebuilding if the hash matches a previous run.
2. Walks the source tree with tree-sitter parsing (C, C++, C#, Go, Java, JavaScript, Python, Rust, TypeScript).
3. Optionally initializes embeddings (requires Python + sentence-transformers) when `kbIndex.embeddings.enabled` is set.
4. Starts an HTTP MCP server on a random local port, making the KB queryable by all downstream agents.

The MCP server runs for the lifetime of the migration and is shut down in a `finally` block.

### Phase 1 — Impact Assessment

A single `impact-assessor` invocation scans the source tree and produces `impact-assessment.md`: scope, file count, complexity ratings, risk areas, and estimated effort.

### Phase 2 — Knowledge Base Construction

The `knowledge-builder` agent documents all modules, producing a structured knowledge base under `.aamf/migration/{project}/knowledge-base/`.

### Phase 3 — Migration Planning

Phase 3 is a multi-step flow:

1. **Step 3a:** `migration-planner` reads the knowledge base + impact assessment and writes planning artifacts under `artifacts/planning/` (notably `groups.json` and `strategy.md`). The planner's context includes the `ExecutionStrategy` so it can produce dependency-safe module groups compatible with the configured execution mode.
2. **Adjudication:** If the planner writes `competing-strategies.md`, the runtime spawns `adjudicator` to select the best strategy.
3. **Step 3b:** `task-decomposer` is launched in parallel per module group (via `ParallelExecutor` + `RetryExecutor`). Outputs are validated against a Zod schema and merged into `artifacts/planning/tasks-merged.json`.

### Phase 4 — Iterative Migration

This is the core phase. The runtime supports two scheduler behaviors:

- **`per-task` (default):** migrate a batch of non-overlapping tasks, then run validation for each.
- **`wave-barrier`:** run migration waves, then validate at a barrier with optional fix-wave convergence loops.

In both modes, the runtime:

1. Parses the task list and projects estimated token cost against the budget
2. Topologically sorts tasks by dependency
3. Uses a dependency-aware `TaskQueue` to select only ready tasks
4. Executes migration work:
    - Spawns `code-migrator` with retry (up to `maxRetriesPerTask` attempts)
    - On exhaustion, escalates to `failure-adjudicator` for decision-driven adjudication
    - Applies adjudication outcomes:
      - `fixed`: reruns targeted verification after applying the adjudicated fix path
      - `false_positive`: records a waiver/fingerprint and unblocks without re-running the identical parity failure
      - `real_gap`: forces remediation work before task completion can continue
      - `inconclusive`: keeps strict retry/block behavior
5. Classifies infrastructure errors (file-lock, OOM, disk-full, network, timeout, permission) separately from agent failures, retrying infra errors independently (up to `maxInfraRetries`)
6. In `wave-barrier`, enforces a quiescent barrier before validation:
    - Runs build/test once per wave
    - If validation fails, runs targeted fix waves and retries until convergence or `waveControl.maxConvergenceIterations`
7. Tasks that fail all retries/adjudication or exceed convergence policy are marked **blocked** (with `continueOnBlocked`/`maxBlockedTasks` policy enforcement)
8. Optionally commits migrated code per-task or per-wave via the git automation subsystem
9. Emits wave lifecycle and convergence telemetry

#### Model Routing

When `options.modelRouting.enabled` is set, Phase 4 automatically escalates tasks to heavier models based on complexity score and retry behavior:

| Tier | Trigger | Model Config Key |
|------|---------|------------------|
| `normal` | Default | `copilot.model` (or `claudeCode.model`) |
| `heavy` | Complexity score ≥ `heavyThreshold` | `modelRouting.heavyModel` |
| `critical` | Complexity ≥ `criticalThreshold`, or agent in `criticalAgents`, or retry attempt ≥ `escalateOnRetryAttempt` | `modelRouting.criticalModel` |

Escalation cost is tracked and capped by `modelRouting.maxEscalationCostUsd`.

### Phase 5 — Final Parity Verification

The `final-parity-checker` performs a codebase-wide parity sweep. If issues are found, the runtime spawns `code-migrator` to fix each issue — up to 2 loopback iterations before proceeding. Resumable via per-phase cursor.

### Phase 6 — E2E Testing & Documentation

`e2e-test-crafter` and `documentation-writer` run **in parallel** (serialized when git automation is enabled). Neither is critical; failures are logged but do not abort the migration.

### Phase 8 — Idiomatic Refactor (Optional)

When `options.idiomaticRefactor.enabled` is set, Phase 8 runs up to `maxIterations` (default: 2) review-and-refactor cycles:

1. `idiomatic-reviewer` scans the migrated codebase for non-idiomatic patterns.
2. For each flagged issue, `idiomatic-refactorer` applies targeted fixes with git commits.

Phase 8 executes before Phase 7 (Completion).

### Phase 7 — Completion

The runtime writes a final summary to the progress file and returns a `MigrationResult` with per-phase outcomes, token usage, and lists of failed/blocked tasks.

---

## Resilience

### Checkpointing & Deterministic Resume

All state is persisted to `.aamf/migration/{projectName}/state/checkpoint.json` after every phase completion and task completion. The checkpoint records:

- Current phase and per-phase cursors for deterministic resume (Phases 4, 5, 6, 8)
- Completed phases and tasks (with per-task wall-clock durations)
- Failed/blocked tasks with error details
- Phase output file paths
- Cumulative token usage (by phase and by agent)
- Phase 0 source fingerprint (skip KB rebuild if unchanged)
- Phase 3 decomposer progress (per-module-group completion)
- Adjudication waivers and auditable event history
- Terminal exhaustion metadata for fail-fast policy
- Metrics record count for JSONL resume alignment

To resume an interrupted migration:

```bash
npx aamf migrate -c migration.config.json --resume
```

The orchestrator skips completed phases and resumes each phase from its saved cursor. A backup checkpoint (`state/checkpoint.backup.json`) is maintained for corruption recovery.

### Retry & Failure Adjudication

Failed agent invocations are retried up to `maxRetriesPerTask` times (default: 3). Infrastructure errors (file-lock, OOM, network, etc.) are retried separately up to `maxInfraRetries` without consuming agent-level retries.

When all retries are exhausted, the `failure-adjudicator` agent returns a decision and runtime applies it:

1. `fixed` → apply fix path and rerun targeted verifier checks
2. `false_positive` → persist waiver/fingerprint evidence and unblock the task without repeating the same parity retry loop
3. `real_gap` → force remediation/replanning before progressing
4. `inconclusive` → preserve strict retry semantics; task is blocked if it still cannot be validated

### Graceful Shutdown

On `SIGINT` or `SIGTERM`, the runtime saves the current checkpoint and writes an event to the progress file before exiting. The migration can be resumed from this point.

---

## Token Budget Management

An optional `tokenBudget` cap can be set in the config. The `TokenTracker` records usage after every agent invocation — including cached input tokens and premium requests — and checks thresholds:

| Threshold | Action |
|-----------|--------|
| < 80% | Continue normally |
| 80–100% | Log a warning |
| > 100% | Pause the migration (can be resumed later) |

The `CostEstimator` provides approximate USD cost estimates using a built-in pricing table covering 48 models across Claude, Gemini, and OpenAI families. Pricing resolution is three-tier:

1. User-provided `costOverrides` (per-model `{ input, output }` in config)
2. Built-in pricing table
3. Default fallback with a warning for unknown models

Cached tokens are billed at 50% of the input rate.

---

## Observability

### Metrics Collection

Every agent invocation is recorded as an `InvocationMetric` with 22 fields including agent type, phase, timing, token counts, cost, routing tier, cached tokens, and premium requests.

Metrics are persisted two ways:
- **`metrics/invocations.jsonl`** — append-only JSONL log (one record per invocation, survives resume)
- **`metrics/summary.json`** — full aggregate snapshot with per-agent/per-phase breakdowns

### Observability Report

After all phases complete, the runtime generates `reports/observability/index.md` containing:

- **Mermaid Gantt chart** of the agent invocation timeline (by agent type, with active/critical status)
- **Parallelism over time** table (epoch-second × concurrency)
- **Cost and token breakdown** by agent type
- **Retry summary** with chain analysis (attempts, final status)
- **Wave lifecycle and efficiency** summary (execution mode, wave count, convergence stats, build/test runs, recovery metrics)

A machine-readable `reports/observability/metrics.json` is written alongside.

### Runtime Log

A unified structured log at `logs/runtime/migration.log` captures all runtime events — phase transitions, task completions, errors, timing, and agent output lines.

---

## Artifact Layout

All migration state is organized under `.aamf/migration/{projectName}/`:

```
.aamf/migration/{projectName}/
├── state/
│   ├── checkpoint.json              # Full pipeline state
│   ├── checkpoint.backup.json       # Previous checkpoint
│   └── run-manifest.json            # Run metadata
├── logs/
│   ├── runtime/
│   │   └── migration.log            # Unified structured log
│   ├── agents/{agent}/{taskId}/     # Per-agent invocation logs
│   │   └── *.live.log               # Live-streamed stdout/stderr
│   └── commands/
│       ├── build/                   # Build command output
│       └── test/                    # Test command output
├── artifacts/
│   ├── contexts/                    # Context JSON files per invocation
│   ├── results/                     # Agent result files
│   ├── planning/
│   │   ├── migration-plan.md        # Phase 3 plan
│   │   ├── groups.json              # Module groups
│   │   ├── strategy.md              # Selected strategy
│   │   ├── tasks-merged.json        # Decomposed task list
│   │   └── competing-strategies.md  # (if adjudication needed)
│   ├── parity/
│   │   ├── final-parity-report.md   # Phase 5 output
│   │   └── idiomatic-review-report.md  # Phase 8 output
│   ├── adjudication/                # Failure adjudication records
│   └── impact-assessment.md         # Phase 1 output
├── reports/
│   ├── progress.md                  # Human-readable status dashboard
│   └── observability/
│       ├── index.md                 # Observability report with Gantt chart
│       └── metrics.json             # Machine-readable metrics
├── metrics/
│   ├── invocations.jsonl            # Per-invocation JSONL log
│   └── summary.json                 # Aggregate metrics snapshot
├── knowledge-base/                  # Phase 2 outputs
└── kb.db                            # SQLite knowledge-base index (Phase 0)
```

The `reports/progress.md` file is updated in real-time with a phase table, task-level progress, token usage, wave lifecycle data, and a timestamped event log.

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

## Git Automation

AAMF can automatically initialize and commit to a git repository in the output directory. Controlled by the `options.git` config section:

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable git commit automation |
| `autoInit` | `true` | Auto-initialize a git repo in `target.outputPath` if not already one |
| `commitByAgent` | `true` | Create a commit after each agent invocation that modifies files |
| `commitPerTask` | `true` | Create a commit after each Phase 4 task completes |
| `allowEmptyTaskCommits` | `true` | Allow empty commits for tasks that produce no file changes |
| `authorName` | `'AAMF Migration Bot'` | Git author name |
| `authorEmail` | `'aamf@local.invalid'` | Git author email |

In `wave-barrier` mode, commits are created per-wave rather than per-task.

---

## Getting Started

### Prerequisites

- **Node.js 20+**
- An agent CLI installation — either Copilot CLI (`copilot --agent`) or Claude Code (`claude --agent`)
- Agent definition files (`.agent.md`) in the configured agent directory

### Installation

```bash
cd runtime
npm install
npm run build
```

### Configuration

Create a `migration.config.json` in your project root. See [runtime/README.md](runtime/README.md#configuration) for the full field reference.

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

# Set log level
npx aamf migrate -c migration.config.json --log-level debug

# Check migration status
npx aamf status -c migration.config.json

# Reset migration state
npx aamf reset -c migration.config.json

# Build/update the KB index manually
npx aamf index build --root ./src --db ./kb.db
npx aamf index update --root ./src --db ./kb.db src/new-file.ts

# Start a standalone KB MCP server
npx aamf kb-server --db ./kb.db
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
