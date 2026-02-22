# Prompt: Build the AAMF TypeScript Runtime Layer

## Objective

Build a TypeScript runtime layer that serves as the **execution harness** for the AAMF (Agent Architecture for Migration Framework) agent system defined in `.github/agents/*.agent.md`. The runtime must be able to actually execute migrations by spawning Copilot agent invocations, managing their lifecycle, coordinating parallelism, handling checkpointing/resume, and tracking token budgets.

**Do NOT modify any `.agent.md` files.** The agent definitions are the specification — this runtime implements the machinery that makes them executable.

## Project Structure

Create the runtime as a Node.js CLI application under `runtime/`:

```
runtime/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # CLI entry point (npx aamf ...)
│   ├── config/
│   │   ├── schema.ts               # Zod schema for migration.config.json
│   │   └── loader.ts               # Config file loader + validator
│   ├── core/
│   │   ├── runtime.ts              # Top-level MigrationRuntime class
│   │   ├── orchestrator.ts         # Phase sequencer (mirrors migration-orchestrator.agent.md)
│   │   ├── agent-launcher.ts       # Spawns agent invocations as child processes
│   │   ├── checkpoint.ts           # Checkpoint read/write/resume logic
│   │   ├── progress.ts             # progress.md writer/updater
│   │   └── phase-registry.ts      # Phase definitions and ordering
│   ├── agents/
│   │   ├── types.ts                # AgentName, AgentInvocation, AgentResult types
│   │   ├── context-builder.ts      # Builds minimal context files per agent invocation
│   │   └── result-parser.ts        # Parses agent output files into structured results
│   ├── execution/
│   │   ├── serial-executor.ts      # Runs agent invocations one at a time
│   │   ├── parallel-executor.ts    # Runs agent invocations concurrently with limits
│   │   ├── task-queue.ts           # Dependency-aware task queue for Phase 4
│   │   └── retry.ts               # Retry logic with failure-recovery escalation
│   ├── budget/
│   │   ├── token-tracker.ts        # Per-agent and cumulative token usage tracking
│   │   └── cost-estimator.ts       # Estimates cost from token counts
│   ├── logging/
│   │   ├── logger.ts               # Structured logger (console + file)
│   │   └── events.ts              # Typed event definitions
│   └── util/
│       ├── fs.ts                   # File system helpers (atomic writes, etc.)
│       └── process.ts             # Child process helpers
├── tests/
│   ├── checkpoint.test.ts
│   ├── orchestrator.test.ts
│   ├── agent-launcher.test.ts
│   ├── task-queue.test.ts
│   └── fixtures/
│       ├── sample-config.json
│       └── sample-checkpoint.json
└── README.md
```

## Dependencies

```json
{
  "dependencies": {
    "zod": "^3.23",
    "commander": "^12",
    "chalk": "^5",
    "ora": "^8",
    "p-limit": "^6",
    "p-queue": "^8",
    "date-fns": "^3"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "vitest": "^2",
    "@types/node": "^22",
    "tsx": "^4"
  }
}
```

## 1. Migration Configuration (`config/`)

### `migration.config.json` Schema

Define a Zod schema for the migration configuration file users provide:

```typescript
// config/schema.ts
import { z } from 'zod';

export const MigrationConfigSchema = z.object({
  projectName: z.string().min(1).regex(/^[a-z0-9-]+$/),
  source: z.object({
    path: z.string(),                    // absolute or relative path to source codebase
    language: z.string(),                // e.g. "python", "java", "cobol"
    entryPoints: z.array(z.string()).optional(),
    excludePatterns: z.array(z.string()).default([
      'node_modules', '.git', 'dist', 'build', '__pycache__'
    ]),
  }),
  target: z.object({
    language: z.string(),                // e.g. "typescript", "rust", "go"
    framework: z.string().optional(),    // e.g. "express", "actix", "gin"
    outputPath: z.string(),              // where migrated code goes
    testFramework: z.string().optional(),
    buildCommand: z.string().optional(),
    testCommand: z.string().optional(),
  }),
  options: z.object({
    maxParallelAgents: z.number().int().min(1).max(10).default(3),
    maxRetriesPerTask: z.number().int().min(1).max(5).default(3),
    largeFileThreshold: z.number().int().default(500),      // lines
    maxLinesPerTask: z.number().int().default(500),          // max source lines per migration task
    tokenBudget: z.number().int().optional(),                // total token budget (optional cap)
    dryRun: z.boolean().default(false),                      // validate config + plan only, no migration
    resume: z.boolean().default(false),                      // resume from last checkpoint
  }).default({}),
  copilot: z.object({
    cliCommand: z.string().default('copilot'),               // path to copilot CLI binary
    model: z.string().optional(),                            // model override
    agentDir: z.string().default('.github/agents'),          // where agent.md files live
    timeout: z.number().int().default(300_000),              // per-agent timeout in ms (5 min default)
  }).default({}),
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
```

