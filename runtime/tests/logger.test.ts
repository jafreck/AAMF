import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Logger } from '../src/logging/logger.js';

describe('Logger', () => {
  let tempDir: string;
  let logDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-logger-test-'));
    logDir = join(tempDir, 'logs');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create migration.log on first log and flush', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.info('hello');
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('hello');
  });

  it('should filter messages below configured level', async () => {
    const logger = new Logger({ logDir, level: 'warn', console: false });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const levels = lines.map(l => JSON.parse(l).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('should produce log entries with correct structure', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.info('structured');
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('level');
    expect(entry).toHaveProperty('source');
    expect(entry).toHaveProperty('message');
    // timestamp should be ISO format
    expect(() => new Date(entry.timestamp)).not.toThrow();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should include phase and taskId context in log entries', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setPhase(4);
    logger.setTaskId('task-001');
    logger.info('with context');
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry.phase).toBe(4);
    expect(entry.taskId).toBe('task-001');
  });

  it('should log typed events via event() method', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.event({ type: 'phase-started', phase: 3, name: 'Knowledge Base Construction' });
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry.message).toBe('phase-started');
    expect(entry.data).toBeDefined();
    expect(entry.data.phase).toBe(3);
    expect(entry.data.name).toBe('Knowledge Base Construction');
  });

  it('should create a child logger that inherits config', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    const child = logger.child('agent-x');
    child.info('child message');
    await child.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry.source).toBe('agent-x');
  });

  it('should create separate agent log file via writeAgentLog', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    await logger.writeAgentLog('code-migrator', 'task-001', 'agent output content');

    const files = await readdir(logDir);
    const agentLog = files.find(f => f.startsWith('code-migrator-task-001-') && f.endsWith('.log'));
    expect(agentLog).toBeDefined();

    const content = await readFile(join(logDir, agentLog!), 'utf-8');
    expect(content).toBe('agent output content');
  });

  it('should flush all pending writes', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    for (let i = 0; i < 5; i++) {
      logger.info(`message-${i}`);
    }
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(JSON.parse(lines[i]!).message).toBe(`message-${i}`);
    }
  });

  it('should not call console.log when console is disabled', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new Logger({ logDir, level: 'info', console: false });
      logger.info('silent');
      await logger.flush();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // ─── New correlation context setters ───────────────────────────────────────

  it('should include runId in log entries when set', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setRunId('run-abc');
    logger.info('with runId');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.runId).toBe('run-abc');
  });

  it('should include invocationId in log entries when set', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setInvocationId('inv-xyz');
    logger.info('with invocationId');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.invocationId).toBe('inv-xyz');
  });

  it('should include agent in log entries when set', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setAgent('code-migrator');
    logger.info('with agent');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.agent).toBe('code-migrator');
  });

  it('should include attempt in log entries when set', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setAttempt(2);
    logger.info('with attempt');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.attempt).toBe(2);
  });

  it('should omit correlation fields from log entries when not set', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.info('no correlation');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.runId).toBeUndefined();
    expect(entry.invocationId).toBeUndefined();
    expect(entry.agent).toBeUndefined();
    expect(entry.attempt).toBeUndefined();
  });

  it('should include all correlation fields together in a log entry', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setRunId('run-1');
    logger.setInvocationId('inv-2');
    logger.setAgent('test-writer');
    logger.setAttempt(3);
    logger.setPhase(4);
    logger.setTaskId('task-005');
    logger.info('full context');
    await logger.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.runId).toBe('run-1');
    expect(entry.invocationId).toBe('inv-2');
    expect(entry.agent).toBe('test-writer');
    expect(entry.attempt).toBe(3);
    expect(entry.phase).toBe(4);
    expect(entry.taskId).toBe('task-005');
  });

  // ─── Child logger inherits correlation context ─────────────────────────────

  it('should propagate runId to child loggers', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setRunId('run-parent');
    logger.setInvocationId('inv-parent');
    logger.setAgent('code-migrator');
    logger.setAttempt(1);
    const child = logger.child('child-source');
    child.info('from child');
    await child.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.source).toBe('child-source');
    expect(entry.runId).toBe('run-parent');
    expect(entry.invocationId).toBe('inv-parent');
    expect(entry.agent).toBe('code-migrator');
    expect(entry.attempt).toBe(1);
  });

  it('should propagate phase and taskId to child loggers', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    logger.setPhase(3);
    logger.setTaskId('task-007');
    const child = logger.child('child-src');
    child.info('child with phase');
    await child.flush();

    const content = await readFile(join(logDir, 'migration.log'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.phase).toBe(3);
    expect(entry.taskId).toBe('task-007');
  });

  it('should share a single write queue between parent and child loggers', () => {
    const logger = new Logger({ logDir, level: 'info', console: false }) as any;
    const child = logger.child('child-source') as any;

    expect(child.writeState).toBe(logger.writeState);
  });

  // ─── Console correlation tags ──────────────────────────────────────────────

  it('should include correlation tags in console output when fields are set', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new Logger({ logDir, level: 'info', console: true });
      logger.setRunId('run-42');
      logger.setInvocationId('inv-99');
      logger.setPhase(4);
      logger.setTaskId('task-001');
      logger.setAgent('code-migrator');
      logger.info('tagged message');
      await logger.flush();

      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]![0] as string;
      expect(output).toContain('run=run-42');
      expect(output).toContain('inv=inv-99');
      expect(output).toContain('phase=4');
      expect(output).toContain('task=task-001');
      expect(output).toContain('agent=code-migrator');
    } finally {
      spy.mockRestore();
    }
  });

  it('should not include correlation tags in console output when no fields are set', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new Logger({ logDir, level: 'info', console: true });
      logger.info('no tags');
      await logger.flush();

      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0]![0] as string;
      expect(output).not.toContain('run=');
      expect(output).not.toContain('inv=');
      expect(output).not.toContain('agent=');
    } finally {
      spy.mockRestore();
    }
  });

  // ─── writeAgentLog with invocationId ───────────────────────────────────────

  it('should include invocationId in agent log filename when provided', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    await logger.writeAgentLog('code-migrator', 'task-001', 'log content', 'inv-abc');

    const files = await readdir(logDir);
    const agentLog = files.find(f => f.includes('inv-abc') && f.endsWith('.log'));
    expect(agentLog).toBeDefined();
    expect(agentLog).toMatch(/^code-migrator-task-001-inv-abc-/);

    const content = await readFile(join(logDir, agentLog!), 'utf-8');
    expect(content).toBe('log content');
  });

  it('should not include invocationId in agent log filename when not provided', async () => {
    const logger = new Logger({ logDir, level: 'info', console: false });
    await logger.writeAgentLog('parity-verifier', 'task-002', 'some output');

    const files = await readdir(logDir);
    const agentLog = files.find(f => f.startsWith('parity-verifier-task-002-') && f.endsWith('.log'));
    expect(agentLog).toBeDefined();
    // Should not contain an invocationId segment — just agent-taskId-timestamp.log
    const parts = agentLog!.replace('.log', '').split('-');
    // No inv-* segment
    expect(agentLog).not.toMatch(/inv-/);
  });
});
