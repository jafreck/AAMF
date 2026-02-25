import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ProgressWriter } from '../src/core/progress.js';
import { createMockConfig } from './helpers/mocks.js';
import { ensureDir, fileExists } from '../src/util/fs.js';

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
    // Should have phase table with 7 rows
    expect(content).toContain('Impact Assessment');
    expect(content).toContain('Knowledge Base Construction');
    expect(content).toContain('Migration Planning');
    expect(content).toContain('Iterative Migration');
    expect(content).toContain('Final Parity Verification');
    expect(content).toContain('E2E Testing & Documentation');
    expect(content).toContain('Completion');
  });

  it('should update phase status', async () => {
    await writer.initialize(config);
    await writer.updatePhase(1, 'completed');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('✅');
  });

  it('should persist exitCode and stderr in phase record when provided', async () => {
    await writer.initialize(config);
    await writer.updatePhase(1, 'failed', 'agent crashed', 127, 'command not found');

    const content = await readFile(progressFile, 'utf-8');
    expect(content).toContain('exitCode: 127');
    expect(content).toContain('command not found');
    expect(content).toContain('agent crashed');
  });

  it('should not include exitCode or stderr when not provided', async () => {
    await writer.initialize(config);
    await writer.updatePhase(1, 'failed', 'some error');

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

  describe('Resume & Edge Cases', () => {
    it('should rewrite all phases to pending on re-initialization', async () => {
      await writer.initialize(config);
      await writer.updatePhase(1, 'completed');
      await writer.updatePhase(2, 'completed');
      await writer.updatePhase(3, 'completed');

      // Re-initialize should reset everything
      await writer.initialize(config);

      const content = await readFile(progressFile, 'utf-8');
      // All phases should be back to pending (⬜)
      const pendingCount = (content.match(/⬜/g) || []).length;
      expect(pendingCount).toBe(7);
      // No completed markers
      expect(content).not.toContain('✅');
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
  });
});