The `loader.ts` should:
- Accept a path to a `migration.config.json` (or `migration.yaml` via js-yaml)
- Parse and validate with the Zod schema
- Resolve relative paths to absolute
- Return a frozen `MigrationConfig` object

## 2. Agent Launcher (`core/agent-launcher.ts`)

This is the **critical bridge** between the runtime and the agent prompt files. It spawns each agent as a child process.

### Requirements

```typescript
export interface AgentInvocation {
  agent: AgentName;              // e.g. 'impact-assessor'
  contextFile: string;           // path to the context JSON/MD file created for this invocation
  progressDir: string;           // .copilot/migration/{projectName}
  phase?: number;
  taskId?: string;
  additionalArgs?: Record<string, string>;
  timeout?: number;              // ms, overrides default
}

export interface AgentResult {
  agent: AgentName;
  taskId?: string;
  exitCode: number;
  success: boolean;
  outputFiles: string[];         // files created/modified by the agent
  duration: number;              // ms
  tokenUsage?: { prompt: number; completion: number; total: number };
  error?: string;                // stderr or error message on failure
}
```

### Spawning Logic

```typescript
async function launchAgent(invocation: AgentInvocation): Promise<AgentResult> {
  // 1. Build the CLI command
  //    Flexible: support both `copilot --agent <name>` (future native)
  //    and `gh copilot --agent <name>` and a fallback mode that
  //    sends the agent.md as a system prompt to a model API.
  //
  // 2. Spawn child_process.spawn() with:
  //    - stdio: ['pipe', 'pipe', 'pipe']
  //    - cwd: project root
  //    - env: inherited + AAMF_PROGRESS_DIR, AAMF_PHASE, AAMF_TASK_ID
  //
  // 3. Stream stdout/stderr to log files under:
  //    .copilot/migration/{projectName}/logs/{agent}-{taskId}-{timestamp}.log
  //
  // 4. Enforce timeout — kill the process if it exceeds the configured limit
  //
  // 5. On completion, return AgentResult with exit code, output files, duration
  //
  // 6. Track token usage if the CLI outputs usage stats (parse from stdout/stderr)
}
```

## 3. Context Builder (`agents/context-builder.ts`)

Each agent invocation needs a **minimal, focused context file** — this is critical for context window management.

### Requirements

For each agent type, build a JSON context file containing ONLY what that agent needs:

```typescript
interface AgentContext {
  agent: AgentName;
  projectName: string;
  phase: number;
  taskId?: string;
  config: {
    source: { path: string; language: string };
    target: { language: string; framework?: string; outputPath: string };
  };
  /** Paths to files the agent should read — NOT the file contents */
  inputFiles: string[];
  /** Path where the agent should write its output */
  outputPath: string;
  /** Additional structured data specific to this agent invocation */
  payload?: Record<string, unknown>;
}
```

Build context per agent type (examples):

