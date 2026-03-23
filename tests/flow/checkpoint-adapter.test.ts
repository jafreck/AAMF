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
  PHASE_BOUNDARY_NODE_IDS,
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

  it('should sync completedPhases from flow execution IDs on save', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ckpt-'));
    await mkdir(tempDir, { recursive: true });
    const logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    const cm = new CheckpointManager(tempDir, logger);
    await cm.load('test');
    const adapter = new AamfFlowCheckpointAdapter(cm);

    // Save a snapshot where phases 0-2 boundary nodes are completed
    const snapshot = {
      flowId: 'aamf-migration',
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedExecutionIds: [
        'aamf-migration/kb-index',              // phase 0 boundary
        'aamf-migration/task-graph-construction', // phase 1 boundary
        'aamf-migration/kb-construction',        // phase 2 (not boundary)
        'aamf-migration/budget-check-2',         // phase 2 boundary
      ],
      outputs: {},
      executionOutputs: {},
    };
    await adapter.save(snapshot as any);

    const state = cm.getState();
    expect(state.completedPhases).toEqual([0, 1, 2]);
    expect(state.currentPhase).toBe(3);
  });

  it('should not mark a phase complete if its boundary node is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ckpt-'));
    await mkdir(tempDir, { recursive: true });
    const logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    const cm = new CheckpointManager(tempDir, logger);
    await cm.load('test');
    const adapter = new AamfFlowCheckpointAdapter(cm);

    // Phase 2 has kb-construction done but NOT budget-check-2 (boundary)
    const snapshot = {
      flowId: 'aamf-migration',
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedExecutionIds: [
        'aamf-migration/kb-index',
        'aamf-migration/task-graph-construction',
        'aamf-migration/kb-construction',
        // budget-check-2 NOT completed yet
      ],
      outputs: {},
      executionOutputs: {},
    };
    await adapter.save(snapshot as any);

    const state = cm.getState();
    // Phase 2 should NOT be in completedPhases since its boundary node is missing
    expect(state.completedPhases).toEqual([0, 1]);
    expect(state.currentPhase).toBe(2);
  });

  it('should accumulate completedPhases across multiple saves', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-ckpt-'));
    await mkdir(tempDir, { recursive: true });
    const logger = new Logger({ logDir: join(tempDir, 'logs'), level: 'error', console: false });
    const cm = new CheckpointManager(tempDir, logger);
    await cm.load('test');
    const adapter = new AamfFlowCheckpointAdapter(cm);

    // First save: phase 0 complete
    await adapter.save({
      flowId: 'aamf-migration',
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedExecutionIds: ['aamf-migration/kb-index'],
      outputs: {},
      executionOutputs: {},
    } as any);
    expect(cm.getState().completedPhases).toEqual([0]);

    // Second save: phases 0-1 complete
    await adapter.save({
      flowId: 'aamf-migration',
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedExecutionIds: ['aamf-migration/kb-index', 'aamf-migration/task-graph-construction'],
      outputs: {},
      executionOutputs: {},
    } as any);
    expect(cm.getState().completedPhases).toEqual([0, 1]);
  });
});

describe('flow/index re-exports', () => {
  it('should export MigrationError', () => {
    expect(MigrationError).toBeDefined();
    const err = new MigrationError(2, 'KB', { phase: 2, name: 'KB', success: false, duration: 0 });
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

  it('should export PHASE_BOUNDARY_NODE_IDS', () => {
    expect(PHASE_BOUNDARY_NODE_IDS).toBeDefined();
    expect(PHASE_BOUNDARY_NODE_IDS[0]).toBe('kb-index');
    expect(PHASE_BOUNDARY_NODE_IDS).toHaveLength(9);
  });
});
