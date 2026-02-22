import { describe, it, expect } from 'vitest';
import { TokenTracker } from '../src/budget/token-tracker.js';

describe('TokenTracker', () => {
  it('should track total token usage', () => {
    const tracker = new TokenTracker();
    tracker.record('agent-a', 1, 1000);
    tracker.record('agent-b', 1, 2000);
    expect(tracker.getTotal()).toBe(3000);
  });

  it('should track usage by agent', () => {
    const tracker = new TokenTracker();
    tracker.record('agent-a', 1, 1000);
    tracker.record('agent-a', 2, 500);
    tracker.record('agent-b', 1, 2000);
    
    const byAgent = tracker.getByAgent();
    expect(byAgent['agent-a']).toBe(1500);
    expect(byAgent['agent-b']).toBe(2000);
  });

  it('should track usage by phase', () => {
    const tracker = new TokenTracker();
    tracker.record('agent-a', 1, 1000);
    tracker.record('agent-b', 1, 2000);
    tracker.record('agent-a', 2, 500);
    
    const byPhase = tracker.getByPhase();
    expect(byPhase[1]).toBe(3000);
    expect(byPhase[2]).toBe(500);
  });

  it('should check budget threshold', () => {
    const tracker = new TokenTracker();
    tracker.record('agent', 1, 7000);
    
    expect(tracker.checkThreshold(10000)).toBe('ok');
    expect(tracker.checkThreshold(8000)).toBe('warning'); // 87.5%
    expect(tracker.checkThreshold(5000)).toBe('exceeded');
  });

  it('should serialize for checkpoint', () => {
    const tracker = new TokenTracker();
    tracker.record('agent-a', 1, 1000);
    tracker.record('agent-b', 2, 2000);
    
    const data = tracker.toCheckpointData();
    expect(data.total).toBe(3000);
    expect(data.byAgent['agent-a']).toBe(1000);
    expect(data.byPhase[2]).toBe(2000);
  });

  it('should restore from checkpoint', () => {
    const tracker = new TokenTracker();
    tracker.loadFromCheckpoint({
      total: 5000,
      byPhase: { 1: 2000, 2: 3000 },
      byAgent: { 'agent-a': 5000 },
    });
    
    expect(tracker.getTotal()).toBe(5000);
    expect(tracker.getByAgent()['agent-a']).toBe(5000);
  });

  it('should estimate tokens from text', () => {
    const tokens = TokenTracker.estimateTokens('hello world'); // 11 chars → ceil(11/4) = 3
    expect(tokens).toBe(3);
  });
});
