import { describe, expect, it } from 'vitest';
import { ALL_AGENT_NAMES, AGENT_REGISTRY } from '../../src/agents/registry.js';
import { assertAgentPhase, isAgentAllowedInPhase, PHASE } from '../../src/flow/phases.js';

describe('agent phase contracts', () => {
  it('accepts every phase declared by the registry', () => {
    for (const agent of ALL_AGENT_NAMES) {
      for (const phase of AGENT_REGISTRY[agent].phases) {
        expect(isAgentAllowedInPhase(agent, phase as (typeof PHASE)[keyof typeof PHASE])).toBe(true);
      }
    }
  });

  it('allows the registry-declared final-parity code-migrator remediation', () => {
    expect(() => assertAgentPhase('code-migrator', PHASE.FINAL_PARITY)).not.toThrow();
  });

  it('rejects an invocation outside registry membership', () => {
    expect(() => assertAgentPhase('code-migrator', PHASE.FINALIZATION)).toThrow(
      'Agent code-migrator is not registered for Phase 6',
    );
  });
});
