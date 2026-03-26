import { describe, it, expect, vi } from 'vitest';
import {
  migrationFlow,
  buildFlowUpToPhase,
  nodeIdToPhase,
  MigrationError,
  classifyError,
  TerminalExhaustionError,
} from '../../src/flow/index.js';

// ─── migrationFlow definition ────────────────────────────────────────────────

describe('migrationFlow', () => {
  it('should have the correct flow id', () => {
    expect(migrationFlow.id).toBe('aamf-migration');
  });

  it('should contain the expected top-level node IDs', () => {
    const ids = migrationFlow.nodes.map((n) => n.id);
    expect(ids).toContain('kb-index');
    expect(ids).toContain('task-graph-construction');
    expect(ids).toContain('kb-construction');
    expect(ids).toContain('migration-planning');
    expect(ids).toContain('iterative-migration');
    expect(ids).toContain('final-parity-loop');
    expect(ids).toContain('finalization');
    expect(ids).toContain('idiomatic-refactor-gate');
    expect(ids).toContain('completion');
  });

  it('should not contain the removed impact-assessment node', () => {
    const ids = migrationFlow.nodes.map((n) => n.id);
    expect(ids).not.toContain('impact-assessment');
  });

  it('should have budget gates after phases 3-5', () => {
    const ids = migrationFlow.nodes.map((n) => n.id);
    expect(ids).toContain('budget-check-2');
    expect(ids).toContain('budget-check-3');
    expect(ids).toContain('budget-check-4');
  });

  it('should enforce declaration order (kb-index before task-graph before kb-construction)', () => {
    const ids = migrationFlow.nodes.map((n) => n.id);
    expect(ids.indexOf('kb-index')).toBeLessThan(ids.indexOf('task-graph-construction'));
    expect(ids.indexOf('task-graph-construction')).toBeLessThan(ids.indexOf('kb-construction'));
    expect(ids.indexOf('kb-construction')).toBeLessThan(ids.indexOf('migration-planning'));
    expect(ids.indexOf('migration-planning')).toBeLessThan(ids.indexOf('iterative-migration'));
    expect(ids.indexOf('iterative-migration')).toBeLessThan(ids.indexOf('final-parity-loop'));
    expect(ids.indexOf('final-parity-loop')).toBeLessThan(ids.indexOf('finalization'));
  });

  it('should have explicit dependsOn on all non-root nodes', () => {
    for (const node of migrationFlow.nodes.slice(1)) {
      expect(node.dependsOn, `node ${node.id} missing dependsOn`).toBeDefined();
      expect(node.dependsOn!.length, `node ${node.id} has empty dependsOn`).toBeGreaterThan(0);
    }
  });

  it('should have budget gates depend on their corresponding step', () => {
    const nodeMap = new Map(migrationFlow.nodes.map(n => [n.id, n]));
    expect(nodeMap.get('budget-check-2')!.dependsOn).toContain('kb-construction');
    expect(nodeMap.get('budget-check-3')!.dependsOn).toContain('migration-planning');
    expect(nodeMap.get('budget-check-4')!.dependsOn).toContain('phase-4-teardown');
  });
});

// ─── nodeIdToPhase ───────────────────────────────────────────────────────────

describe('nodeIdToPhase', () => {
  it('should return 0 for kb-index', () => {
    expect(nodeIdToPhase('kb-index')).toBe(0);
  });

  it('should return 1 for task-graph-construction', () => {
    expect(nodeIdToPhase('task-graph-construction')).toBe(1);
  });

  it('should return 2 for kb-construction and its budget-check', () => {
    expect(nodeIdToPhase('kb-construction')).toBe(2);
    expect(nodeIdToPhase('budget-check-2')).toBe(2);
  });

  it('should return 3 for migration-planning and its budget-check', () => {
    expect(nodeIdToPhase('migration-planning')).toBe(3);
    expect(nodeIdToPhase('budget-check-3')).toBe(3);
  });

  it('should return 4 for iterative-migration and its budget-check', () => {
    expect(nodeIdToPhase('iterative-migration')).toBe(4);
    expect(nodeIdToPhase('budget-check-4')).toBe(4);
  });

  it('should return 5 for final-parity-loop and final-parity-iteration', () => {
    expect(nodeIdToPhase('final-parity-loop')).toBe(5);
    expect(nodeIdToPhase('final-parity-iteration')).toBe(5);
  });

  it('should return 6 for all phase-6 nodes', () => {
    expect(nodeIdToPhase('e2e-test-plan')).toBe(6);
    expect(nodeIdToPhase('finalization')).toBe(6);
    expect(nodeIdToPhase('e2e-suite-writers')).toBe(6);
    expect(nodeIdToPhase('documentation-writer')).toBe(6);
  });

  it('should return 7 for idiomatic-refactor nodes', () => {
    expect(nodeIdToPhase('idiomatic-refactor-gate')).toBe(7);
    expect(nodeIdToPhase('idiomatic-refactor-pipeline')).toBe(7);
  });

  it('should return 8 for completion', () => {
    expect(nodeIdToPhase('completion')).toBe(8);
  });

  it('should return -1 for unknown node IDs', () => {
    expect(nodeIdToPhase('nonexistent')).toBe(-1);
    expect(nodeIdToPhase('')).toBe(-1);
  });
});