| Agent | `inputFiles` | `payload` |
|-------|-------------|-----------|
| `impact-assessor` | `[source.path]` | — |
| `knowledge-builder` | `[source.path, impact-assessment.md]` | `{ largeFileThreshold: 500 }` |
| `large-file-analyzer` | `[specific-large-file-path]` | — |
| `migration-planner` | `[knowledge-base/index.md, impact-assessment.md, knowledge-base/large-files/*]` | — |
| `adjudicator` | `[competing-strategies-file]` | `{ decisionType: "migration-strategy" }` |
| `code-migrator` | `[task-plan-slice.md, relevant-kb-entry.md]` | `{ taskId, sourceFiles, targetFiles }` |
| `parity-verifier` | `[source-file, target-file, task-plan-slice.md]` | `{ taskId }` |
| `test-writer` | `[target-file, kb-module-doc.md, parity-report.md]` | `{ taskId, testType }` |
| `failure-recovery` | `[failure-report.md, source-file, target-file, kb-entry.md]` | `{ taskId, attemptNumber }` |
| `final-parity-checker` | `[source.path, target.outputPath, migration-plan.md]` | — |
| `e2e-test-crafter` | `[knowledge-base/architecture.md, knowledge-base/integrations.md, knowledge-base/index.md]` | — |
| `documentation-writer` | `[knowledge-base/, migration-plan.md, final-parity-report.md]` | — |

**Critical**: The context file must contain **file paths, not file contents**. The agents themselves read the files. This is the primary mechanism for context window discipline at the runtime layer.

Write each context file to `.copilot/migration/{projectName}/contexts/{agent}-{taskId}-{timestamp}.json`.

## 4. Checkpoint System (`core/checkpoint.ts`)

### Data Structure

```typescript
interface CheckpointState {
  projectName: string;
  version: number;                          // schema version for forward compat
  currentPhase: number;                     // 1-7
  currentTask: string | null;
  completedPhases: number[];
  completedTasks: string[];
  failedTasks: FailedTask[];
  blockedTasks: string[];                   // tasks that hit max retries
  phaseOutputs: Record<number, string>;     // phase → output file path
  tokenUsage: {
    total: number;
    byPhase: Record<number, number>;
    byAgent: Record<string, number>;
  };
  startedAt: string;                        // ISO timestamp
  lastCheckpoint: string;                   // ISO timestamp
  resumeCount: number;                      // how many times this migration was resumed
}

interface FailedTask {
  taskId: string;
  attempts: number;
  lastError: string;
  recoveryAttempted: boolean;
}
```

### Operations

```typescript
class CheckpointManager {
  constructor(private progressDir: string) {}

  /** Read the current checkpoint, or create initial state */
  async load(): Promise<CheckpointState>;

  /** Atomically write checkpoint (write to .tmp then rename) */
  async save(state: CheckpointState): Promise<void>;

  /** Mark a phase as complete and checkpoint */
  async completePhase(phase: number, outputPath: string): Promise<void>;

  /** Mark a task as complete and checkpoint */
  async completeTask(taskId: string): Promise<void>;

  /** Record a task failure */
  async failTask(taskId: string, error: string): Promise<void>;

  /** Block a task (max retries exceeded) */
  async blockTask(taskId: string): Promise<void>;

  /** Determine what phase/task to resume from */
  getResumePoint(): { phase: number; taskId: string | null };

  /** Add token usage */
  async addTokenUsage(agent: string, phase: number, tokens: number): Promise<void>;

  /** Check if token budget is exceeded */
  isBudgetExceeded(budget?: number): boolean;
}
```

**Atomic writes are critical** — use write-to-temp + `fs.rename()` to prevent corruption on crash.

## 5. Orchestrator (`core/orchestrator.ts`)

The orchestrator is the **TypeScript implementation of the logic described in `migration-orchestrator.agent.md`**. It does not replace the agent — it provides the process management around it.

### Phase Execution

```typescript
class MigrationOrchestrator {
  constructor(
    private config: MigrationConfig,
    private checkpoint: CheckpointManager,
    private launcher: AgentLauncher,
    private progress: ProgressWriter,
    private logger: Logger,
  ) {}

  async run(): Promise<MigrationResult> {
    const resumePoint = this.checkpoint.getResumePoint();

    for (const phase of PHASES) {
      if (resumePoint.phase > phase.id) continue; // skip completed phases

      this.progress.updatePhase(phase.id, 'in-progress');
      this.logger.info(`Starting Phase ${phase.id}: ${phase.name}`);

      const result = await phase.execute(this);

      if (result.success) {
        await this.checkpoint.completePhase(phase.id, result.outputPath);
        this.progress.updatePhase(phase.id, 'completed');
      } else {
        this.progress.updatePhase(phase.id, 'failed', result.error);
        // Decide whether to abort or continue based on phase criticality
        if (phase.critical) throw new MigrationError(phase, result);
      }
    }

    return this.buildFinalResult();
  }
}
```

