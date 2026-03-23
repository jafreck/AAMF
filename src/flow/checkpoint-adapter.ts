/**
 * FlowCheckpointAdapter — bridges AAMF's CheckpointManager to the
 * @cadre-dev/framework FlowCheckpointAdapter interface.
 */

import type { FlowCheckpointAdapter, FlowCheckpointSnapshot } from '@cadre-dev/framework/flow';
import type { CheckpointManager } from '../core/checkpoint.js';
import type { MigrationFlowContext } from './context.js';
import { PHASE_BOUNDARY_NODE_IDS } from './migration-flow.js';

/**
 * Wraps AAMF's existing {@link CheckpointManager} to satisfy the framework's
 * {@link FlowCheckpointAdapter} contract.
 *
 * Flow checkpoint state is persisted inside the existing checkpoint.json under
 * a dedicated key, enabling coexistence with AAMF's phase-level resume data.
 */
export class AamfFlowCheckpointAdapter implements FlowCheckpointAdapter<MigrationFlowContext> {
  constructor(private readonly checkpoint: CheckpointManager) {}

  async load(flowId: string): Promise<FlowCheckpointSnapshot<MigrationFlowContext> | null> {
    const state = this.checkpoint.getState();
    const stored = state.__flowCheckpoint;
    if (!stored || typeof stored !== 'object') return null;
    const snapshot = stored as FlowCheckpointSnapshot<MigrationFlowContext>;
    if (snapshot.flowId !== flowId) return null;
    return snapshot;
  }

  async save(snapshot: FlowCheckpointSnapshot<MigrationFlowContext>): Promise<void> {
    const state = this.checkpoint.getState();
    // Store a serialisable subset (strip non-serialisable fields from context)
    const serialisable: FlowCheckpointSnapshot<Record<string, unknown>> = {
      flowId: snapshot.flowId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      completedExecutionIds: snapshot.completedExecutionIds,
      outputs: snapshot.outputs,
      executionOutputs: snapshot.executionOutputs,
      error: snapshot.error,
      // Do not persist context — it contains non-serialisable service references.
      // The context is reconstructed from the runtime on resume.
    };
    state.__flowCheckpoint = serialisable;

    // Sync completedPhases from flow execution IDs so that --from-phase
    // prerequisite checks work even if the run fails mid-pipeline.
    syncCompletedPhases(state, snapshot.completedExecutionIds, snapshot.flowId);

    await this.checkpoint.save(state);
  }
}

// ─── Phase 5 Nested Flow Checkpoint ─────────────────────────────────


/**
 * Checkpoint adapter for Phase 4's nested flow.
 * Stores checkpoint state under a dedicated key separate from the top-level flow.
 */
export class Phase4CheckpointAdapter implements FlowCheckpointAdapter<MigrationFlowContext> {
  constructor(private readonly checkpoint: CheckpointManager) {}

  async load(flowId: string): Promise<FlowCheckpointSnapshot<MigrationFlowContext> | null> {
    const state = this.checkpoint.getState();
    const stored = state.__phase4FlowCheckpoint;
    if (!stored || typeof stored !== 'object') return null;
    const snapshot = stored as FlowCheckpointSnapshot<MigrationFlowContext>;
    if (snapshot.flowId !== flowId) return null;
    return snapshot;
  }

  async save(snapshot: FlowCheckpointSnapshot<MigrationFlowContext>): Promise<void> {
    const state = this.checkpoint.getState();
    const serialisable: FlowCheckpointSnapshot<Record<string, unknown>> = {
      flowId: snapshot.flowId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      completedExecutionIds: snapshot.completedExecutionIds,
      outputs: snapshot.outputs,
      executionOutputs: snapshot.executionOutputs,
      error: snapshot.error,
    };
    state.__phase4FlowCheckpoint = serialisable;
    await this.checkpoint.save(state);
  }
}


// ─── completedPhases sync ───────────────────────────────────────────

/**
 * Derive completed phases from the flow's completedExecutionIds and merge
 * them into checkpoint state. A phase is complete when its boundary node
 * (the last node belonging to that phase) appears in the completed set.
 *
 * This ensures `--from-phase N` prerequisite checks pass even when the
 * pipeline fails in a later phase, since completedPhases is updated
 * incrementally on every checkpoint save rather than only at end-of-run.
 */
function syncCompletedPhases(
  state: import('../core/checkpoint.js').CheckpointState,
  completedExecutionIds: string[],
  flowId: string,
): void {
  // Execution IDs are namespaced: "<flowId>/<nodeId>"
  const prefix = flowId + '/';
  const completedNodes = new Set(
    completedExecutionIds
      .filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length)),
  );

  for (let phase = 0; phase < PHASE_BOUNDARY_NODE_IDS.length; phase++) {
    const boundaryNode = PHASE_BOUNDARY_NODE_IDS[phase]!;
    if (completedNodes.has(boundaryNode) && !state.completedPhases.includes(phase)) {
      state.completedPhases.push(phase);
    }
  }

  // Keep sorted for deterministic output
  state.completedPhases.sort((a, b) => a - b);

  // Advance currentPhase to at least max(completedPhases) + 1
  if (state.completedPhases.length > 0) {
    const maxCompleted = state.completedPhases[state.completedPhases.length - 1]!;
    state.currentPhase = Math.max(state.currentPhase, maxCompleted + 1);
  }
}
