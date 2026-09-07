import type { AgentName } from '../agents/types.js';
import { AGENT_REGISTRY } from '../agents/registry.js';

export const PHASE = {
  KB_INDEXING: 0,
  TASK_GRAPH: 1,
  KB_CONSTRUCTION: 2,
  PLANNING: 3,
  MIGRATION: 4,
  FINAL_PARITY: 5,
  FINALIZATION: 6,
  IDIOMATIC: 7,
  COMPLETION: 8,
} as const;

export type PhaseId = (typeof PHASE)[keyof typeof PHASE];
export const MAX_PHASE: PhaseId = PHASE.COMPLETION;

export function isAgentAllowedInPhase(agent: AgentName, phase: PhaseId): boolean {
  return AGENT_REGISTRY[agent].phases.includes(phase);
}

export function assertAgentPhase(agent: AgentName, phase: PhaseId): void {
  if (!isAgentAllowedInPhase(agent, phase)) {
    throw new Error(`Agent ${agent} is not registered for Phase ${phase}`);
  }
}