### Phase 4 Detail: Migration Task Loop

Phase 4 is the most complex. Implement it as a dependency-aware task queue:

```typescript
async function executePhase4(orchestrator: MigrationOrchestrator): Promise<PhaseResult> {
  // 1. Parse migration-plan.md to extract task list with dependencies
  const tasks = await parseMigrationPlan(planPath);

  // 2. Build dependency graph, topological sort
  const sortedTasks = topologicalSort(tasks);

  // 3. Filter out already-completed tasks (from checkpoint)
  const remaining = sortedTasks.filter(t => !checkpoint.completedTasks.includes(t.id));

  // 4. For each task (serial execution for code-writing):
  for (const task of remaining) {
    // a. Build context for code-migrator (only this task's plan slice + KB entry)
    // b. Launch code-migrator → wait for completion
    // c. Launch parity-verifier (can overlap with test-writer since both are read-after-write)
    // d. Launch test-writer
    // e. If parity fails:
    //    - Launch failure-recovery with failure context
    //    - Re-attempt (up to maxRetries)
    //    - If max retries hit, mark blocked, continue
    // f. Checkpoint after each successful task
    // g. Update progress.md with completion percentage
  }
}
```

### Phase 5 Loop-Back

If `final-parity-checker` finds issues:

```typescript
// Parse final-parity-report.md for required fixes
const fixes = parseFinalParityReport(reportPath);
if (fixes.length > 0) {
  // Create targeted fix tasks and re-enter Phase 4 logic
  // But limit loop-back to 2 iterations to prevent infinite loops
}
```

## 6. Parallel Executor (`execution/parallel-executor.ts`)

For read-only agents that can run concurrently:

```typescript
import pLimit from 'p-limit';

class ParallelExecutor {
  private limit: ReturnType<typeof pLimit>;

  constructor(concurrency: number) {
    this.limit = pLimit(concurrency);
  }

  async executeAll(invocations: AgentInvocation[]): Promise<AgentResult[]> {
    const promises = invocations.map(inv =>
      this.limit(() => this.launcher.launchAgent(inv))
    );
    return Promise.allSettled(promises).then(results =>
      results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return {
          agent: invocations[i].agent,
          exitCode: 1,
          success: false,
          outputFiles: [],
          duration: 0,
          error: r.reason?.message ?? 'Unknown error',
        };
      })
    );
  }
}
```

Use this for:
- Phase 2: multiple `large-file-analyzer` instances in parallel
- Phase 4: `parity-verifier` + `test-writer` can overlap (both read target code, neither modifies it)

## 7. Token Budget Tracker (`budget/token-tracker.ts`)

```typescript
class TokenTracker {
  private usage: Map<string, number> = new Map(); // agentName → total tokens

  record(agent: string, tokens: number): void;
  getTotal(): number;
  getByAgent(): Record<string, number>;
  estimateCost(model: string): { input: number; output: number; total: number };
  isWithinBudget(budget: number): boolean;

  /** Emit a warning when approaching budget (80% threshold) */
  checkThreshold(budget: number): 'ok' | 'warning' | 'exceeded';
}
```

Parse token usage from agent output. If the Copilot CLI or API returns usage stats, extract them. If not, estimate based on input file sizes and output file sizes using approximate tokenization (1 token ≈ 4 chars).

## 8. Progress Writer (`core/progress.ts`)

Manages the `progress.md` file that provides human-readable migration status:

```typescript
class ProgressWriter {
  constructor(private filePath: string) {}

  /** Initialize fresh progress.md from config */
  async initialize(config: MigrationConfig): Promise<void>;

  /** Update current phase status */
  async updatePhase(phase: number, status: string, notes?: string): Promise<void>;

  /** Update task progress within Phase 4 */
  async updateTask(taskId: string, status: string, details?: TaskDetails): Promise<void>;

  /** Write completion summary */
  async finalize(result: MigrationResult): Promise<void>;

  /** Append a timestamped event line */
  async appendEvent(event: string): Promise<void>;
}
```

