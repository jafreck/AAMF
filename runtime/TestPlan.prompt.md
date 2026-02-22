# Prompt: Comprehensive Test Suite for AAMF Runtime

## Objective

Write a comprehensive test suite covering the **orchestrator** and **execution layer** modules of the AAMF runtime. These are the most critical untested modules — they coordinate all 7 migration phases, manage retries, parallelism, and context assembly. The test suite must use **mocked dependencies** (no real process spawning or LLM calls) and follow the existing test patterns in the project.

**Do NOT modify any production source files.** Only create new test files.

## Context

### Current Test Coverage

The following modules are **already well-tested** (do not duplicate):
- `CheckpointManager` — 10 tests (lifecycle, persistence, resume)
- `TaskQueue` — 9 tests (DAG scheduling, topo sort, checkpoint resume)
- `TokenTracker` — 7 tests (budget thresholds, serialization)
- `MigrationConfigSchema` — 6 tests (validation, defaults)
- `ResultParser` — 4 tests (plan parsing, token extraction)

### Modules That Need Tests

| Module | File | Lines | Priority |
|--------|------|-------|----------|
| `MigrationOrchestrator` | `src/core/orchestrator.ts` | 656 | **Critical** |
| `RetryExecutor` | `src/execution/retry.ts` | 108 | **High** |
| `ParallelExecutor` | `src/execution/parallel-executor.ts` | 55 | **High** |
| `SerialExecutor` | `src/execution/serial-executor.ts` | 33 | **Medium** |
| `ContextBuilder` | `src/agents/context-builder.ts` | 207 | **High** |
| `ProgressWriter` | `src/core/progress.ts` | 155 | **Medium** |

## Test Framework & Conventions

- **Framework:** Vitest (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`)
- **Module system:** ESM with `.js` extensions in imports (e.g., `'../src/core/orchestrator.js'`)
- **Temp directories:** Use `mkdtemp(join(tmpdir(), 'aamf-test-'))` and clean up in `afterEach`
- **Logger:** Create a silent logger for tests: `new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false })`
- **Task factory:** Reuse the `makeTask` pattern from `task-queue.test.ts`
- **File location:** All test files go in `runtime/tests/`

## Mocking Strategy

The orchestrator and execution modules depend on `AgentLauncher`, which spawns real processes. **All tests must mock the launcher** rather than spawning agents.

### Mock Agent Launcher

Create a configurable mock that returns predetermined `AgentResult` values:

```typescript
import { AgentInvocation, AgentResult, AgentName } from '../src/agents/types.js';

/** Create a mock launcher function that returns success by default. */
function createMockLauncher(
  overrides?: Partial<Record<AgentName, Partial<AgentResult>>> | ((inv: AgentInvocation) => Partial<AgentResult>),
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const base: AgentResult = {
      agent: inv.agent,
      taskId: inv.taskId,
      exitCode: 0,
      success: true,
      outputFiles: [],
      duration: 100,
      tokenUsage: { prompt: 500, completion: 200, total: 700 },
    };

    if (typeof overrides === 'function') {
      return { ...base, ...overrides(inv) };
    }
    if (overrides && overrides[inv.agent]) {
      return { ...base, ...overrides[inv.agent] };
    }
    return base;
  };
}

