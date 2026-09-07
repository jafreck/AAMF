/** Task-scoped Phase 4 steps persisted for deterministic resume. */
export const PHASE4_TASK_SUBSTEPS = [
  'migrate',
  'commit',
  'target-index',
  'parity',
  'parity-gate',
  'minor-repass',
  'format',
  'build',
  'test',
  'complete',
] as const;

export type Phase4TaskSubstep = (typeof PHASE4_TASK_SUBSTEPS)[number];