The progress file should include:
- Overall status and current phase
- Per-phase status table (matches format from migration-runner.agent.md)
- Phase 4 task completion progress bar: `[████████░░░░] 67% (20/30 tasks)`
- Token usage summary
- Failure log with timestamps
- Elapsed time

## 9. CLI Entry Point (`src/index.ts`)

```typescript
import { Command } from 'commander';

const program = new Command()
  .name('aamf')
  .description('Agent Architecture for Migration Framework — runtime')
  .version('0.1.0');

program
  .command('migrate')
  .description('Run a full migration')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .option('--resume', 'Resume from last checkpoint')
  .option('--dry-run', 'Validate config and produce plan only')
  .option('--phase <number>', 'Run only a specific phase', parseInt)
  .action(async (opts) => {
    // 1. Load and validate config
    // 2. Initialize or load checkpoint
    // 3. Create MigrationOrchestrator
    // 4. Run orchestrator
    // 5. Print summary
  });

program
  .command('status')
  .description('Show current migration status')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .action(async (opts) => {
    // Read progress.md and checkpoints.json, print formatted status
  });

program
  .command('reset')
  .description('Reset migration state (remove checkpoints)')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .option('--phase <number>', 'Reset from a specific phase onward', parseInt)
  .action(async (opts) => {
    // Clear checkpoint state, optionally from a specific phase
  });

program.parse();
```

## 10. Logging (`logging/`)

### Requirements

- Structured log output with levels: `debug`, `info`, `warn`, `error`
- Console output with color (chalk) and spinners (ora) for interactive use
- File logging under `.copilot/migration/{projectName}/logs/`
- Per-agent log files: `{agent}-{taskId}-{timestamp}.log` captures full stdout/stderr
- A `migration.log` that captures all runtime events in a structured format

```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;         // 'runtime' | agent name
  phase?: number;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}
```

## 11. Migration Plan Parser

The runtime needs to parse the `migration-plan.md` produced by Phase 3 to drive Phase 4. Implement a parser that extracts:

```typescript
interface MigrationTask {
  id: string;                    // e.g. "task-001"
  name: string;
  sourceFiles: string[];         // paths
  targetFiles: string[];         // expected output paths
  knowledgeBaseRef: string;      // path to KB doc
  dependencies: string[];        // task IDs
  complexity: 'simple' | 'moderate' | 'complex';
  description: string;
  acceptanceCriteria: string[];
  parityChecks: string[];
  lineRange?: { start: number; end: number };  // for large file chunks
}
```

Parse from the markdown format defined in `migration-planner.agent.md`. Use regex-based extraction — don't over-engineer with a full markdown AST. The task format is well-defined and consistent.

## 12. Error Handling & Resilience

### Agent Process Failures

```typescript
// Timeout: kill process, record timeout error, trigger retry
// Exit code != 0: capture stderr, record failure, trigger retry
// Missing output files: record as incomplete, trigger retry
// Corrupted output: attempt re-parse, if fails trigger retry
```

### Runtime Failures

```typescript
// fs errors: retry with exponential backoff (3 attempts)
// checkpoint corruption: fall back to previous checkpoint backup
// config errors: fail fast with clear message, no retry
```

### Graceful Shutdown

Handle `SIGINT` and `SIGTERM`:
1. Kill any running agent child processes
2. Save current checkpoint state
3. Write "interrupted" status to progress.md
4. Exit cleanly

```typescript
process.on('SIGINT', async () => {
  logger.warn('Received SIGINT — shutting down gracefully');
  await killRunningAgents();
  await checkpoint.save(currentState);
  await progress.appendEvent('Migration interrupted by user (SIGINT)');
  process.exit(130);
});
```

## 13. Testing Strategy

Write tests with Vitest:

### Unit Tests
- `checkpoint.test.ts` — load/save/resume/atomic-write
- `config/schema.test.ts` — config validation, defaults, error messages
- `context-builder.test.ts` — correct context for each agent type
- `task-queue.test.ts` — topological sort, dependency resolution
- `result-parser.test.ts` — parse various agent output formats
- `token-tracker.test.ts` — accumulation, budget checking

### Integration Tests
- `agent-launcher.test.ts` — spawn a mock agent (simple echo script), verify result collection
- `orchestrator.test.ts` — run a mock migration with stub agents, verify phase sequencing and checkpointing

