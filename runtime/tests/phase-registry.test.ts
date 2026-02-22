import { describe, it, expect } from 'vitest';
import { PHASES, getPhase, getRemainingPhases } from '../src/core/phase-registry.js';

describe('Phase Registry', () => {
  it('should have exactly 7 entries', () => {
    expect(PHASES).toHaveLength(7);
  });

  it('should have sequential IDs 1–7', () => {
    expect(PHASES.map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('should mark phases 1–4 as critical', () => {
    for (const id of [1, 2, 3, 4]) {
      const phase = PHASES.find(p => p.id === id);
      expect(phase?.critical).toBe(true);
    }
  });

  it('should mark phases 5–7 as non-critical', () => {
    for (const id of [5, 6, 7]) {
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

  it('should return phases 5, 6, 7 from getRemainingPhases(5)', () => {
    const remaining = getRemainingPhases(5);
    expect(remaining).toHaveLength(3);
    expect(remaining.map(p => p.id)).toEqual([5, 6, 7]);
  });

  it('should have non-empty name and description for all phases', () => {
    for (const phase of PHASES) {
      expect(phase.name.length).toBeGreaterThan(0);
      expect(phase.description.length).toBeGreaterThan(0);
    }
  });
});
