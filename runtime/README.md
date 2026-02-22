# AAMF Runtime

AAMF (Agent Architecture for Migration Framework) is a framework that orchestrates AI agent-based code migration. It uses specialized agents defined as markdown prompts (`.agent.md` files) to analyze, plan, and execute codebase migrations between languages and frameworks. The runtime layer provides the execution harness — process management, checkpointing, parallelism, budget tracking, and progress reporting.

## Prerequisites

- **Node.js 22+**
- A Copilot CLI installation (`copilot --agent` must be available)
- Agent definition files in `.github/agents/` (the `.agent.md` prompts)

## Installation

```bash
cd runtime
npm install
npm run build
```

## Configuration

Create a `migration.config.json` file in your project root. Below is a full reference with all available fields:

```json
{
  "projectName": "my-migration",
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
    "largeFileThreshold": 500,
    "maxLinesPerTask": 500,
    "tokenBudget": 2000000,
    "dryRun": false,
    "resume": false
  },
  "copilot": {
    "cliCommand": "copilot",
    "model": "gpt-4o",
    "agentDir": ".github/agents",
    "timeout": 300000
  }
}
```

### Field Reference

| Section | Field | Description |
|---------|-------|-------------|
| **root** | `projectName` | Unique identifier for this migration; used for checkpoint and log directories. |
| **source** | `path` | Relative or absolute path to the source codebase. |
| | `language` | Source language (e.g. `python`, `java`, `ruby`). |
| | `entryPoints` | List of top-level entry files to begin analysis from. |
| | `excludePatterns` | Glob patterns to exclude from scanning. |
| **target** | `language` | Target language for the migrated codebase. |
| | `framework` | Target framework (e.g. `express`, `nextjs`, `spring`). |
| | `outputPath` | Directory where migrated code is written. |
| | `testFramework` | Test framework to generate tests for (e.g. `vitest`, `jest`). |
| | `buildCommand` | Command the runtime executes to verify the build succeeds. |
| | `testCommand` | Command the runtime executes to run tests. |
| **options** | `maxParallelAgents` | Maximum number of agent processes to run concurrently. Default: `3`. |
| | `maxRetriesPerTask` | How many times to retry a failed agent task before marking it failed. Default: `3`. |
| | `largeFileThreshold` | Line count above which a file is considered "large" and split into chunks. Default: `500`. |
| | `maxLinesPerTask` | Maximum lines per migration task chunk. Default: `500`. |
| | `tokenBudget` | Total token budget across all LLM calls. Default: `2000000`. |
| | `dryRun` | If `true`, validates config and plans work without executing agents. Default: `false`. |
| | `resume` | If `true`, resumes from the last checkpoint instead of starting fresh. Default: `false`. |
| **copilot** | `cliCommand` | Path or name of the Copilot CLI binary. Default: `"copilot"`. |
| | `model` | Model to use via `--model` flag (e.g. `gpt-4o`, `claude-sonnet-4`). |
| | `agentDir` | Path to the directory containing `.agent.md` prompt files. Default: `".github/agents"`. |
| | `timeout` | Per-agent invocation timeout in milliseconds. Default: `300000` (5 minutes). |

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

# Show current migration status
npx aamf status -c migration.config.json

# Reset all migration state
npx aamf reset -c migration.config.json

