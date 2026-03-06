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

  it('should support optional runId field', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'orchestrator',
      runId: 'run-abc-123',
      message: 'with runId',
    };
    expect(entry.runId).toBe('run-abc-123');
  });

  it('should support optional invocationId field', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'launcher',
      invocationId: 'inv-xyz-789',
      message: 'with invocationId',
    };
    expect(entry.invocationId).toBe('inv-xyz-789');
  });

  it('should support optional agent field', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'launcher',
      agent: 'code-migrator',
      message: 'with agent',
    };
    expect(entry.agent).toBe('code-migrator');
  });

  it('should support optional attempt field', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      source: 'retry-executor',
      attempt: 3,
      message: 'retrying',
    };
    expect(entry.attempt).toBe(3);
  });

  it('should support all new correlation fields together', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'orchestrator',
      phase: 4,
      taskId: 'task-001',
      runId: 'run-1',
      invocationId: 'inv-2',
      agent: 'code-migrator',
      attempt: 1,
      message: 'full correlation',
    };
    expect(entry.runId).toBe('run-1');
    expect(entry.invocationId).toBe('inv-2');
    expect(entry.agent).toBe('code-migrator');
    expect(entry.attempt).toBe(1);
    expect(entry.phase).toBe(4);
    expect(entry.taskId).toBe('task-001');
  });

  it('should leave new correlation fields undefined when not set', () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'test',
      message: 'minimal',
    };
    expect(entry.runId).toBeUndefined();
    expect(entry.invocationId).toBeUndefined();
    expect(entry.agent).toBeUndefined();
    expect(entry.attempt).toBeUndefined();
  });
});

// ─── New RuntimeEvent variants ────────────────────────────────────────────────

describe('RuntimeEvent — agent-queued', () => {
  it('should construct with required fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-queued',
      agent: 'code-migrator',
    };
    expect(event.type).toBe('agent-queued');
    expect(event.agent).toBe('code-migrator');
  });

  it('should support all optional fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-queued',
      agent: 'test-writer',
      taskId: 'task-005',
      phase: 4,
      runId: 'run-abc',
      invocationId: 'inv-def',
    };
    expect(event.taskId).toBe('task-005');
    expect(event.phase).toBe(4);
    expect(event.runId).toBe('run-abc');
    expect(event.invocationId).toBe('inv-def');
  });
});

describe('RuntimeEvent — agent-heartbeat', () => {
  it('should construct with required fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-heartbeat',
      agent: 'code-migrator',
      elapsedSeconds: 30,
    };
    expect(event.type).toBe('agent-heartbeat');
    expect(event.agent).toBe('code-migrator');
    expect(event.elapsedSeconds).toBe(30);
  });

  it('should support optional correlation fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-heartbeat',
      agent: 'parity-verifier',
      taskId: 'task-002',
      runId: 'run-1',
      invocationId: 'inv-1',
      elapsedSeconds: 120,
    };
    expect(event.taskId).toBe('task-002');
    expect(event.runId).toBe('run-1');
    expect(event.invocationId).toBe('inv-1');
  });
});

describe('RuntimeEvent — agent-output-file-detected', () => {
  it('should construct with required fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-output-file-detected',
      agent: 'code-migrator',
      file: '/tmp/output/task-001.ts',
    };
    expect(event.type).toBe('agent-output-file-detected');
    expect(event.file).toBe('/tmp/output/task-001.ts');
  });

  it('should support optional correlation fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-output-file-detected',
      agent: 'test-writer',
      taskId: 'task-003',
      runId: 'run-x',
      invocationId: 'inv-y',
      file: 'tests/foo.test.ts',
    };
    expect(event.runId).toBe('run-x');
    expect(event.invocationId).toBe('inv-y');
    expect(event.taskId).toBe('task-003');
  });
});

describe('RuntimeEvent — agent-timed-out', () => {
  it('should construct with required fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-timed-out',
      agent: 'code-migrator',
      timeout: 300000,
    };
    expect(event.type).toBe('agent-timed-out');
    expect(event.timeout).toBe(300000);
  });

  it('should support optional correlation fields', () => {
    const event: RuntimeEvent = {
      type: 'agent-timed-out',
      agent: 'parity-verifier',
      taskId: 'task-010',
      runId: 'run-z',
      invocationId: 'inv-w',
      timeout: 60000,
    };
    expect(event.runId).toBe('run-z');
    expect(event.invocationId).toBe('inv-w');
    expect(event.taskId).toBe('task-010');
  });
});

describe('RuntimeEvent — existing agent events with correlation fields', () => {
  it('should support runId and invocationId on agent-launched', () => {
    const event: RuntimeEvent = {
      type: 'agent-launched',
      agent: 'code-migrator',
      taskId: 'task-001',
      phase: 4,
      runId: 'run-a',
      invocationId: 'inv-b',
    };
    expect(event.runId).toBe('run-a');
    expect(event.invocationId).toBe('inv-b');
  });

  it('should support runId and invocationId on agent-completed', () => {
    const event: RuntimeEvent = {
      type: 'agent-completed',
      agent: 'test-writer',
      success: true,
      duration: 5000,
      runId: 'run-c',
      invocationId: 'inv-d',
    };
    expect(event.runId).toBe('run-c');
    expect(event.invocationId).toBe('inv-d');
  });

  it('should support runId and invocationId on agent-failed', () => {
    const event: RuntimeEvent = {
      type: 'agent-failed',
      agent: 'code-migrator',
      error: 'timeout',
      attempt: 2,
      runId: 'run-e',
      invocationId: 'inv-f',
    };
    expect(event.runId).toBe('run-e');
    expect(event.invocationId).toBe('inv-f');
  });

  it('should leave runId and invocationId undefined on agent-launched when not set', () => {
    const event: RuntimeEvent = {
      type: 'agent-launched',
      agent: 'code-migrator',
    };
    expect(event.runId).toBeUndefined();
    expect(event.invocationId).toBeUndefined();
  });
});

