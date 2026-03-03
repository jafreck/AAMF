import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CheckpointManager } from '../src/core/checkpoint.js';
import { Logger } from '../src/logging/logger.js';
import { fileExists, readJson } from '../src/util/fs.js';

describe('CheckpointManager', () => {
  let tempDir: string;
  let logger: Logger;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-test-'));
    logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    manager = new CheckpointManager(tempDir, logger);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create initial state on first load', async () => {
    const state = await manager.load('test-project');
    expect(state.projectName).toBe('test-project');
    expect(state.currentPhase).toBe(0);
    expect(state.completedPhases).toEqual([]);
    expect(state.completedTasks).toEqual([]);
    expect(state.version).toBe(1);
    expect(state.resumeCount).toBe(0);
  });

  it('should persist and reload state', async () => {
    const state = await manager.load('test-project');
    await manager.completePhase(1, '/output/phase1.md');
    
    // Create new manager, reload
    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.completedPhases).toContain(1);
    expect(reloaded.currentPhase).toBe(2);
    expect(reloaded.resumeCount).toBe(1); // incremented on reload
  });

  it('should track task completion', async () => {
    await manager.load('test-project');
    await manager.completeTask('task-001');
    await manager.completeTask('task-002');
    
    const state = manager.getState();
    expect(state.completedTasks).toContain('task-001');
    expect(state.completedTasks).toContain('task-002');
  });

  it('should track failed tasks', async () => {
    await manager.load('test-project');
    await manager.failTask('task-001', 'parity check failed', 1, false);
    
    const state = manager.getState();
    expect(state.failedTasks).toHaveLength(1);
    expect(state.failedTasks[0]?.taskId).toBe('task-001');
    expect(state.failedTasks[0]?.lastError).toBe('parity check failed');
  });

  it('should remove task from failed when completed', async () => {
    await manager.load('test-project');
    await manager.failTask('task-001', 'error', 1, false);
    await manager.completeTask('task-001');
    
    const state = manager.getState();
    expect(state.failedTasks).toHaveLength(0);
    expect(state.completedTasks).toContain('task-001');
  });

  it('should block tasks', async () => {
    await manager.load('test-project');
    await manager.blockTask('task-001');
    
    const state = manager.getState();
    expect(state.blockedTasks).toContain('task-001');
  });

  it('should track token usage', async () => {
    await manager.load('test-project');
    await manager.addTokenUsage('code-migrator', 4, 5000);
    await manager.addTokenUsage('code-migrator', 4, 3000);
    await manager.addTokenUsage('parity-verifier', 4, 2000);
    
    const state = manager.getState();
    expect(state.tokenUsage.total).toBe(10000);
    expect(state.tokenUsage.byAgent['code-migrator']).toBe(8000);
    expect(state.tokenUsage.byPhase[4]).toBe(10000);
  });

  it('should detect budget exceeded', async () => {
    await manager.load('test-project');
    await manager.addTokenUsage('agent', 1, 10000);
    
    expect(manager.isBudgetExceeded(5000)).toBe(true);
    expect(manager.isBudgetExceeded(20000)).toBe(false);
    expect(manager.isBudgetExceeded(undefined)).toBe(false);
  });

  it('should return correct resume point', async () => {
    await manager.load('test-project');
    await manager.completePhase(1, '/out/1');
    await manager.completePhase(2, '/out/2');
    await manager.setCurrentTask('task-005');
    
    const resume = manager.getResumePoint();
    expect(resume.phase).toBe(3);
    expect(resume.taskId).toBe('task-005');
  });

  it('should persist terminal exhaustion metadata', async () => {
    await manager.load('test-project');
    await manager.setTerminalExhaustion({
      reasonCode: 'task-retries-exhausted',
      taskId: 'task-001',
      check: 'code-migrator',
      summary: 'code-migrator failed after max retries',
    });

    const state = manager.getState();
    expect(state.terminalExhaustion?.reasonCode).toBe('task-retries-exhausted');
    expect(state.terminalExhaustion?.taskId).toBe('task-001');

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.terminalExhaustion?.reasonCode).toBe('task-retries-exhausted');
    expect(reloaded.terminalExhaustion?.check).toBe('code-migrator');
  });

  it('should default cumulativeDurationMs to 0 when field is absent in stored checkpoint (backward compat)', async () => {
    // Write a checkpoint without cumulativeDurationMs (simulating an old checkpoint)
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 2,
      currentTask: null,
      completedPhases: [1],
      completedTasks: ['task-001'],
      failedTasks: [],
      blockedTasks: [],
      phaseOutputs: {},
      tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
      startedAt: new Date().toISOString(),
      lastCheckpoint: new Date().toISOString(),
      resumeCount: 1,
      // cumulativeDurationMs intentionally omitted
    };
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.cumulativeDurationMs).toBe(0);
    expect(loaded.terminalExhaustion).toBeUndefined();
  });

  it('should initialize cumulativeDurationMs to 0 on fresh state and preserve on reload', async () => {
    const state = await manager.load('test-project');
    expect(state.cumulativeDurationMs).toBe(0);

    // Simulate accumulation then reload
    state.cumulativeDurationMs = 5000;
    await manager.save(state);

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.cumulativeDurationMs).toBe(5000);
  });

  it('should append durationMs to completedTaskDurationsMs when provided', async () => {
    await manager.load('test-project');
    await manager.completeTask('task-001', 1234);
    await manager.completeTask('task-002', 5678);

    const state = manager.getState();
    expect(state.completedTaskDurationsMs).toEqual([1234, 5678]);
  });

  it('should not append to completedTaskDurationsMs when durationMs is omitted', async () => {
    await manager.load('test-project');
    await manager.completeTask('task-001');

    const state = manager.getState();
    expect(state.completedTaskDurationsMs).toEqual([]);
  });

  it('should round-trip task duration through save and reload', async () => {
    await manager.load('test-project');
    await manager.completeTask('task-001', 9999);

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.completedTaskDurationsMs).toEqual([9999]);
  });

  it('should default completedTaskDurationsMs to [] when field is absent in stored checkpoint (backward compat)', async () => {
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 2,
      currentTask: null,
      completedPhases: [1],
      completedTasks: ['task-001'],
      failedTasks: [],
      blockedTasks: [],
      phaseOutputs: {},
      tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
      startedAt: new Date().toISOString(),
      lastCheckpoint: new Date().toISOString(),
      resumeCount: 1,
      cumulativeDurationMs: 0,
      // completedTaskDurationsMs intentionally omitted
    };
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.completedTaskDurationsMs).toEqual([]);
  });

  it('should write checkpoint atomically', async () => {    await manager.load('test-project');
    
    // Verify checkpoint file exists
    const exists = await fileExists(join(tempDir, 'state', 'checkpoint.json'));
    expect(exists).toBe(true);
    
    // Verify it's valid JSON
    const data = await readJson(join(tempDir, 'state', 'checkpoint.json'));
    expect(data).toBeDefined();
  });

  it('should remove task from blocked when completed', async () => {
    await manager.load('test-project');
    await manager.blockTask('task-001');
    await manager.completeTask('task-001');

    const state = manager.getState();
    expect(state.blockedTasks).not.toContain('task-001');
    expect(state.completedTasks).toContain('task-001');
  });

  it('should remove task from both failed and blocked when completed', async () => {
    await manager.load('test-project');
    await manager.failTask('task-001', 'some error', 1, false);
    await manager.blockTask('task-001');
    await manager.completeTask('task-001');

    const state = manager.getState();
    expect(state.failedTasks).toHaveLength(0);
    expect(state.blockedTasks).not.toContain('task-001');
    expect(state.completedTasks).toContain('task-001');
  });

  it('should not affect other blocked tasks when completing one', async () => {
    await manager.load('test-project');
    await manager.blockTask('task-001');
    await manager.blockTask('task-002');
    await manager.completeTask('task-001');

    const state = manager.getState();
    expect(state.blockedTasks).not.toContain('task-001');
    expect(state.blockedTasks).toContain('task-002');
    expect(state.completedTasks).toContain('task-001');
  });

  it('should handle completing a task that was never blocked', async () => {
    await manager.load('test-project');
    await manager.completeTask('task-001');

    const state = manager.getState();
    expect(state.blockedTasks).toHaveLength(0);
    expect(state.completedTasks).toContain('task-001');
  });

  // ─── metricsCount ─────────────────────────────────────────────────

  it('should initialize metricsCount to 0 on fresh state', async () => {
    const state = await manager.load('test-project');
    expect(state.metricsCount).toBe(0);
  });

  it('should preserve metricsCount on reload', async () => {
    const state = await manager.load('test-project');
    state.metricsCount = 42;
    await manager.save(state);

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.metricsCount).toBe(42);
  });

  it('should default metricsCount to 0 when field is absent in stored checkpoint (backward compat)', async () => {
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 2,
      currentTask: null,
      completedPhases: [1],
      completedTasks: ['task-001'],
      failedTasks: [],
      blockedTasks: [],
      phaseOutputs: {},
      tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
      startedAt: new Date().toISOString(),
      lastCheckpoint: new Date().toISOString(),
      resumeCount: 1,
      cumulativeDurationMs: 0,
      completedTaskDurationsMs: [],
      // metricsCount intentionally omitted
    };
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.metricsCount).toBe(0);
  });

  it('should default phase cursors when loading legacy checkpoint without phaseCursors (backward compat)', async () => {
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 4,
      currentTask: 'task-001',
      completedPhases: [1, 2, 3],
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
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.phaseCursors?.['4']?.tasks).toEqual({});
    expect(loaded.phaseCursors?.['5']?.iteration).toBe(0);
    expect(loaded.phaseCursors?.['6']?.completedAgents).toEqual([]);
    expect(loaded.phaseCursors?.['8']?.issueIndex).toBe(0);
  });

  it('should ignore existing checkpoint state on fresh load', async () => {
    const initial = await manager.load('test-project');
    initial.currentPhase = 6;
    initial.completedTasks = ['task-001'];
    await manager.save(initial);

    const fresh = await manager.load('test-project', { fresh: true });
    expect(fresh.currentPhase).toBe(0);
    expect(fresh.completedTasks).toEqual([]);
    expect(fresh.phaseCursors).toEqual({});
  });

  // ─── token persistence & resume merge ─────────────────────────────

  it('should persist token usage data across save and reload', async () => {
    const state = await manager.load('test-project');
    state.tokenUsage = {
      total: 15000,
      byPhase: { 1: 5000, 2: 10000 },
      byAgent: { 'code-migrator': 12000, 'parity-verifier': 3000 },
    };
    await manager.save(state);

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.tokenUsage.total).toBe(15000);
    expect(reloaded.tokenUsage.byPhase[1]).toBe(5000);
    expect(reloaded.tokenUsage.byPhase[2]).toBe(10000);
    expect(reloaded.tokenUsage.byAgent['code-migrator']).toBe(12000);
    expect(reloaded.tokenUsage.byAgent['parity-verifier']).toBe(3000);
  });

  it('should round-trip TokenTracker data through checkpoint save and reload', async () => {
    const { TokenTracker } = await import('../src/budget/token-tracker.js');

    // Build tracker state
    const tracker = new TokenTracker();
    tracker.record('agent-a', 1, 1000);
    tracker.record('agent-b', 2, 2000);
    tracker.record('agent-a', 2, 500);

    // Save to checkpoint
    const state = await manager.load('test-project');
    state.tokenUsage = tracker.toCheckpointData();
    await manager.save(state);

    // Reload and restore tracker
    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');

    const tracker2 = new TokenTracker();
    tracker2.loadFromCheckpoint(reloaded.tokenUsage);

    const data = tracker2.toCheckpointData();
    expect(data.total).toBe(3500);
    expect(data.byAgent['agent-a']).toBe(1500);
    expect(data.byAgent['agent-b']).toBe(2000);
    expect(data.byPhase[1]).toBe(1000);
    expect(data.byPhase[2]).toBe(2500);
  });

  // ─── phase0Fingerprint ───────────────────────────────────────────

  it('should initialize phase0Fingerprint to undefined on fresh state', async () => {
    const state = await manager.load('test-project');
    expect(state.phase0Fingerprint).toBeUndefined();
  });

  it('should preserve phase0Fingerprint on reload', async () => {
    const state = await manager.load('test-project');
    state.phase0Fingerprint = 'abc123';
    await manager.save(state);

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.phase0Fingerprint).toBe('abc123');
  });

  it('should default phase0Fingerprint to undefined when field is absent in stored checkpoint (backward compat)', async () => {
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 2,
      currentTask: null,
      completedPhases: [1],
      completedTasks: ['task-001'],
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
      // phase0Fingerprint intentionally omitted
    };
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.phase0Fingerprint).toBeUndefined();
  });

  it('should initialize adjudication waiver and event lists on fresh state', async () => {
    const state = await manager.load('test-project');
    expect(state.adjudicationWaivers).toEqual([]);
    expect(state.adjudicationEvents).toEqual([]);
  });

  it('should persist adjudication waiver and event records across reload', async () => {
    await manager.load('test-project');
    await manager.recordAdjudicationWaiver({
      issueFingerprint: 'fp-123',
      decision: 'false_positive',
      scope: 'task',
      expiresAt: '2099-01-01T00:00:00.000Z',
      taskId: 'task-001',
    });
    await manager.appendAdjudicationEvent({
      decision: 'false_positive',
      issueFingerprint: 'fp-123',
      scope: 'task',
      expiresAt: '2099-01-01T00:00:00.000Z',
      taskId: 'task-001',
      rationale: 'Known test harness mismatch',
      confidence: 'high',
      evidence: ['parity diff isolated to generated timestamps'],
    });

    const manager2 = new CheckpointManager(tempDir, logger);
    const reloaded = await manager2.load('test-project');
    expect(reloaded.adjudicationWaivers).toHaveLength(1);
    expect(reloaded.adjudicationWaivers?.[0]?.issueFingerprint).toBe('fp-123');
    expect(reloaded.adjudicationWaivers?.[0]?.scope).toBe('task');
    expect(reloaded.adjudicationWaivers?.[0]?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(reloaded.adjudicationEvents).toHaveLength(1);
    expect(reloaded.adjudicationEvents?.[0]?.decision).toBe('false_positive');
    expect(reloaded.adjudicationEvents?.[0]?.evidence).toEqual(['parity diff isolated to generated timestamps']);
  });

  it('should assign createdAt timestamps when adjudication records omit them', async () => {
    await manager.load('test-project');
    await manager.recordAdjudicationWaiver({
      issueFingerprint: 'fp-no-created-at',
      decision: 'false_positive',
    });
    await manager.appendAdjudicationEvent({
      decision: 'inconclusive',
    });

    const state = manager.getState();
    expect(state.adjudicationWaivers?.[0]?.createdAt).toBeDefined();
    expect(new Date(state.adjudicationWaivers?.[0]?.createdAt ?? '').toString()).not.toBe('Invalid Date');
    expect(state.adjudicationEvents?.[0]?.createdAt).toBeDefined();
    expect(new Date(state.adjudicationEvents?.[0]?.createdAt ?? '').toString()).not.toBe('Invalid Date');
  });

  it('should default adjudication fields for old checkpoints (backward compat)', async () => {
    const { writeJson } = await import('../src/util/fs.js');
    const oldState = {
      projectName: 'old-project',
      version: 1,
      currentPhase: 2,
      currentTask: null,
      completedPhases: [1],
      completedTasks: ['task-001'],
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
      // adjudicationWaivers/adjudicationEvents intentionally omitted
    };
    await writeJson(join(tempDir, 'checkpoint.json'), oldState);

    const manager3 = new CheckpointManager(tempDir, logger);
    const loaded = await manager3.load('old-project');
    expect(loaded.adjudicationWaivers).toEqual([]);
    expect(loaded.adjudicationEvents).toEqual([]);
  });
});
