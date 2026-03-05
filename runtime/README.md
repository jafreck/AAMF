# AAMF Runtime

The AAMF runtime is the execution harness for the Autonomous Agent Migration Framework. It provides process management, checkpointing, parallelism, budget tracking, observability, and progress reporting — orchestrating AI agents to migrate large codebases between languages and frameworks.

## Prerequisites

- **Node.js 20+**
- An agent CLI installation — either Copilot CLI (`copilot --agent`) or Claude Code (`claude --agent`)
- Agent definition files in the configured agent directory (`.github/agents/` or `.claude/agents/`)

## Installation

```bash
cd runtime
npm install
npm run build
```

## Configuration

Create a `migration.config.json` file in your project root. Below is a full reference with all available fields.

### Example Config

```json
{
  "projectName": "my-migration",
  "agentRuntime": "copilot",
  "source": {
    "path": "../legacy-app",
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
    "maxLinesPerTask": 500,
    "tokenBudget": 2000000,
    "dryRun": false,
    "resume": false,
    "executionMode": "wave-barrier",
    "waveControl": {
      "waveSize": 3,
      "maxConvergenceIterations": 3
    },
    "continueOnBlocked": true,
    "maxBlockedTasks": 0,
    "qualityPolicy": "strict",
    "maxInfraRetries": 3,
    "keepArtifacts": true,
    "kbIndex": {
      "enabled": true,
      "embeddings": {
        "enabled": false,
        "model": "Qwen/Qwen3-Embedding-0.6B",
        "pythonBin": "python3"
      }
    },
    "modelRouting": {
      "enabled": true,
      "heavyModel": "claude-opus-4.6",
      "criticalModel": "claude-opus-4.6",
      "heavyThreshold": 40,
      "criticalThreshold": 70,
      "escalateOnRetryAttempt": 2
    },
    "git": {
      "enabled": true,
      "autoInit": true,
      "commitPerTask": true
    },
    "idiomaticRefactor": {
      "enabled": false,
      "maxIterations": 2
    }
  },
  "copilot": {
    "cliCommand": "copilot",
    "model": "claude-sonnet-4.6",
    "failureRecoveryModel": "claude-opus-4.6",
    "agentDir": ".github/agents",
    "timeout": 300000
  }
}
```

### Field Reference

#### Root

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projectName` | `string` | *required* | Unique identifier for this migration (kebab-case). Used for checkpoint and log directories. |
| `agentRuntime` | `'copilot' \| 'claude-code'` | `'copilot'` | Which agent CLI to use for invocations. |

#### Source

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source.path` | `string` | *required* | Relative or absolute path to the source codebase. |
| `source.language` | `string` | *required* | Source language (e.g. `python`, `java`, `c`, `ruby`). |
| `source.entryPoints` | `string[]` | — | List of top-level entry files to begin analysis from. |
| `source.excludePatterns` | `string[]` | `['node_modules', '.git', 'dist', 'build', '__pycache__']` | Glob patterns to exclude from scanning. |