### Fixtures
- `sample-config.json` — a valid migration config
- `sample-checkpoint.json` — a mid-migration checkpoint for resume testing
- `sample-migration-plan.md` — a small plan for task parsing tests
- `mock-agent.sh` — a shell script that simulates agent behavior (reads context, writes output files)

## 14. Key Implementation Constraints

1. **No agent logic in the runtime.** The runtime manages processes and files. It does NOT implement any migration analysis, code generation, or verification logic. That's all in the agent prompts.

2. **File-based IPC only.** Agents communicate exclusively through files in `.copilot/migration/{projectName}/`. The runtime writes context files before launching agents and reads output files after they complete.

3. **Atomic file operations.** All writes to `checkpoints.json` and `progress.md` must be atomic (write to `.tmp` then rename) to prevent corruption on crash.

4. **Child process isolation.** Each agent runs in its own process with its own environment. No shared memory, no stdin communication after launch. The context file IS the input.

5. **Idempotent resume.** Running `aamf migrate --resume` multiple times should be safe. Completed phases/tasks are skipped. The same task is never executed twice (unless it failed and retries remain).

6. **Token budget as a circuit breaker.** If a token budget is set and exceeded, pause the migration (checkpoint current state) and inform the user. Do not silently continue.

7. **CLI-only agent execution.** The `agent-launcher` always spawns agents via the Copilot CLI (`copilot --agent <name>`). There is no API fallback mode.

## 15. README.md

The `runtime/README.md` should cover:

1. **What is AAMF** — one-paragraph summary
2. **Prerequisites** — Node.js 22+, API key or Copilot CLI
3. **Installation** — `npm install` in `runtime/`
4. **Configuration** — full `migration.config.json` reference with examples
5. **Usage** — `npx aamf migrate -c migration.config.json`, `--resume`, `--dry-run`, `status`, `reset`
6. **Architecture** — brief description of how the runtime relates to the agent prompts
7. **Progress Tracking** — where to look during a migration
8. **Troubleshooting** — common issues and solutions

## Summary of Deliverables

| # | File | Purpose |
|---|------|---------|
| 1 | `runtime/package.json` | Project manifest with all dependencies |
| 2 | `runtime/tsconfig.json` | TypeScript configuration |
| 3 | `runtime/src/index.ts` | CLI entry point |
| 4 | `runtime/src/config/schema.ts` | Zod config schema |
| 5 | `runtime/src/config/loader.ts` | Config loader/validator |
| 6 | `runtime/src/core/runtime.ts` | Top-level MigrationRuntime |
| 7 | `runtime/src/core/orchestrator.ts` | Phase sequencer |
| 8 | `runtime/src/core/agent-launcher.ts` | Child process spawner |
| 9 | `runtime/src/core/checkpoint.ts` | Checkpoint manager |
| 10 | `runtime/src/core/progress.ts` | progress.md writer |
| 11 | `runtime/src/core/phase-registry.ts` | Phase definitions |
| 12 | `runtime/src/agents/types.ts` | Agent type definitions |
| 13 | `runtime/src/agents/context-builder.ts` | Per-agent context file builder |
| 14 | `runtime/src/agents/result-parser.ts` | Agent output parser |
| 15 | `runtime/src/execution/serial-executor.ts` | Serial task runner |
| 16 | `runtime/src/execution/parallel-executor.ts` | Parallel task runner |
| 17 | `runtime/src/execution/task-queue.ts` | Dependency-aware queue |
| 18 | `runtime/src/execution/retry.ts` | Retry + failure-recovery escalation |
| 19 | `runtime/src/budget/token-tracker.ts` | Token usage tracking |
| 20 | `runtime/src/budget/cost-estimator.ts` | Cost estimation |
| 21 | `runtime/src/logging/logger.ts` | Structured logger |
| 22 | `runtime/src/logging/events.ts` | Event type definitions |
| 23 | `runtime/src/util/fs.ts` | File system helpers |
| 24 | `runtime/src/util/process.ts` | Child process helpers |
| 25 | `runtime/tests/*.test.ts` | Test suite |
| 26 | `runtime/README.md` | Documentation |

Build every file. The implementation should be complete and runnable — not stubs. Each module should be properly typed, exported, and importable by its dependents.