# Reset from a specific phase onward
npx aamf reset -c migration.config.json --phase 4
```

## Architecture

### Migration Phases

The runtime executes migration as a sequence of seven phases, each driven by one or more specialized agents:

| Phase | Name | Description |
|-------|------|-------------|
| 1 | **Impact Assessment** | Scans the source codebase to build a dependency graph, identify file roles, and estimate migration complexity. |
| 2 | **Knowledge Base Construction** | Extracts patterns, idioms, and domain knowledge from the source code into a structured knowledge base that downstream agents reference. |
| 3 | **Migration Planning** | Produces an ordered task list — which files to migrate, in what order, with what dependencies — respecting the dependency graph from Phase 1. |
| 4 | **Iterative Migration** | The main execution loop. Migrates files in dependency order, running build and test commands after each batch, and self-correcting on failures. |
| 5 | **Final Parity Verification** | Compares the migrated codebase against the source to verify functional equivalence and flag any gaps. |
| 6 | **E2E Testing & Documentation** | Generates end-to-end tests, updates documentation, and produces a migration report. |
| 7 | **Completion** | Finalizes artifacts, writes the summary report, and cleans up temporary state. |

### Runtime ↔ Agent Boundary

The runtime and agents have a strict separation of concerns:

- **Runtime** manages process lifecycle, file I/O, checkpointing, token budget enforcement, parallel execution, retry logic, and progress reporting.
- **Agents** perform all reasoning — code analysis, planning decisions, code generation, and verification. Each agent is an `.agent.md` prompt file that the runtime invokes as a subprocess.
- **Communication** is file-based IPC only. The runtime writes context files to disk, launches an agent, and reads the agent's output files when it exits. There are no sockets, no shared memory, and no streaming protocols between runtime and agents.

## Project Structure

```
runtime/src/
├── index.ts                    # CLI entry point
├── agents/
│   ├── context-builder.ts      # Assembles file-based context for agent invocations
│   ├── result-parser.ts        # Parses structured output from agent responses
│   └── types.ts                # Agent-related type definitions
├── budget/
│   ├── cost-estimator.ts       # Estimates token cost before invocations
│   └── token-tracker.ts        # Tracks cumulative token usage against budget
├── config/
│   ├── loader.ts               # Reads and validates migration.config.json
│   └── schema.ts               # Zod schemas for configuration validation
├── core/
│   ├── agent-launcher.ts       # Spawns agent subprocesses and manages lifecycle
│   ├── checkpoint.ts           # Saves and restores migration state
│   ├── orchestrator.ts         # Top-level phase sequencing and coordination
│   ├── phase-registry.ts       # Maps phase numbers to handler implementations
│   ├── progress.ts             # Writes progress.md and status updates
│   └── runtime.ts              # Core runtime initialization and shutdown
├── execution/
│   ├── parallel-executor.ts    # Runs tasks concurrently up to maxParallelAgents
│   ├── retry.ts                # Retry logic with backoff for failed tasks
│   ├── serial-executor.ts      # Runs tasks sequentially for ordered dependencies
│   └── task-queue.ts           # Priority queue for pending migration tasks
├── logging/
│   ├── events.ts               # Structured event definitions
│   └── logger.ts               # Runtime logger (console + file output)
└── util/
    ├── fs.ts                   # File system helpers
    └── process.ts              # Child process utilities
```

## Progress Tracking

The runtime writes several artifacts to track migration progress:

- **`progress.md`** — Human-readable progress report, updated after each phase. Located at `.aamf/migration/{projectName}/progress.md`.
- **`checkpoint.json`** — Machine-readable snapshot of migration state, enabling `--resume`. Located alongside `progress.md`.
- **Per-agent logs** — Each agent invocation writes stdout/stderr to the `logs/` directory with timestamped filenames.
- **`migration.log`** — Unified log of all runtime events (phase transitions, task completions, errors, timing).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Config validation errors** | Check field names and types against the schema reference above. Run with `--dry-run` to validate without executing. |
| **Agent timeout** | Increase `copilot.timeout` in your config. Large files or complex migrations may need 600000 ms or more. |
| **Budget exceeded** | Raise `options.tokenBudget` or resume from the last checkpoint with `--resume` after increasing the budget. |
| **Checkpoint corruption** | The runtime automatically falls back to the most recent backup checkpoint. If both are corrupted, use `npx aamf reset` and restart. |
| **Agent not found** | Ensure `.agent.md` files exist in the directory specified by `copilot.agentDir`. |

## Structured JSON Agent Output (Sidecar)

In addition to their markdown output, agents can (and should) write a structured JSON sidecar file alongside each task result. The runtime checks for the sidecar first; if it exists and validates, it is used in place of markdown parsing.

### Sidecar Location

```
{progressDir}/results/{agent}-{taskId}.result.json
```

For example: `.aamf/migration/my-project/results/code-migrator-task-001.result.json`

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

## Development

```bash
# Run in development mode (ts-node, no build step)
npm run dev -- migrate -c path/to/config.json

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
