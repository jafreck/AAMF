/**
 * Tests for flow checkpoint adapter and index re-exports.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AamfFlowCheckpointAdapter } from '../../src/flow/checkpoint-adapter.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { Logger } from '../../src/logging/logger.js';
import {
  MigrationError,
  TerminalExhaustionError,
  classifyError,
  migrationFlow,
  buildFlowUpToPhase,
  nodeIdToPhase,
} from '../../src/flow/index.js';

let tempDir: string;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('AamfFlowCheckpointAdapter', () => {
  it('should return null when no checkpoint data exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ckpt-'));
    await mkdir(tempDir, { recursive: true });
    const logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    const cm = new CheckpointManager(tempDir, logger);
    await cm.load('test');
    const adapter = new AamfFlowCheckpointAdapter(cm);

    const result = await adapter.load('aamf-migration');
    expect(result).toBeNull();
  });

  it('should round-trip save and load a flow checkpoint snapshot', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ckpt-'));
    await mkdir(tempDir, { recursive: true });
    const logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    const cm = new CheckpointManager(tempDir, logger);
    await cm.load('test');
    const adapter = new AamfFlowCheckpointAdapter(cm);

    const snapshot = {
      flowId: 'aamf-migration',
      status: 'completed',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedExecutionIds: ['kb-index', 'task-graph-construction'],
      outputs: { 'kb-index': { phase: 0 } },
      executionOutputs: {},
    };
    await adapter.save(snapshot as any);

    const loaded = await adapter.load('aamf-migration');
    expect(loaded).toBeDefined();
    expect(loaded!.flowId).toBe('aamf-migration');
    expect(loaded!.completedExecutionIds).toEqual(['kb-index', 'task-graph-construction']);
  });
});

describe('flow/index re-exports', () => {
  it('should export MigrationError', () => {
    expect(MigrationError).toBeDefined();
    const err = new MigrationError(3, 'KB', { phase: 3, name: 'KB', success: false, duration: 0 });
    expect(err).toBeInstanceOf(Error);
  });

  it('should export TerminalExhaustionError', () => {
    expect(TerminalExhaustionError).toBeDefined();
  });

  it('should export classifyError', () => {
    expect(classifyError).toBeDefined();
    expect(classifyError('out of memory')).toBe('oom');
  });

  it('should export migrationFlow', () => {
    expect(migrationFlow).toBeDefined();
    expect(migrationFlow.id).toBe('aamf-migration');
  });

  it('should export buildFlowUpToPhase', () => {
    expect(buildFlowUpToPhase).toBeDefined();
    expect(buildFlowUpToPhase(9)).toBe(migrationFlow);
  });

  it('should export nodeIdToPhase', () => {
    expect(nodeIdToPhase).toBeDefined();
    expect(nodeIdToPhase('kb-index')).toBe(0);
  });
});
