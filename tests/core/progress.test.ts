import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ProgressWriter } from '../../src/core/progress.js';
import { createMockConfig } from '../helpers/mocks.js';
import { ensureDir, fileExists } from '../../src/util/fs.js';

describe('ProgressWriter', () => {
  let tempDir: string;
  let progressDir: string;
  let progressFile: string;
  let writer: ProgressWriter;
  let config: ReturnType<typeof createMockConfig>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-progress-test-'));
    progressDir = join(tempDir, 'progress');
    await ensureDir(progressDir);
    progressFile = join(progressDir, 'progress.md');
    writer = new ProgressWriter(progressFile);
    config = createMockConfig();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create progress.md on initialize', async () => {
    await writer.initialize(config);

    expect(await fileExists(progressFile)).toBe(true);
    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('test-project');
    // Should have phase table with 6 rows
    expect(content).toContain('Knowledge Base Construction');
    expect(content).toContain('Migration Planning');
    expect(content).toContain('Iterative Migration');
    expect(content).toContain('Final Parity Verification');
    expect(content).toContain('E2E Testing & Documentation');
    expect(content).toContain('Completion');
  });

  it('should update phase status', async () => {
    await writer.initialize(config);
    await writer.updatePhase(2, 'completed');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('✅');
  });

  it('should persist exitCode and stderr in phase record when provided', async () => {
    await writer.initialize(config);
    await writer.updatePhase(2, 'failed', 'agent crashed', 127, 'command not found');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('exitCode: 127');
    expect(content).toContain('command not found');
    expect(content).toContain('agent crashed');
  });

  it('should not include exitCode or stderr when not provided', async () => {
    await writer.initialize(config);
    await writer.updatePhase(2, 'failed', 'some error');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('some error');
    expect(content).not.toContain('exitCode:');
  });

  it('should track task progress with progress bar', async () => {
    await writer.initialize(config);
    writer.setTotalTasks(10);
    await writer.updateTask('task-001', 'completed');
    await writer.updateTask('task-002', 'completed');
    await writer.updateTask('task-003', 'in-progress');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Task Progress');
    // 2 completed out of 10 = 20%
    expect(content).toContain('20%');
    expect(content).toContain('2/10');
  });

  it('should append timestamped events', async () => {
    await writer.initialize(config);
    await writer.appendEvent('test event happened');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Event Log');
    expect(content).toContain('test event happened');
    // Should have ISO timestamp
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });

  it('should list failed and blocked tasks', async () => {
    await writer.initialize(config);
    writer.setTotalTasks(5);
    await writer.updateTask('task-001', 'failed', { error: 'something broke' });
    await writer.updateTask('task-002', 'blocked', { error: 'max retries exceeded' });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Failed Tasks');
    expect(content).toContain('task-001');
    expect(content).toContain('something broke');
    expect(content).toContain('Blocked Tasks');
    expect(content).toContain('task-002');
  });

  it('should limit event log to last 50 entries', async () => {
    await writer.initialize(config);

    for (let i = 0; i < 60; i++) {
      await writer.appendEvent(`event-${i}`);
    }

    const content = await readFile(progressFile, 'utf-8');
    // First 10 events (0-9) should not be present
    expect(content).not.toContain('event-0]');
    expect(content).not.toContain('event-9]');
    // Last events should be present
    expect(content).toContain('event-59');
    expect(content).toContain('event-50');
  });

  it('should write finalization summary', async () => {
    await writer.initialize(config);
    await writer.finalize({
      success: true,
      failedTasks: [],
      blockedTasks: [],
      totalDuration: 5000,
    });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('completed successfully');
  });

  it('should render wave lifecycle milestones', async () => {
    await writer.initialize(config);
    await writer.setWavePlan([
      ['task-001', 'task-002'],
      ['task-003'],
      ['task-004'],
    ]);
    await writer.appendWaveLifecycle({ wave: 1, milestone: 'started' });
    await writer.appendWaveLifecycle({
      wave: 1,
      milestone: 'convergence',
      iteration: 2,
      converged: false,
      remainingFailures: 1,
    });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Wave Plan');
    expect(content).toContain('Planned waves:** 3');
    expect(content).toContain('Started waves:** 1');
    expect(content).toContain('| 0 | 2 | task-001, task-002 |');
    expect(content).toContain('| 1 | 1 | task-003 |');
    expect(content).toContain('Wave Lifecycle');
    expect(content).toContain('| 1 | started |  |');
    expect(content).toContain('iteration=2');
    expect(content).toContain('remainingFailures=1');
  });

  it('should render retry-target and terminal exhaustion metadata', async () => {
    await writer.initialize(config);
    await writer.appendRetryTarget({
      scope: 'command',
      attempt: 2,
      maxAttempts: 3,
      taskId: 'task-001',
      check: 'build',
      summary: 'build command failed',
    });
    await writer.setTerminalExhaustion({
      reasonCode: 'command-recovery-exhausted',
      taskId: 'task-001',
      check: 'build',
      summary: 'build command failed after retries',
    });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Retry Targets');
    expect(content).toContain('| command | 2/3 | task-001 |');
    expect(content).toContain('Terminal Exhaustion');
    expect(content).toContain('command-recovery-exhausted');
    expect(content).toContain('build command failed after retries');
  });

  it('should render adjudication events for auditability', async () => {
    await writer.initialize(config);
    await writer.appendAdjudicationEvent({
      decision: 'false_positive',
      issueFingerprint: 'fp-123',
      scope: 'task',
      expiresAt: '2099-01-01T00:00:00.000Z',
      taskId: 'task-001',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Adjudication Events');
    expect(content).toContain('false_positive');
    expect(content).toContain('fp-123');
    expect(content).toContain('2099-01-01T00:00:00.000Z');
  });

  it('should render adjudication events with blank optional metadata', async () => {
    await writer.initialize(config);
    await writer.appendAdjudicationEvent({
      decision: 'inconclusive',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Adjudication Events');
    expect(content).toContain('| 2026-01-02T00:00:00.000Z | inconclusive |  |  |  |  |');
  });

  it('should not show cumulative duration line on a fresh run (equal to elapsed)', async () => {
    await writer.initialize(config);
    // cumulativeDurationMs is 0 by default; elapsed is also ~0, so no cumulative line
    const content = await readFile(progressFile, 'utf-8');
    expect(content).not.toContain('Total Cumulative Duration');
  });

  it('should show cumulative duration line when it exceeds current session elapsed', async () => {
    await writer.initialize(config);
    // Simulate a resumed run where prior runs added 60 seconds
    writer.setCumulativeDuration(60_000);
    await writer.appendEvent('resumed');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('Total Cumulative Duration');
    expect(content).toContain('1m 0s');
  });

  describe('Resume & Edge Cases', () => {
    it('should rewrite all phases to pending on re-initialization', async () => {
      await writer.initialize(config);
      await writer.updatePhase(2, 'completed');
      await writer.updatePhase(3, 'completed');
      await writer.updatePhase(4, 'completed');

      // Re-initialize should reset everything
      await writer.initialize(config);

      const content = await readFile(progressFile, 'utf-8');
      // All phases should be back to pending (⬜)
      const pendingCount = (content.match(/⬜/g) || []).length;
      expect(pendingCount).toBe(6);
      // No completed markers
      expect(content).not.toContain('✅');
    });

    it('should clear retry and terminal metadata on re-initialization', async () => {
      await writer.initialize(config);
      await writer.appendRetryTarget({
        scope: 'task',
        attempt: 1,
        maxAttempts: 2,
        taskId: 'task-001',
        check: 'code-migrator',
        summary: 'id=retry-before-reset',
      });
      await writer.setTerminalExhaustion({
        reasonCode: 'task-retries-exhausted',
        taskId: 'task-001',
        check: 'code-migrator',
        summary: 'terminal-before-reset',
      });
      await writer.initialize(config);

      const content = await readFile(progressFile, 'utf-8');
      expect(content).not.toContain('Retry Targets');
      expect(content).not.toContain('id=retry-before-reset');
      expect(content).not.toContain('Terminal Exhaustion');
      expect(content).not.toContain('terminal-before-reset');
    });

    it('should handle concurrent appendEvent calls', async () => {
      await writer.initialize(config);

      // Fire 10 rapid appendEvent calls sequentially (the implementation
      // serializes through atomicWrite so concurrent calls would race)
      for (let i = 0; i < 10; i++) {
        await writer.appendEvent(`concurrent-${i}`);
      }

      const content = await readFile(progressFile, 'utf-8');
      for (let i = 0; i < 10; i++) {
        expect(content).toContain(`concurrent-${i}`);
      }
    });

    it('should truncate event log at 50 entries', async () => {
      await writer.initialize(config);

      for (let i = 0; i < 60; i++) {
        await writer.appendEvent(`trunc-event-${i}`);
      }

      const content = await readFile(progressFile, 'utf-8');
      // First 10 events (0-9) should be truncated
      expect(content).not.toContain('trunc-event-0]');
      expect(content).not.toContain('trunc-event-9]');
      // Events 10-59 should remain
      expect(content).toContain('trunc-event-10');
      expect(content).toContain('trunc-event-59');
    });

    it('should truncate retry targets to the last 100 entries', async () => {
      await writer.initialize(config);

      for (let i = 0; i < 105; i++) {
        await writer.appendRetryTarget({
          scope: 'command',
          attempt: i + 1,
          maxAttempts: 105,
          taskId: 'task-001',
          check: 'build',
          summary: `id=retry-${i}`,
        });
      }

      const content = await readFile(progressFile, 'utf-8');
      expect(content).not.toContain('| command | 1/105 |');
      expect(content).not.toContain('| command | 5/105 |');
      expect(content).toContain('| command | 6/105 |');
      expect(content).toContain('| command | 105/105 |');
    });
  });

  describe('Token Usage Breakdown', () => {
    it('should render per-phase and per-agent token breakdowns in progress.md', async () => {
      await writer.initialize(config);
      writer.setTokenUsage({
        total: 15000,
        byPhase: { 1: 5000, 2: 10000 },
        byAgent: { 'code-migrator': 12000, 'parity-verifier': 3000 },
      });
      await writer.appendEvent('token update');

      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('## Token Usage');
      expect(content).toContain('**Total:** 15,000 tokens');
      expect(content).toContain('### By Phase');
      expect(content).toContain('5,000');
      expect(content).toContain('10,000');
      expect(content).toContain('### By Agent');
      expect(content).toContain('code-migrator');
      expect(content).toContain('12,000');
      expect(content).toContain('parity-verifier');
      expect(content).toContain('3,000');
    });

    it('should not render Token Usage section when no breakdown data exists', async () => {
      await writer.initialize(config);
      writer.setTokenUsage({ total: 0, byPhase: {}, byAgent: {} });
      await writer.appendEvent('no tokens yet');

      const content = await readFile(progressFile, 'utf-8');
      expect(content).not.toContain('## Token Usage');
      expect(content).not.toContain('### By Phase');
      expect(content).not.toContain('### By Agent');
    });
  });

  describe('reconstructFromCheckpoint', () => {
    it('should restore full token breakdown (total, byPhase, byAgent) from checkpoint state', async () => {
      await writer.initialize(config);
      const state = {
        projectName: 'test-project',
        version: 1,
        currentPhase: 3,
        currentTask: null,
        completedPhases: [1, 2],
        completedTasks: ['task-001'],
        failedTasks: [],
        blockedTasks: [],
        phaseOutputs: {},
        tokenUsage: {
          total: 25000,
          byPhase: { 1: 10000, 2: 15000 },
          byAgent: { 'issue-analyst': 10000, 'code-migrator': 15000 },
        },
        startedAt: new Date().toISOString(),
        lastCheckpoint: new Date().toISOString(),
        resumeCount: 1,
        cumulativeDurationMs: 0,
        completedTaskDurationsMs: [],
        metricsCount: 0,
      };

      writer.reconstructFromCheckpoint(state);
      await writer.appendEvent('resumed');

      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('## Token Usage');
      expect(content).toContain('**Total:** 25,000 tokens');
      expect(content).toContain('### By Phase');
      expect(content).toContain('10,000');
      expect(content).toContain('15,000');
      expect(content).toContain('### By Agent');
      expect(content).toContain('issue-analyst');
      expect(content).toContain('code-migrator');
    });

    it('should mark completed phases and current phase correctly', async () => {
      await writer.initialize(config);
      const state = {
        projectName: 'test-project',
        version: 1,
        currentPhase: 4,
        currentTask: null,
        completedPhases: [2, 3],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        phaseOutputs: {},
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        startedAt: new Date().toISOString(),
        lastCheckpoint: new Date().toISOString(),
        resumeCount: 1,
        cumulativeDurationMs: 0,
        completedTaskDurationsMs: [],
        metricsCount: 0,
      };

      writer.reconstructFromCheckpoint(state);
      await writer.appendEvent('resumed');

      const content = await readFile(progressFile, 'utf-8');
      // 2 completed phases
      const completedCount = (content.match(/✅/g) || []).length;
      expect(completedCount).toBe(2);
      // 1 in-progress phase
      expect(content).toContain('🔄');
    });

    it('should restore and render adjudication events from checkpoint state', async () => {
      await writer.initialize(config);
      const state = {
        projectName: 'test-project',
        version: 1,
        currentPhase: 4,
        currentTask: null,
        completedPhases: [2, 3],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        phaseOutputs: {},
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        startedAt: new Date().toISOString(),
        lastCheckpoint: new Date().toISOString(),
        resumeCount: 1,
        cumulativeDurationMs: 0,
        completedTaskDurationsMs: [],
        metricsCount: 0,
        adjudicationEvents: [
          {
            decision: 'false_positive',
            issueFingerprint: 'fp-xyz',
            scope: 'task',
            expiresAt: '2099-01-01T00:00:00.000Z',
            taskId: 'task-007',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      writer.reconstructFromCheckpoint(state);
      await writer.appendEvent('resumed');

      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('Adjudication Events');
      expect(content).toContain('fp-xyz');
      expect(content).toContain('task-007');
    });

    it('should restore terminal exhaustion metadata from checkpoint state', async () => {
      await writer.initialize(config);
      const state = {
        projectName: 'test-project',
        version: 1,
        currentPhase: 5,
        currentTask: null,
        completedPhases: [2, 3, 4],
        completedTasks: ['task-001'],
        failedTasks: [],
        blockedTasks: [],
        phaseOutputs: {},
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        startedAt: new Date().toISOString(),
        lastCheckpoint: new Date().toISOString(),
        resumeCount: 2,
        cumulativeDurationMs: 0,
        completedTaskDurationsMs: [],
        metricsCount: 0,
        terminalExhaustion: {
          reasonCode: 'wave-convergence-exhausted',
          wave: 3,
          check: 'wave-validation',
          summary: 'wave failed to converge',
        },
      };

      writer.reconstructFromCheckpoint(state);
      await writer.appendEvent('resumed');

      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('Terminal Exhaustion');
      expect(content).toContain('wave-convergence-exhausted');
      expect(content).toContain('**wave:** 3');
      expect(content).toContain('wave failed to converge');
    });
  });
});
