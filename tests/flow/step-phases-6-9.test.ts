/**
 * Phase 6 — Final Parity Verification (step-level tests)
 * Phase 7 — E2E Testing & Documentation (step-level tests)
 * Phase 8 — Idiomatic Refactor (step-level tests)
 * Phase 9 — Completion (step-level tests)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { runFinalParityIteration, noFixesNeeded } from '../../src/flow/steps/final-parity.js';
import { launchE2eTestCrafter, launchE2eSuiteWriters, launchDocWriter } from '../../src/flow/steps/finalization.js';
import { runIdiomaticReviewIteration, noIdiomaticIssues } from '../../src/flow/steps/idiomatic-refactor.js';
import { finalizeAndReport } from '../../src/flow/steps/completion.js';
import {
  setupFlowTest,
  setupFlowTestWithTasks,
  createMockLauncher,
  createFailingLauncher,
  writeE2eTestPlan,
  DEFAULT_PLANNING_TASKS,
  SINGLE_AUTH_TASK,
} from '../helpers/flow-mocks.js';
import type { FlowTestEnv } from '../helpers/flow-mocks.js';

let env: FlowTestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

// ─── Phase 6 — Final Parity Verification ────────────────────────────────────

describe('runFinalParityIteration', () => {
  it('should return fixes: 0 when parity checker finds no issues', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'final-parity-checker') {
        return { extensions: { outputParsed: true, structuredOutput: { fixes: [] } } };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn);

    const result = await runFinalParityIteration(env.flowCtx);

    expect(result).toEqual({ fixes: 0 });
  });

  it('should return fixes count and launch code-migrator for each fix', async () => {
    let parityCallCount = 0;
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'final-parity-checker') {
        parityCallCount++;
        return {
          extensions: { outputParsed: true, structuredOutput: {
            fixes: [
              { description: 'Missing error handling', sourceFile: 'src/auth.py', targetFile: 'src/auth.ts' },
              { description: 'Wrong import', sourceFile: 'src/db.py', targetFile: 'src/db.ts' },
            ],
          } },
        };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn);

    const result = await runFinalParityIteration(env.flowCtx);

    expect(result.fixes).toBe(2);
    const codeMigratorInPhase6 = env.mockLauncher.invocations.filter(
      i => i.agent === 'code-migrator' && i.phase === 6,
    );
    expect(codeMigratorInPhase6).toHaveLength(2);
  });

  it('should resume from checkpoint fix index', async () => {
    let parityCallCount = 0;
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'final-parity-checker') {
        parityCallCount++;
        return {
          extensions: { outputParsed: true, structuredOutput: {
            fixes: [
              { description: 'fix a', sourceFile: 'src/a.py', targetFile: 'src/a.ts' },
              { description: 'fix b', sourceFile: 'src/b.py', targetFile: 'src/b.ts' },
            ],
          } },
        };
      }
      return {};
    });
    env = await setupFlowTestWithTasks(launcherFn);

    // Set cursor to indicate fix 0 was already done
    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['6'] = { iteration: 0, fixIndex: 1, lastSuccessfulStep: 'fix-started' };
    await env.checkpoint.save(state);

    await runFinalParityIteration(env.flowCtx);

    // Should only apply fix at index 1 (index 0 was already done)
    const fixTaskIds = env.mockLauncher.invocations
      .filter(i => i.agent === 'code-migrator' && i.phase === 6)
      .map(i => i.workItemId);
    expect(fixTaskIds).toContain('fix-0-1');
    expect(fixTaskIds).not.toContain('fix-0-0');
  });
});

describe('noFixesNeeded', () => {
  it('should return true when last iteration had zero fixes', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);
    // Mock getStepOutput to simulate framework providing the last iteration result
    (env.flowCtx as any).getStepOutput = () => ({ fixes: 0 });
    expect(noFixesNeeded(env.flowCtx)).toBe(true);
  });

  it('should return false when last iteration had fixes', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);
    (env.flowCtx as any).getStepOutput = () => ({ fixes: 3 });
    expect(noFixesNeeded(env.flowCtx)).toBe(false);
  });

  it('should return false when no step output exists (first call)', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);
    (env.flowCtx as any).getStepOutput = () => null;
    expect(noFixesNeeded(env.flowCtx)).toBe(false);
  });
});

// ─── Phase 7 — E2E Testing & Documentation ──────────────────────────────────

describe('launchE2eTestCrafter', () => {
  it('should invoke e2e-test-crafter agent', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await launchE2eTestCrafter(env.flowCtx);

    const crafterInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'e2e-test-crafter');
    expect(crafterInvocations).toHaveLength(1);
  });

  it('should skip when e2e-test-crafter is already completed in checkpoint', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['7'] = { completedAgents: ['e2e-test-crafter'], lastSuccessfulStep: 'completed-e2e-test-crafter' };
    await env.checkpoint.save(state);

    await launchE2eTestCrafter(env.flowCtx);

    expect(env.mockLauncher.invocations.filter(i => i.agent === 'e2e-test-crafter')).toHaveLength(0);
  });
});

describe('launchE2eSuiteWriters', () => {
  it('should fan out one test-writer per suite', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    // Need to write the test plan in the target output
    const outputPath = env.ctx.config.target.outputPath;
    await writeE2eTestPlan(outputPath, [
      { id: 'suite-001', name: 'Auth E2E' },
      { id: 'suite-002', name: 'API E2E' },
      { id: 'suite-003', name: 'UI E2E' },
    ]);

    await launchE2eSuiteWriters(env.flowCtx);

    const testWriterInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'test-writer');
    expect(testWriterInvocations).toHaveLength(3);
    const suiteIds = testWriterInvocations.map(i => i.workItemId);
    expect(suiteIds).toEqual(expect.arrayContaining(['suite-001', 'suite-002', 'suite-003']));
  });

  it('should skip completed suites on checkpoint resume', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn, {
      target: { language: 'typescript', outputPath: env?.tempDir ?? '/tmp/target' },
    });

    const outputPath = env.ctx.config.target.outputPath;
    await writeE2eTestPlan(outputPath, [
      { id: 'suite-001', name: 'Auth E2E' },
      { id: 'suite-002', name: 'API E2E' },
    ]);

    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['7'] = { completedAgents: ['e2e-test-crafter'], completedSuites: ['suite-001'], lastSuccessfulStep: 'completed-suite-suite-001' };
    await env.checkpoint.save(state);

    await launchE2eSuiteWriters(env.flowCtx);

    const suiteIds = env.mockLauncher.invocations
      .filter(i => i.agent === 'test-writer')
      .map(i => i.workItemId);
    expect(suiteIds).not.toContain('suite-001');
    expect(suiteIds).toContain('suite-002');
  });

  it('should succeed with zero suites when no plan exists', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    // No test plan file → zero suites
    await expect(launchE2eSuiteWriters(env.flowCtx)).resolves.toBeDefined();

    const testWriterInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'test-writer');
    expect(testWriterInvocations).toHaveLength(0);
  });
});

describe('launchDocWriter', () => {
  it('should invoke documentation-writer agent', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    await launchDocWriter(env.flowCtx);

    const docInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'documentation-writer');
    expect(docInvocations).toHaveLength(1);
  });

  it('should skip when documentation-writer is already completed', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['7'] = { completedAgents: ['documentation-writer'], completedSuites: [], lastSuccessfulStep: 'completed-documentation-writer' };
    await env.checkpoint.save(state);

    await launchDocWriter(env.flowCtx);

    expect(env.mockLauncher.invocations.filter(i => i.agent === 'documentation-writer')).toHaveLength(0);
  });
});

// ─── Phase 8 — Idiomatic Refactor ───────────────────────────────────────────

describe('runIdiomaticReviewIteration', () => {
  it('should return issues: 0 when no idiomatic issues found', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return { extensions: { outputParsed: true, structuredOutput: { issues: [] } } };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn);

    const result = await runIdiomaticReviewIteration(env.flowCtx);

    expect(result).toEqual({ issues: 0 });
    // No refactorer should have been invoked
    const refactorerInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'idiomatic-refactorer');
    expect(refactorerInvocations).toHaveLength(0);
  });

  it('should invoke idiomatic-refactorer for each issue found', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return {
          extensions: { outputParsed: true, structuredOutput: {
            issues: [
              { file: 'src/main.ts', issue: 'use const', suggestion: 'replace let with const' },
              { file: 'src/utils.ts', issue: 'use map', suggestion: 'replace for loop with map' },
            ],
          } },
        };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn);

    const result = await runIdiomaticReviewIteration(env.flowCtx);

    expect(result.issues).toBe(2);
    const refactorerInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'idiomatic-refactorer');
    expect(refactorerInvocations).toHaveLength(2);
  });

  it('should resume from checkpoint issue index', async () => {
    const launcherFn = createMockLauncher((inv) => {
      if (inv.agent === 'idiomatic-reviewer') {
        return {
          extensions: { outputParsed: true, structuredOutput: {
            issues: [
              { file: 'src/a.ts', issue: 'issue a', suggestion: 'fix a' },
              { file: 'src/b.ts', issue: 'issue b', suggestion: 'fix b' },
            ],
          } },
        };
      }
      return {};
    });
    env = await setupFlowTest(launcherFn);

    const state = env.checkpoint.getState();
    state.phaseCursors ??= {};
    state.phaseCursors['8'] = { iteration: 0, issueIndex: 1, currentFile: 'src/b.ts', lastSuccessfulStep: 'refactor-started' };
    await env.checkpoint.save(state);

    await runIdiomaticReviewIteration(env.flowCtx);

    const refactorerInvocations = env.mockLauncher.invocations.filter(i => i.agent === 'idiomatic-refactorer');
    expect(refactorerInvocations).toHaveLength(1);
  });
});

// ─── Phase 9 — Completion ───────────────────────────────────────────────────

describe('finalizeAndReport', () => {
  it('should return success with phase 9', async () => {
    const launcherFn = createMockLauncher();
    env = await setupFlowTest(launcherFn);

    const result = await finalizeAndReport(env.flowCtx);

    expect(result.phase).toBe(9);
    expect(result.name).toBe('Completion');
    expect(result.success).toBe(true);
  });
});
