/**
 * FlowCheckpointAdapter — bridges AAMF's CheckpointManager to the
 * @cadre-dev/framework FlowCheckpointAdapter interface.
 */

import type { FlowCheckpointAdapter, FlowCheckpointSnapshot } from '@cadre-dev/framework/flow';
import type { CheckpointManager } from '../core/checkpoint.js';
import type { MigrationFlowContext } from './context.js';

const FLOW_CHECKPOINT_KEY = '__flowCheckpoint';

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
    const stored = (state as unknown as Record<string, unknown>)[FLOW_CHECKPOINT_KEY];
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
    (state as unknown as Record<string, unknown>)[FLOW_CHECKPOINT_KEY] = serialisable;
    await this.checkpoint.save(state);
  }
}

// ─── Phase 5 Nested Flow Checkpoint ─────────────────────────────────

const PHASE5_CHECKPOINT_KEY = '__phase5FlowCheckpoint';

/**
 * Checkpoint adapter for Phase 5's nested flow.
 * Stores checkpoint state under a dedicated key separate from the top-level flow.
 */
export class Phase5CheckpointAdapter implements FlowCheckpointAdapter<MigrationFlowContext> {
  constructor(private readonly checkpoint: CheckpointManager) {}

  async load(flowId: string): Promise<FlowCheckpointSnapshot<MigrationFlowContext> | null> {
    const state = this.checkpoint.getState();
    const stored = (state as unknown as Record<string, unknown>)[PHASE5_CHECKPOINT_KEY];
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
    (state as unknown as Record<string, unknown>)[PHASE5_CHECKPOINT_KEY] = serialisable;
    await this.checkpoint.save(state);
  }
}