#### Target

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target.language` | `string` | *required* | Target language for the migrated codebase. |
| `target.framework` | `string` | — | Target framework (e.g. `express`, `actix-web`, `spring`). |
| `target.outputPath` | `string` | *required* | Directory where migrated code is written. |
| `target.testFramework` | `string` | — | Test framework to generate tests for (e.g. `vitest`, `pytest`). |
| `target.buildCommand` | `string` | — | Command the runtime executes to verify the build succeeds. |
| `target.testCommand` | `string` | — | Command the runtime executes to run tests. |

#### Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `options.maxParallelAgents` | `integer (1–10)` | `3` | Maximum number of agent processes to run concurrently. |
| `options.maxRetriesPerTask` | `integer (1–5)` | `3` | How many times to retry a failed agent task before escalating. |
| `options.maxLinesPerTask` | `integer` | `500` | Maximum lines per migration task chunk. |
| `options.tokenBudget` | `integer` | — | Total token budget across all LLM calls. |
| `options.contextWindowStrategy` | `'per-invocation' \| 'session'` | `'per-invocation'` | How context windows are managed across invocations. |
| `options.contextWindowTokens` | `integer` | — | Maximum context window tokens per invocation. |
| `options.dryRun` | `boolean` | `false` | Validate config and plan work without executing agents. |
| `options.resume` | `boolean` | `false` | Resume from the last checkpoint instead of starting fresh. |
| `options.invocationDelayMs` | `integer (≥0)` | `0` | Delay in ms between agent invocations. |
| `options.buildConcurrency` | `integer (0–10)` | `1` | Max concurrent build/test commands. 0 = uses `maxParallelAgents`. |
| `options.executionMode` | `'per-task' \| 'wave-barrier'` | `'per-task'` | Phase 4 scheduler mode. |
| `options.waveControl.waveSize` | `integer (≥1)` | `3` | Max migration tasks per wave in `wave-barrier` mode. |
| `options.waveControl.maxConvergenceIterations` | `integer (≥1)` | `3` | Max validation/fix iterations per wave before blocking. |
| `options.continueOnBlocked` | `boolean` | `true` | Continue migration when tasks are blocked. |
| `options.maxBlockedTasks` | `integer (≥0)` | `0` | Max blocked tasks before halting. 0 = unlimited. |
| `options.qualityPolicy` | `'strict' \| 'balanced' \| 'deferred-strict'` | `'strict'` | Quality gating policy for wave-end validation. |
| `options.maxInfraRetries` | `integer (0–10)` | `3` | Max retries for infrastructure errors (OOM, network, etc.). Does not consume `maxRetriesPerTask`. |
| `options.avgTokensPerTask` | `integer (≥1)` | `5000` | Estimated average tokens per Phase 4 task (for cost projection). |
| `options.keepArtifacts` | `boolean` | `false` | Preserve `.aamf` and output directories after migration. Overridden by `AAMF_KEEP_ARTIFACTS=1`. |

#### KB Indexing (Phase 0)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `options.kbIndex.enabled` | `boolean` | `false` | Enable the KB indexing phase. Also enabled by `AAMF_USE_KB_INDEX=1`. |
| `options.kbIndex.embeddings.enabled` | `boolean` | `false` | Enable embedding-based semantic search (requires Python + sentence-transformers). |
| `options.kbIndex.embeddings.model` | `string` | `'Qwen/Qwen3-Embedding-0.6B'` | Sentence-transformers model for embeddings. |
| `options.kbIndex.embeddings.pythonBin` | `string` | `'python3'` | Path to Python binary. |

#### Model Routing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `options.modelRouting.enabled` | `boolean` | `false` | Enable automatic model tier escalation. |
| `options.modelRouting.defaultModel` | `string` | — | Override default model for routing (falls back to `copilot.model`). |
| `options.modelRouting.heavyModel` | `string` | — | Model for heavy-tier tasks. |
| `options.modelRouting.criticalModel` | `string` | — | Model for critical-tier tasks. |
| `options.modelRouting.heavyThreshold` | `integer (0–100)` | `40` | Complexity score threshold for heavy tier. |
| `options.modelRouting.criticalThreshold` | `integer (0–100)` | `70` | Complexity score threshold for critical tier. |
| `options.modelRouting.criticalAgents` | `string[]` | — | Agent names that always use the critical model. |
| `options.modelRouting.criticalTaskPatterns` | `string[]` | — | Task ID patterns that always use the critical model. |
| `options.modelRouting.maxCriticalTasks` | `integer (≥0)` | `0` | Max tasks routed to critical tier. 0 = unlimited. |
| `options.modelRouting.maxEscalationCostUsd` | `number (≥0)` | `0` | Cost cap for escalated invocations. 0 = unlimited. |
| `options.modelRouting.escalateOnRetryAttempt` | `integer (≥1)` | `2` | Retry attempt number that triggers escalation. |

#### Git Automation

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `options.git.enabled` | `boolean` | `true` | Enable git commit automation. |
| `options.git.autoInit` | `boolean` | `true` | Auto-initialize a git repo in `target.outputPath`. |
| `options.git.commitByAgent` | `boolean` | `true` | Create a commit after each agent invocation that modifies files. |
| `options.git.commitPerTask` | `boolean` | `true` | Create a commit after each Phase 4 task completes. |
| `options.git.allowEmptyTaskCommits` | `boolean` | `true` | Allow empty commits for tasks that produce no file changes. |
| `options.git.authorName` | `string` | `'AAMF Migration Bot'` | Git author name. |
| `options.git.authorEmail` | `string` | `'aamf@local.invalid'` | Git author email. |

#### Idiomatic Refactor (Phase 8)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `options.idiomaticRefactor.enabled` | `boolean` | `false` | Enable the optional idiomatic refactor phase. |
| `options.idiomaticRefactor.maxIterations` | `integer` | `2` | Max review-and-refactor cycles. |

#### Copilot

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `copilot.cliCommand` | `string` | `'copilot'` | Path or name of the Copilot CLI binary. |
| `copilot.model` | `string` | — | Model to use via `--model` flag (e.g. `claude-sonnet-4.6`). |
| `copilot.failureRecoveryModel` | `string` | — | Model to use for `failure-adjudicator` invocations. |
| `copilot.agentDir` | `string` | `'.github/agents'` | Directory containing `.agent.md` prompt files. |
| `copilot.timeout` | `integer` | `300000` | Per-agent invocation timeout in ms (5 minutes). |
| `copilot.costOverrides` | `Record<string, { input, output }>` | — | Per-model pricing overrides (USD per 1M tokens). |
| `copilot.phaseTimeouts` | `Record<number, integer>` | — | Per-phase timeout overrides in ms, keyed by phase number. |

#### Claude Code

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `claudeCode.cliCommand` | `string` | `'claude'` | Path or name of the Claude Code binary. |
| `claudeCode.model` | `string` | — | Model to use. |
| `claudeCode.failureRecoveryModel` | `string` | — | Model for failure adjudication. |
| `claudeCode.agentDir` | `string` | `'.claude/agents'` | Directory containing `.agent.md` prompt files. |
| `claudeCode.timeout` | `integer` | `300000` | Per-agent invocation timeout in ms. |
| `claudeCode.contextWindowTokens` | `integer` | — | Context window token limit. |
| `claudeCode.costOverrides` | `Record<string, { input, output }>` | — | Per-model pricing overrides (USD per 1M tokens). |
| `claudeCode.phaseTimeouts` | `Record<number, integer>` | — | Per-phase timeout overrides in ms. |

#### Environment

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `environment.inheritShellPath` | `boolean` | `true` | Inherit `$PATH` from the user's shell. |
| `environment.shell` | `string` | — | Shell to use for child processes (falls back to `$SHELL` then `/bin/sh`). |
| `environment.extraPath` | `string[]` | `[]` | Additional directories to prepend to `$PATH` in agent processes. |

## Usage

```bash
# Run a full migration
npx aamf migrate -c migration.config.json

