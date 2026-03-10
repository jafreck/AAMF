import { describe, it, expect } from 'vitest';
import { PHASES, getPhase, getRemainingPhases } from '../src/core/phase-registry.js';

describe('Phase Registry', () => {
  it('should have exactly 9 entries', () => {
    expect(PHASES).toHaveLength(9);
  });

  it('should contain phases with IDs 0–1, 3–9', () => {
    const ids = PHASES.map(p => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('should mark phases 0–1, 3–5 as critical', () => {
    for (const id of [0, 1, 3, 4, 5]) {
      const phase = PHASES.find(p => p.id === id);
      expect(phase?.critical).toBe(true);
    }
  });

  it('should mark phases 6–9 as non-critical', () => {
    for (const id of [6, 7, 8, 9]) {
      const phase = PHASES.find(p => p.id === id);
      expect(phase?.critical).toBe(false);
    }
  });

  it('should allow parallelism for phase 7 only', () => {
    expect(PHASES.find(p => p.id === 3)?.parallel).toBe(false);
    expect(PHASES.find(p => p.id === 7)?.parallel).toBe(true);
  });

  it('should return Phase 5 via getPhase(5)', () => {
    const phase = getPhase(5);
    expect(phase).toBeDefined();
    expect(phase?.id).toBe(5);
    expect(phase?.name).toBe('Iterative Migration');
    expect(phase?.description).toContain('per-task or wave-barrier mode');
    expect(phase?.agents).toContain('parity-failure-resolver');
    expect(phase?.agents).not.toContain('failure-recovery');
  });

  it('should return undefined for invalid phase ID', () => {
    expect(getPhase(99)).toBeUndefined();
  });

  it('should return phases 6, 7, 8, 9 from getRemainingPhases(6)', () => {
    const remaining = getRemainingPhases(6);
    expect(remaining).toHaveLength(4);
    const ids = remaining.map(p => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([6, 7, 8, 9]);
  });

  it('should have non-empty name and description for all phases', () => {
    for (const phase of PHASES) {
      expect(phase.name.length).toBeGreaterThan(0);
      expect(phase.description.length).toBeGreaterThan(0);
    }
  });

  describe('Phase 0 (KB Indexing)', () => {
    it('should exist with id: 0 and name "KB Indexing"', () => {
      const phase = getPhase(0);
      expect(phase).toBeDefined();
      expect(phase?.id).toBe(0);
      expect(phase?.name).toBe('KB Indexing');
    });

    it('should be required and critical', () => {
      const phase = getPhase(0);
      expect(phase?.optional).toBeUndefined();
      expect(phase?.critical).toBe(true);
    });

    it('should have an empty agents array (Phase 0 runs in-process, no agent launched)', () => {
      const phase = getPhase(0);
      expect(phase?.agents).toHaveLength(0);
    });

    it('should appear before Phase 1 in the PHASES array', () => {
      const phase0Index = PHASES.findIndex(p => p.id === 0);
      const phase1Index = PHASES.findIndex(p => p.id === 1);
      expect(phase0Index).toBeLessThan(phase1Index);
    });
  });

  describe('Phase 8 (Idiomatic Refactor)', () => {
    it('should exist with id: 8 and name "Idiomatic Refactor"', () => {
      const phase = getPhase(8);
      expect(phase).toBeDefined();
      expect(phase?.id).toBe(8);
      expect(phase?.name).toBe('Idiomatic Refactor');
    });

    it('should be optional', () => {
      const phase = getPhase(8);
      expect(phase?.optional).toBe(true);
    });

    it('should include idiomatic-reviewer and idiomatic-refactorer agents', () => {
      const phase = getPhase(8);
      expect(phase?.agents).toContain('idiomatic-reviewer');
      expect(phase?.agents).toContain('idiomatic-refactorer');
    });

    it('should appear before Phase 9 (Completion) in the PHASES array', () => {
      const phase8Index = PHASES.findIndex(p => p.id === 8);
      const phase9Index = PHASES.findIndex(p => p.id === 9);
      expect(phase8Index).toBeLessThan(phase9Index);
    });
  });
});