// ─── buildFlowUpToPhase ──────────────────────────────────────────────────────

describe('buildFlowUpToPhase', () => {
  it('should return the full flow for maxPhase >= 9', () => {
    const flow = buildFlowUpToPhase(9);
    expect(flow).toBe(migrationFlow);
  });

  it('should return the full flow for maxPhase >= 10', () => {
    const flow = buildFlowUpToPhase(10);
    expect(flow).toBe(migrationFlow);
  });

  it('should truncate to phase 0 (kb-index only)', () => {
    const flow = buildFlowUpToPhase(0);
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain('kb-index');
    expect(ids).not.toContain('task-graph-construction');
  });

  it('should truncate to phase 1 (kb-index + task-graph)', () => {
    const flow = buildFlowUpToPhase(1);
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain('kb-index');
    expect(ids).toContain('task-graph-construction');
    expect(ids).not.toContain('kb-construction');
  });

  it('should truncate to phase 2 (up through budget-check-2)', () => {
    const flow = buildFlowUpToPhase(2);
    expect(flow).toBeDefined();
    expect(flow.id).toBe('aamf-migration');
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain('kb-construction');
    expect(ids).toContain('budget-check-2');
    expect(ids).not.toContain('migration-planning');
  });

  it('should truncate to phase 3 (up through budget-check-3)', () => {
    const flow = buildFlowUpToPhase(3);
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain('kb-index');
    expect(ids).toContain('kb-construction');
    expect(ids).toContain('budget-check-3');
    expect(ids).not.toContain('iterative-migration');
  });

  it('should truncate to phase 4 (up through budget-check-4)', () => {
    const flow = buildFlowUpToPhase(4);
    const ids = flow.nodes.map((n) => n.id);
    expect(ids).toContain('iterative-migration');
    expect(ids).toContain('budget-check-4');
    expect(ids).not.toContain('final-parity-loop');
  });

  it('should preserve the flow id in truncated flows', () => {
    const flow = buildFlowUpToPhase(3);
    expect(flow.id).toBe('aamf-migration');
  });
});

// ─── MigrationError ──────────────────────────────────────────────────────────

describe('MigrationError', () => {
  it('should construct with phase, name, and result', () => {
    const result = { phase: 2, name: 'KB Construction', success: false, duration: 100, error: 'test failure' };
    const err = new MigrationError(2, 'KB Construction', result);

    expect(err.phaseId).toBe(2);
    expect(err.phaseName).toBe('KB Construction');
    expect(err.result).toBe(result);
    expect(err.message).toContain('Phase 2');
    expect(err.message).toContain('KB Construction');
    expect(err.message).toContain('test failure');
  });

  it('should have name "MigrationError"', () => {
    const result = { phase: 2, name: 'KB', success: false, duration: 0 };
    const err = new MigrationError(2, 'KB', result);
    expect(err.name).toBe('MigrationError');
    expect(err).toBeInstanceOf(Error);
  });

  it('should fallback to "unknown error" when result has no error message', () => {
    const result = { phase: 4, name: 'Iterative Migration', success: false, duration: 0 };
    const err = new MigrationError(4, 'Iterative Migration', result);
    expect(err.message).toContain('unknown error');
  });
});

// ─── TerminalExhaustionError ─────────────────────────────────────────────────

describe('TerminalExhaustionError', () => {
  it('should construct with task details', () => {
    const details = {
      taskId: 'task-001',
      wave: 2,
      check: 'build',
      reasonCode: 'max-retries' as const,
      summary: 'Build failed 3 times',
      lastError: 'compilation error',
      attempt: 3,
      maxAttempts: 3,
    };
    const err = new TerminalExhaustionError(details);

    expect(err.name).toBe('TerminalExhaustionError');
    expect(err.details).toBe(details);
    expect(err.message).toContain('task=task-001');
    expect(err.message).toContain('wave=2');
    expect(err.message).toContain('max-retries');
  });

  it('should handle details without optional fields', () => {
    const details = {
      reasonCode: 'max-retries' as const,
      summary: 'Failed',
      lastError: 'error',
      attempt: 1,
      maxAttempts: 1,
    };
    const err = new TerminalExhaustionError(details);
    expect(err.message).toContain('max-retries');
    expect(err).toBeInstanceOf(Error);
  });
});