# Resume from the last checkpoint
npx aamf migrate -c migration.config.json --resume

# Validate configuration without executing (dry run)
npx aamf migrate -c migration.config.json --dry-run

# Run a specific phase only
npx aamf migrate -c migration.config.json --phase 4

# Set log level (default: info)
npx aamf migrate -c migration.config.json --log-level debug

# Show current migration status
npx aamf status -c migration.config.json

# Reset all migration state
npx aamf reset -c migration.config.json

# Reset from a specific phase onward
npx aamf reset -c migration.config.json --phase 4

# Build the KB index from source
npx aamf index build --root ./legacy-app --db ./kb.db

# Incrementally update KB index for specific files
npx aamf index update --root ./legacy-app --db ./kb.db src/changed-file.py

# Start a standalone KB MCP server
npx aamf kb-server --db ./kb.db
```

## Architecture

### Migration Phases

The runtime executes migration as a sequence of up to 9 phases (7 standard + 2 optional), each driven by one or more specialized agents:

| Phase | Name | Description |
|-------|------|-------------|
| 0 | **KB Indexing** *(optional)* | Builds a SQLite knowledge-base index from the source codebase using `@aamf/lore` with tree-sitter parsing and optional embeddings. Starts an HTTP MCP server for downstream agent access. |
| 1 | **Impact Assessment** | Scans the source codebase to build a dependency graph, identify file roles, and estimate migration complexity. |
| 2 | **Knowledge Base Construction** | Extracts patterns, idioms, and domain knowledge from the source code into a structured knowledge base that downstream agents reference. |
| 3 | **Migration Planning** | Produces an ordered task list — module groups decomposed into granular tasks with dependency ordering. Optionally invokes adjudication for competing strategies. |
| 4 | **Iterative Migration** | The main execution loop. Supports per-task and wave-barrier scheduling with migration/validation cycles, infrastructure error classification, failure adjudication, model routing, and git automation. |
| 5 | **Final Parity Verification** | Compares the migrated codebase against the source to verify functional equivalence, with loopback fix capability. |
| 6 | **E2E Testing & Documentation** | Generates end-to-end tests and migration documentation. |
| 8 | **Idiomatic Refactor** *(optional)* | Reviews migrated code for non-idiomatic patterns and applies targeted refactoring with git commits. |
| 7 | **Completion** | Finalizes artifacts, writes the summary report, generates the observability report, and cleans up. |

Execution order is 0→1→2→3→4→5→6→8→7. Phase 0 requires `kbIndex.enabled`. Phase 8 requires `idiomaticRefactor.enabled`.

### Runtime ↔ Agent Boundary

The runtime and agents have a strict separation of concerns:

- **Runtime** manages process lifecycle, file I/O, checkpointing, token budget enforcement, parallel execution, retry logic, model routing, git automation, observability, and progress reporting.
- **Agents** perform all reasoning — code analysis, planning decisions, code generation, and verification. Each agent is an `.agent.md` prompt file that the runtime invokes as a subprocess via either Copilot CLI or Claude Code.
- **Communication** is file-based IPC only. The runtime writes context files to disk, launches an agent, and reads the agent's output files when it exits. Agent stdout/stderr is streamed live to `.live.log` files. There are no sockets, no shared memory, and no streaming protocols between runtime and agents.
- **KB Access** uses the Model Context Protocol (MCP). When Phase 0 is enabled, the runtime runs an in-process HTTP MCP server that agents connect to for knowledge-base queries.

### Phase 4 Execution Modes

Phase 4 supports two scheduler strategies:

- **`per-task` (default):** batches non-overlapping tasks, validates each after migration.
- **`wave-barrier`:** runs a migration wave of non-overlapping tasks first, then enforces a quiescent barrier before any build/test validation runs.

In `wave-barrier` mode, each cycle is:

1. **Migration wave** — run up to `waveControl.waveSize` ready, non-overlapping migration tasks in parallel.
2. **Validation wave** — after migration settles, run build/test at the barrier (no migration/validation overlap).
3. **Fix wave (if needed)** — rerun targeted migration tasks for failed validation and repeat validation until convergence or `waveControl.maxConvergenceIterations` is reached.

Blocked-task policy (`continueOnBlocked`, `maxBlockedTasks`) is enforced after each wave.

When migration/parity retries are exhausted, Phase 4 invokes `failure-adjudicator` and applies decision outcomes:

- `fixed`: rerun targeted verifier checks after applying the adjudicated fix path.
- `false_positive`: persist waiver/fingerprint evidence and unblock without repeating the identical parity failure loop.
- `real_gap`: force remediation work before a task can complete.
- `inconclusive`: preserve strict retry/block behavior.

Infrastructure errors (file-lock, OOM, disk-full, network, timeout, permission) are classified and retried separately via `maxInfraRetries` without consuming agent-level retry attempts.

## Progress Tracking

The runtime writes several artifacts to track migration progress:

- **`reports/progress.md`** — Human-readable progress report with phase table, task status, token usage, wave lifecycle data, and timestamped event log.
- **`state/checkpoint.json`** — Machine-readable snapshot of migration state, enabling `--resume` (with `state/checkpoint.backup.json` backup).
- **Per-agent logs** — Each agent invocation writes stdout/stderr to `logs/agents/{agent}/{taskId}/...` with live-streamed `.live.log` files.
- **Command logs** — Build/test command output is written to `logs/commands/{build|test}/...`.
- **`logs/runtime/migration.log`** — Unified log of all runtime events (phase transitions, task completions, errors, timing).
- **`metrics/invocations.jsonl`** — Append-only per-invocation metrics log.
- **`metrics/summary.json`** — Aggregate metrics snapshot.
- **`reports/observability/index.md`** — Post-run observability report with Mermaid Gantt timeline, cost breakdown, retry analysis, and wave efficiency metrics.

## Artifact Retention

By default, AAMF cleans up the `.aamf` checkpoint directory and the target output directory (`target.outputPath`) after a migration completes. To preserve these directories for post-run inspection or debugging, you can enable artifact retention in two ways:

1. **Config option** — set `options.keepArtifacts` to `true` in `migration.config.json`:
   ```json
   { "options": { "keepArtifacts": true } }
   ```
2. **Environment variable** — set `AAMF_KEEP_ARTIFACTS=1` at runtime:
   ```bash
   AAMF_KEEP_ARTIFACTS=1 npx aamf migrate -c migration.config.json
   ```

**Precedence:** The environment variable takes priority over the config file. If `AAMF_KEEP_ARTIFACTS=1` is set, artifacts are retained regardless of the `keepArtifacts` config value.

| Directories affected | Description |
|----------------------|-------------|
| `.aamf/migration/{projectName}/` | State, progress, logs, knowledge base, metrics, and planning artifacts |
| `target.outputPath` | Migrated output code |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Config validation errors** | Check field names and types against the schema reference above. Run with `--dry-run` to validate without executing. |
| **Agent timeout** | Increase `copilot.timeout` (or `claudeCode.timeout`) in your config. Use `copilot.phaseTimeouts` for per-phase overrides. Large files may need 600000 ms or more. |
| **Budget exceeded** | Raise `options.tokenBudget` or resume from the last checkpoint with `--resume` after increasing the budget. |
| **Checkpoint corruption** | The runtime automatically falls back to the most recent backup checkpoint. If both are corrupted, use `npx aamf reset` and restart. |
| **Agent not found** | Ensure `.agent.md` files exist in the directory specified by `copilot.agentDir` (or `claudeCode.agentDir`). |
| **Infrastructure errors** | File-lock, OOM, network, and permission errors are classified as infrastructure failures and retried separately (up to `maxInfraRetries`). |
| **KB index stale** | The runtime computes a source fingerprint; set `kbIndex.enabled` and re-run to auto-rebuild when sources change. Or run `npx aamf index build` manually. |

## Structured JSON Agent Output (Sidecar)

In addition to their markdown output, agents can (and should) write a structured JSON sidecar file alongside each task result. The runtime checks for the sidecar first; if it exists and validates, it is used in place of markdown parsing.

### Sidecar Location

```
{progressDir}/artifacts/results/{agent}-{taskId}.result.json
```

For example: `.aamf/migration/my-project/artifacts/results/code-migrator-task-001.result.json`

### JSON Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `string` | **Yes** | Unique task identifier, e.g. `"task-001"`. |
| `agent` | `string` | **Yes** | Name of the agent that produced this result. |
| `status` | `"completed" \| "failed" \| "needs-review"` | **Yes** | Outcome of the task execution. |
| `outputFiles` | `string[]` | No | Files created or modified by the agent. Defaults to `[]`. |
| `parity` | `"pass" \| "partial" \| "fail"` | No | Parity verification result (set by parity-verifier). |
| `issues` | `Issue[]` | No | List of issues found. Defaults to `[]`. |
| `issues[].severity` | `"critical" \| "major" \| "minor"` | Yes (if issue) | Severity of the issue. |
| `issues[].description` | `string` | Yes (if issue) | Description of the issue. |
| `issues[].sourceLocation` | `string` | No | File and line in the source code. |
| `issues[].targetLocation` | `string` | No | File and line in the target code. |
| `metrics` | `object` | No | Optional execution metrics. |
| `metrics.linesOfCode` | `number` | No | Lines of code produced. |
| `metrics.tokensUsed` | `number` | No | Tokens consumed during execution. |
| `metrics.durationMs` | `number` | No | Wall-clock duration in milliseconds. |
| `notes` | `string` | No | Free-form notes about the task execution. |

### Example

```json
{
  "taskId": "task-001",
  "agent": "code-migrator",
  "status": "completed",
  "outputFiles": ["src/auth/login.ts", "src/auth/session.ts"],
  "parity": "pass",
  "issues": [],
  "metrics": {
    "linesOfCode": 245,
    "tokensUsed": 8500,
    "durationMs": 42000
  },
  "notes": "Migrated login and session modules. Used express-session instead of Flask-Session."
}
```

### Agent Prompt Authors

When writing `.agent.md` prompts, instruct agents to write **both** their standard markdown output and a `.result.json` sidecar. The runtime validates the JSON against a Zod schema (`TaskResultSchema` in `result-parser.ts`). If the sidecar is missing or fails validation, the runtime falls back to markdown parsing.

## Project Structure

```
runtime/src/
├── index.ts                          # CLI entry point (commander)
├── agents/
│   ├── context-builder.ts            # Assembles file-based context for agent invocations
│   ├── result-parser.ts              # Parses structured output from agent responses
│   ├── task-decomposer.tasks.schema.json  # JSON schema for task-decomposer outputs
│   └── types.ts                      # Agent-related type definitions (16 agent types)
├── budget/
│   ├── cost-estimator.ts             # USD cost estimation (48 models across Claude, Gemini, OpenAI)
│   └── token-tracker.ts              # Tracks cumulative token usage against budget
├── config/
│   ├── loader.ts                     # Reads and validates migration.config.json
│   └── schema.ts                     # Zod schemas for configuration validation
├── core/
│   ├── agent-launcher.ts             # Spawns agent subprocesses with live stdout/stderr streaming
│   ├── checkpoint.ts                 # Saves and restores migration state with deterministic resume
│   ├── kb-server-process.ts          # Manages in-process HTTP MCP server for KB access
│   ├── orchestrator.ts               # Top-level phase sequencing and coordination (~3500 lines)
│   ├── phase-registry.ts             # Maps phase numbers to handler implementations (9 phases)
│   ├── progress.ts                   # Writes progress.md and status updates
│   ├── runtime-paths.ts              # Canonical artifact directory builder (32 named paths)
│   └── runtime.ts                    # Core runtime initialization and shutdown
├── execution/
│   ├── parallel-executor.ts          # Runs tasks concurrently up to maxParallelAgents
│   ├── retry.ts                      # Retry with backoff and failure-adjudicator escalation
│   ├── serial-executor.ts            # Runs tasks sequentially for ordered dependencies
│   └── task-queue.ts                 # Dependency-aware priority queue with topological sort
├── logging/
│   ├── events.ts                     # Structured event definitions
│   └── logger.ts                     # Runtime logger (console + file output)
├── observability/
│   ├── metrics-collector.ts          # Records invocation metrics as JSONL + aggregates
│   └── report-generator.ts           # Generates Markdown observability reports with Gantt charts
└── util/
    ├── fs.ts                         # Atomic writes, ensureDir, JSON helpers
    └── process.ts                    # Child process spawn with timeout + tree kill
```

## Development

```bash
# Run in development mode (tsx, no build step)
npm run dev -- migrate -c path/to/config.json

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint / typecheck
npm run lint
```

## Coverage

Run coverage locally from the `runtime/` directory:

```bash
npx vitest run --coverage
```

Coverage thresholds are enforced at **90%** for lines, branches, functions, and statements. These thresholds apply globally (not per-file). The CI workflow runs tests with coverage enabled and will fail if any threshold is not met.

## License

MIT
