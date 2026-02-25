import { describe, it, expect } from 'vitest';
import { PHASES, getPhase, getRemainingPhases } from '../src/core/phase-registry.js';

describe('Phase Registry', () => {
  it('should have exactly 8 entries', () => {
    expect(PHASES).toHaveLength(8);
  });

  it('should contain phases with IDs 1–7 plus 8', () => {
    const ids = PHASES.map(p => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('should mark phases 1–4 as critical', () => {
    for (const id of [1, 2, 3, 4]) {
      const phase = PHASES.find(p => p.id === id);
      expect(phase?.critical).toBe(true);
    }
  });

  it('should mark phases 5–8 as non-critical', () => {
    for (const id of [5, 6, 7, 8]) {
      const phase = PHASES.find(p => p.id === id);
      expect(phase?.critical).toBe(false);
    }
  });

  it('should allow parallelism for phases 2 and 6', () => {
    expect(PHASES.find(p => p.id === 2)?.parallel).toBe(true);
    expect(PHASES.find(p => p.id === 6)?.parallel).toBe(true);
  });

  it('should return Phase 4 via getPhase(4)', () => {
    const phase = getPhase(4);
    expect(phase).toBeDefined();
    expect(phase?.id).toBe(4);
    expect(phase?.name).toBe('Iterative Migration');
  });

  it('should return undefined for invalid phase ID', () => {
    expect(getPhase(99)).toBeUndefined();
  });

  it('should return phases 5, 6, 7, 8 from getRemainingPhases(5)', () => {
    const remaining = getRemainingPhases(5);
    expect(remaining).toHaveLength(4);
    const ids = remaining.map(p => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([5, 6, 7, 8]);
  });

  it('should have non-empty name and description for all phases', () => {
    for (const phase of PHASES) {
      expect(phase.name.length).toBeGreaterThan(0);
      expect(phase.description.length).toBeGreaterThan(0);
    }
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

    it('should appear before Phase 7 (Completion) in the PHASES array', () => {
      const phase8Index = PHASES.findIndex(p => p.id === 8);
      const phase7Index = PHASES.findIndex(p => p.id === 7);
      expect(phase8Index).toBeLessThan(phase7Index);
    });
  });
});