/** Create a mock launcher that fails for specific agents */
function createFailingLauncher(
  failAgents: AgentName[],
  errorMessage = 'Agent failed',
): (inv: AgentInvocation) => Promise<AgentResult> {
  return createMockLauncher((inv) =>
    failAgents.includes(inv.agent)
      ? { exitCode: 1, success: false, error: errorMessage }
      : {},
  );
}
```

### Mock AgentLauncher Class

For the orchestrator, which depends on `AgentLauncher` (the class, not just the function), create a mock wrapper:

```typescript
/** Minimal mock of AgentLauncher that delegates to a function */
class MockAgentLauncher {
  public invocations: AgentInvocation[] = [];
  constructor(private fn: (inv: AgentInvocation) => Promise<AgentResult>) {}
  async launchAgent(inv: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(inv);
    return this.fn(inv);
  }
}
```

Put shared mock utilities in `tests/helpers/mocks.ts` and import them in each test file.

---

## Test Files to Create

### 1. `tests/helpers/mocks.ts` — Shared mock utilities

Export:
- `createMockLauncher(overrides?)` — returns a mock launcher function
- `createFailingLauncher(failAgents, errorMessage?)` — returns a launcher that fails for specific agents
- `MockAgentLauncher` class — wraps a launcher function as a class with `.launchAgent()`
- `createMockConfig()` — returns a valid `MigrationConfig` object for testing
- `makeTask(id, deps?)` — task factory (same pattern as `task-queue.test.ts`)
- `createSilentLogger(tempDir)` — creates a silent logger

### 2. `tests/orchestrator.test.ts` — MigrationOrchestrator (REPLACE existing stub)

**Replace** the existing single-import test with a full behavioral suite.

#### Test Scenarios

**Phase Sequencing:**
- `should execute all 7 phases in order when all succeed`
  - Mock launcher returns success for every agent
  - Assert `result.success === true`, all 7 phase results present, phases ordered 1→7
- `should skip completed phases on resume`
  - Pre-populate checkpoint with phases 1–3 complete
  - Assert launcher is NOT called for phase 1–3 agents (impact-assessor, knowledge-builder, migration-planner)
  - Assert phases 4+ are executed
- `should execute only the specified phase when singlePhase is set`
  - Construct orchestrator with `singlePhase: 3`
  - Assert only phase 3 agents are invoked

**Critical Phase Failure:**
- `should abort migration when a critical phase fails (phase 1)`
  - Mock impact-assessor to fail
  - Assert `result.success === false`, only phase 1 in results, migration aborted
- `should abort migration when a critical phase fails (phase 4)`
  - Mock code-migrator to always fail
  - Assert migration stops, failed/blocked tasks recorded
- `should continue when a non-critical phase fails (phase 5)`
  - Mock final-parity-checker to fail
  - Assert migration continues through phases 6 and 7, `result.success` may still be false but no abort
- `should continue when a non-critical phase fails (phase 6)`
  - Mock e2e-test-crafter to fail
  - Assert phase 7 still executes

**Budget Management:**
- `should abort when token budget is exceeded`
  - Set config `tokenBudget: 1000`, mock agents to report 600 tokens each
  - Assert migration stops after budget exceeded, checkpoint saved
- `should log warning at 80% budget threshold`
  - Set `tokenBudget: 1000`, mock agent returning 850 tokens
  - Assert warning event logged (via spy on logger)

**Phase 4 Specifics:**
- `should process migration tasks from plan`
  - Write a `migration-plan.md` fixture file to the progress directory before running phase 4
  - Assert code-migrator invoked for each task, tasks completed
- `should handle empty migration plan gracefully`
  - Write an empty plan
  - Assert phase 4 succeeds with no tasks
- `should fail phase 4 when migration-plan.md is missing`
  - Don't write a plan file
  - Assert phase 4 fails with descriptive error
- `should block tasks that fail after max retries`
  - Mock code-migrator to always fail for a specific task
  - Assert task is marked blocked, other tasks continue

**Phase 5 Loop-back:**
- `should re-run code-migrator when parity issues found`
  - Write a parity report with issues after first parity check
  - Assert code-migrator is re-invoked for fixes
- `should stop loop-back after MAX_LOOPBACK iterations`
  - Write parity reports that always have issues
  - Assert at most 3 parity checker invocations (initial + 2 loop-backs)

**MigrationError:**
- `should construct MigrationError with phase and result details`
- `should have correct name property ('MigrationError')`

#### Setup Pattern

```typescript
// Each test:
// 1. Create temp dir
// 2. Create silent logger
// 3. Create real CheckpointManager (uses temp dir)
// 4. Create real ProgressWriter (uses temp dir)
// 5. Create MockAgentLauncher with scenario-specific behavior
// 6. Create real ContextBuilder (writes to temp dir)
// 7. Construct MigrationOrchestrator with these dependencies
// 8. Call orchestrator.run()
// 9. Assert on MigrationResult, checkpoint state, and launcher invocations
```

For tests that need Phase 4, write a `migration-plan.md` to `{tempDir}/migration-plan.md` before running. Use the format from `tests/fixtures/sample-migration-plan.md`.

For tests that need Phase 5, write a `final-parity-report.md` with fix entries. The mock launcher for `final-parity-checker` should succeed, and then the test writes the report file during the mock invocation.

### 3. `tests/retry-executor.test.ts` — RetryExecutor

#### Test Scenarios

**Basic Retry:**
- `should return immediately on first success`
  - Assert `result.attempts === 1`, `result.recoveryAttempted === false`
- `should retry up to maxAttempts times`
  - Fail twice, succeed on attempt 3 (maxAttempts=3)
  - Assert `result.attempts === 3`, `result.success === true`
- `should fail after exhausting all retries`
  - Always fail (maxAttempts=3)
  - Assert `result.attempts === 3`, `result.success === false`

**Backoff:**
- `should wait between retry attempts`
  - Use `vi.useFakeTimers()` or measure elapsed time
  - Assert delay increases between attempts (exponential pattern)
- `should respect maxDelayMs cap`
  - Set `initialDelayMs: 1000, maxDelayMs: 2000, maxAttempts: 5`
  - Assert no delay exceeds 2000ms

**Callbacks:**
- `should call onRetry after each failed attempt`
  - Track calls via `vi.fn()`
  - Assert called with correct attempt number and error string
- `should NOT call onRetry after the final attempt`
  - maxAttempts=2, always fail
  - Assert onRetry called once (after attempt 1, not after attempt 2)

**Recovery Escalation:**
- `should call onExhausted when retries are exhausted`
  - Always fail, provide onExhausted that returns a recovery invocation
  - Assert recovery invocation is launched
- `should retry original after successful recovery`
  - Fail all retries, recovery succeeds, then original succeeds
  - Assert `result.attempts === maxAttempts + 1`, `result.recoveryAttempted === true`
- `should return failure when recovery also fails`
  - Both original and recovery always fail
  - Assert `result.success === false`, `result.recoveryAttempted === true`
- `should skip recovery when onExhausted returns null`
  - onExhausted returns null
  - Assert recovery NOT attempted, result is the last failed attempt
- `should skip recovery when invocation has no taskId`
  - Invocation without taskId, always fail
  - Assert onExhausted NOT called

### 4. `tests/parallel-executor.test.ts` — ParallelExecutor

#### Test Scenarios

- `should execute all invocations and return results in order`
  - 3 invocations, all succeed
  - Assert 3 results returned in same order as input
- `should respect concurrency limit`
  - Set concurrency=1, 3 invocations with measurable delay
  - Assert invocations execute sequentially (not overlapping)
  - Try concurrency=2 and verify partial overlap
- `should handle mixed success/failure`
  - 3 invocations: success, fail, success
  - Assert all 3 results returned, middle one has `success: false`
- `should catch exceptions from launcher and return error result`
  - Launcher throws an Error for one invocation
  - Assert that invocation returns `success: false` with error message, others unaffected
- `should handle empty invocation list`
  - Pass empty array
  - Assert empty results array returned

### 5. `tests/serial-executor.test.ts` — SerialExecutor

#### Test Scenarios

- `should execute invocations in order and return results`
  - 3 invocations, all succeed
  - Assert results returned in input order
- `should continue executing after a failure`
  - 3 invocations, second fails
  - Assert all 3 results returned (including the failure)
- `should handle empty invocation list`
  - Assert empty results array

### 6. `tests/context-builder.test.ts` — ContextBuilder

#### Test Scenarios

**Context File Creation:**
- `should write context JSON to the contexts directory`
  - Call `buildContext('impact-assessor', 1)`
  - Assert file exists in `{progressDir}/contexts/`, is valid JSON
- `should include correct base fields in context`
  - Assert `agent`, `projectName`, `phase`, `config.source`, `config.target` are set correctly
- `should include optional taskId when provided`
  - Call with taskId
  - Assert `taskId` field present in written JSON

**Per-Agent File Routing (test each agent type gets correct inputs/outputs):**
- `should route impact-assessor to source path and impact-assessment.md`
- `should route knowledge-builder to source + impact assessment, output to KB dir`
  - Assert payload includes `largeFileThreshold`
- `should route large-file-analyzer to specific file path from payload`
- `should route migration-planner to KB index + impact assessment`
- `should route adjudicator to competing strategies file`
- `should route code-migrator with task-specific source/target files`
- `should route parity-verifier to source + target files`
- `should route test-writer to target file + KB entry`
- `should route failure-recovery to failure report + source/target`
- `should route final-parity-checker to source + output + plan`
- `should route e2e-test-crafter to KB architecture docs`
- `should route documentation-writer to KB + plan + parity report`
- `should use default routing for unknown/orchestrator agents`

### 7. `tests/progress-writer.test.ts` — ProgressWriter

#### Test Scenarios

- `should create progress.md on initialize`
  - Call `initialize(config)`
  - Assert file exists and contains project name, phase table with 7 rows
- `should update phase status`
  - Call `updatePhase(1, 'completed')`
  - Assert file contains ✅ for phase 1
- `should track task progress with progress bar`
  - Set totalTasks, update several tasks
  - Assert file contains progress bar and correct percentage
- `should append timestamped events`
  - Call `appendEvent('test event')`
  - Assert event log section contains the event with ISO timestamp
- `should list failed and blocked tasks`
  - Update tasks with 'failed' and 'blocked' status
  - Assert file has Failed Tasks and Blocked Tasks sections
- `should limit event log to last 50 entries`
  - Append 60 events
  - Assert only last 50 appear in output
- `should write finalization summary`
  - Call `finalize` with success result
  - Assert file contains completion event

---

## Execution

After creating all test files, run:

```bash
cd runtime && npx vitest run
```

All new tests must pass alongside the existing 38 tests. Target: **70+ new tests** across the new files.

## Important Notes

1. The orchestrator tests are the highest priority. They validate the entire migration pipeline logic.
2. Use `vi.fn()` and `vi.spyOn()` for tracking call counts and arguments.
3. For backoff tests, either mock `setTimeout` with fake timers or set `initialDelayMs: 0` to keep tests fast.
4. The `ContextBuilder` writes real files — use temp directories and clean up.
5. For Phase 4 orchestrator tests, you need to write a `migration-plan.md` in the temp progress directory. Use the format from `tests/fixtures/sample-migration-plan.md`.
6. All filesystem operations in `ContextBuilder` and `ProgressWriter` are real (not mocked) — they write to temp dirs. This is intentional and matches the existing `CheckpointManager` test pattern.
