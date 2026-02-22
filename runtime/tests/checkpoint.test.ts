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
    expect(state.currentPhase).toBe(1);
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

  it('should write checkpoint atomically', async () => {
    await manager.load('test-project');
    
    // Verify checkpoint file exists
    const exists = await fileExists(join(tempDir, 'checkpoint.json'));
    expect(exists).toBe(true);
    
    // Verify it's valid JSON
    const data = await readJson(join(tempDir, 'checkpoint.json'));
    expect(data).toBeDefined();
  });
});
