import { describe, it, expect } from 'vitest';
import type { RuntimeEvent, LogEntry, LogLevel } from '../../src/logging/events.js';

// ─── RuntimeEvent ─────────────────────────────────────────────────────────────

describe('RuntimeEvent', () => {
  describe('phase-failed variant', () => {
    it('should construct with required fields: phase, name, error', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 2,
        name: 'code-migration',
        error: 'Agent exited with code 1',
      };
      expect(event.type).toBe('phase-failed');
      expect(event.phase).toBe(2);
      expect(event.name).toBe('code-migration');
      expect(event.error).toBe('Agent exited with code 1');
    });

    it('should have exitCode undefined when not provided', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 1,
        name: 'impact-assessment',
        error: 'timeout',
      };
      expect(event.exitCode).toBeUndefined();
    });

    it('should have stderr undefined when not provided', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 1,
        name: 'impact-assessment',
        error: 'timeout',
      };
      expect(event.stderr).toBeUndefined();
    });

    it('should carry exitCode when provided', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 3,
        name: 'parity-verification',
        error: 'non-zero exit',
        exitCode: 1,
      };
      expect(event.exitCode).toBe(1);
    });

    it('should carry stderr when provided', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 3,
        name: 'parity-verification',
        error: 'non-zero exit',
        stderr: 'Error: test failed\n  at suite.ts:42',
      };
      expect(event.stderr).toBe('Error: test failed\n  at suite.ts:42');
    });

    it('should support both exitCode and stderr together', () => {
      const event: RuntimeEvent = {
        type: 'phase-failed',
        phase: 4,
        name: 'code-migration',
        error: 'Agent crashed',
        exitCode: 2,
        stderr: 'Segmentation fault (core dumped)',
      };
      expect(event.exitCode).toBe(2);
      expect(event.stderr).toBe('Segmentation fault (core dumped)');
      expect(event.error).toBe('Agent crashed');
    });
  });

  describe('other event variants', () => {
    it('should construct migration-started event', () => {
      const event: RuntimeEvent = { type: 'migration-started', projectName: 'my-project' };
      expect(event.type).toBe('migration-started');
      expect(event.projectName).toBe('my-project');
    });

    it('should construct migration-completed event', () => {
      const event: RuntimeEvent = {
        type: 'migration-completed',
        projectName: 'my-project',
        success: true,
        duration: 12345,
      };
      expect(event.success).toBe(true);
      expect(event.duration).toBe(12345);
    });

    it('should construct phase-started event', () => {
      const event: RuntimeEvent = { type: 'phase-started', phase: 1, name: 'impact-assessment' };
      expect(event.phase).toBe(1);
      expect(event.name).toBe('impact-assessment');
    });

    it('should construct phase-completed event', () => {
      const event: RuntimeEvent = {
        type: 'phase-completed',
        phase: 1,
        name: 'impact-assessment',
        success: true,
        duration: 5000,
      };
      expect(event.success).toBe(true);
      expect(event.duration).toBe(5000);
    });

    it('should construct agent-launched event', () => {
      const event: RuntimeEvent = {
        type: 'agent-launched',
        agent: 'code-migrator',
        taskId: 'task-001',
        phase: 4,
      };
      expect(event.agent).toBe('code-migrator');
      expect(event.taskId).toBe('task-001');
    });

    it('should construct budget-warning event', () => {
      const event: RuntimeEvent = {
        type: 'budget-warning',
        usage: 80000,
        budget: 100000,
        percentage: 80,
      };
      expect(event.percentage).toBe(80);
    });

    it('should construct migration-interrupted event', () => {
      const event: RuntimeEvent = {
        type: 'migration-interrupted',
        reason: 'user cancelled',
      };
      expect(event.reason).toBe('user cancelled');
    });
  });
});

// ─── LogEntry ─────────────────────────────────────────────────────────────────

describe('LogEntry', () => {
  it('should construct with required fields', () => {
    const entry: LogEntry = {
      timestamp: '2026-02-25T06:35:52.843Z',
      level: 'info',
      source: 'orchestrator',
      message: 'Phase started',
    };
    expect(entry.level).toBe('info');
    expect(entry.source).toBe('orchestrator');
    expect(entry.phase).toBeUndefined();
    expect(entry.taskId).toBeUndefined();
    expect(entry.data).toBeUndefined();
  });

  it('should support all optional fields', () => {
    const entry: LogEntry = {
      timestamp: '2026-02-25T06:35:52.843Z',
      level: 'error',
      source: 'agent-launcher',
      phase: 3,
      taskId: 'task-007',
      message: 'Agent failed',
      data: { exitCode: 1 },
    };
    expect(entry.phase).toBe(3);
    expect(entry.taskId).toBe('task-007');
    expect(entry.data?.['exitCode']).toBe(1);
  });

  it('should accept all valid log levels', () => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    for (const level of levels) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        source: 'test',
        message: `Level: ${level}`,
      };
      expect(entry.level).toBe(level);
    }
  });
});
