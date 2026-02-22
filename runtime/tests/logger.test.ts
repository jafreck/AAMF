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
    logger.event({ type: 'phase-started', phase: 1, name: 'Impact Assessment' });
    await logger.flush();

    const logPath = join(logDir, 'migration.log');
    const content = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry.message).toBe('phase-started');
    expect(entry.data).toBeDefined();
    expect(entry.data.phase).toBe(1);
    expect(entry.data.name).toBe('Impact Assessment');
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
});