describe('RuntimeEvent — wave lifecycle variants', () => {
  it('should construct wave-started and wave-completed events', () => {
    const started: RuntimeEvent = { type: 'wave-started', wave: 1, taskIds: ['task-001', 'task-002'] };
    const completed: RuntimeEvent = { type: 'wave-completed', wave: 1, taskIds: ['task-001', 'task-002'], duration: 3200 };
    expect(started.wave).toBe(1);
    expect(started.taskIds).toEqual(['task-001', 'task-002']);
    expect(completed.duration).toBe(3200);
  });

  it('should construct barrier and convergence events', () => {
    const entered: RuntimeEvent = { type: 'wave-barrier-entered', wave: 2 };
    const released: RuntimeEvent = { type: 'wave-barrier-released', wave: 2, duration: 900 };
    const status: RuntimeEvent = {
      type: 'wave-convergence-status',
      wave: 2,
      iteration: 1,
      converged: false,
      remainingFailures: 3,
    };
    const limit: RuntimeEvent = { type: 'wave-convergence-limit-reached', wave: 2, maxIterations: 3, remainingFailures: 1 };
    expect(entered.wave).toBe(2);
    expect(released.duration).toBe(900);
    expect(status.converged).toBe(false);
    expect(limit.maxIterations).toBe(3);
  });
});

describe('RuntimeEvent — terminal-exhaustion', () => {
  it('should include terminal reason code with wave/task/check location context', () => {
    const event: RuntimeEvent = {
      type: 'terminal-exhaustion',
      reasonCode: 'task-retries-exhausted',
      wave: 3,
      taskId: 'task-014',
      check: 'build',
    };
    expect(event.type).toBe('terminal-exhaustion');
    expect(event.reasonCode).toBe('task-retries-exhausted');
    expect(event.wave).toBe(3);
    expect(event.taskId).toBe('task-014');
    expect(event.check).toBe('build');
  });

  it('should support reason-only payload when location context is unavailable', () => {
    const event: RuntimeEvent = {
      type: 'terminal-exhaustion',
      reasonCode: 'wave-convergence-exhausted',
    };
    expect(event.reasonCode).toBe('wave-convergence-exhausted');
    expect(event.wave).toBeUndefined();
    expect(event.taskId).toBeUndefined();
    expect(event.check).toBeUndefined();
  });
});

// ─── metric-recorded and report-generated ────────────────────────────────────

describe('RuntimeEvent — metric-recorded', () => {
  it('should construct with invocationId', () => {
    const event: RuntimeEvent = {
      type: 'metric-recorded',
      invocationId: 'inv-abc-123',
    };
    expect(event.type).toBe('metric-recorded');
    expect(event.invocationId).toBe('inv-abc-123');
  });
});

describe('RuntimeEvent — report-generated', () => {
  it('should construct with path', () => {
    const event: RuntimeEvent = {
      type: 'report-generated',
      path: 'reports/observability/index.md',
    };
    expect(event.type).toBe('report-generated');
    expect(event.path).toBe('reports/observability/index.md');
  });
});

describe('RuntimeEvent — model-routing-decision', () => {
  it('should construct with all required fields', () => {
    const event: RuntimeEvent = {
      type: 'model-routing-decision',
      taskId: 'task-001',
      tier: 'heavy',
      selectedModel: 'claude-opus-4.5',
      reason: 'complexity score 55 >= heavyThreshold 40',
      score: 55,
    };
    expect(event.type).toBe('model-routing-decision');
    expect(event.taskId).toBe('task-001');
    expect(event.tier).toBe('heavy');
    expect(event.selectedModel).toBe('claude-opus-4.5');
    expect(event.reason).toBe('complexity score 55 >= heavyThreshold 40');
    expect(event.score).toBe(55);
  });
});

// ─── task-replanned ──────────────────────────────────────────────────────────

describe('RuntimeEvent — task-replanned', () => {
  it('should construct with taskId and subtaskIds', () => {
    const event: RuntimeEvent = {
      type: 'task-replanned',
      taskId: 'task-003',
      subtaskIds: ['task-003a', 'task-003b'],
    };
    expect(event.type).toBe('task-replanned');
    expect(event.taskId).toBe('task-003');
    expect(event.subtaskIds).toEqual(['task-003a', 'task-003b']);
  });

  it('should support a single subtask', () => {
    const event: RuntimeEvent = {
      type: 'task-replanned',
      taskId: 'task-010',
      subtaskIds: ['task-010a'],
    };
    expect(event.subtaskIds).toHaveLength(1);
  });
});

// ─── subtasks-injected ───────────────────────────────────────────────────────

describe('RuntimeEvent — subtasks-injected', () => {
  it('should construct with parentTaskId, subtaskIds, and reason', () => {
    const event: RuntimeEvent = {
      type: 'subtasks-injected',
      parentTaskId: 'task-005',
      subtaskIds: ['task-005a', 'task-005b', 'task-005c'],
      reason: 'Repeated failures with overlapping issues',
    };
    expect(event.type).toBe('subtasks-injected');
    expect(event.parentTaskId).toBe('task-005');
    expect(event.subtaskIds).toEqual(['task-005a', 'task-005b', 'task-005c']);
    expect(event.reason).toBe('Repeated failures with overlapping issues');
  });

  it('should support an empty reason string', () => {
    const event: RuntimeEvent = {
      type: 'subtasks-injected',
      parentTaskId: 'task-001',
      subtaskIds: ['task-001a'],
      reason: '',
    };
    expect(event.reason).toBe('');
  });
});
