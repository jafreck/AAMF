export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  phase?: number;
  taskId?: string;
  runId?: string;
  invocationId?: string;
  agent?: string;
  attempt?: number;
  message: string;
  data?: Record<string, unknown>;
}

export type RuntimeEvent =
  | { type: 'migration-started'; projectName: string }
  | { type: 'migration-completed'; projectName: string; success: boolean; duration: number }
  | { type: 'phase-started'; phase: number; name: string }
  | { type: 'phase-completed'; phase: number; name: string; success: boolean; duration: number }
  | { type: 'phase-failed'; phase: number; name: string; error: string; exitCode?: number; stderr?: string }
  | { type: 'agent-queued'; agent: string; taskId?: string; phase?: number; runId?: string; invocationId?: string }
  | { type: 'agent-launched'; agent: string; taskId?: string; phase?: number; runId?: string; invocationId?: string }
  | { type: 'agent-completed'; agent: string; taskId?: string; success: boolean; duration: number; runId?: string; invocationId?: string }
  | { type: 'agent-failed'; agent: string; taskId?: string; error: string; attempt?: number; runId?: string; invocationId?: string }
  | { type: 'agent-heartbeat'; agent: string; taskId?: string; runId?: string; invocationId?: string; elapsedSeconds: number }
  | { type: 'agent-output-file-detected'; agent: string; taskId?: string; runId?: string; invocationId?: string; file: string }
  | { type: 'agent-timed-out'; agent: string; taskId?: string; runId?: string; invocationId?: string; timeout: number }
  | { type: 'task-started'; taskId: string; name: string }
  | { type: 'task-completed'; taskId: string; name: string; duration: number }
  | { type: 'task-failed'; taskId: string; name: string; error: string; attempt: number }
  | { type: 'task-blocked'; taskId: string; name: string; reason: string }
  | { type: 'checkpoint-saved'; phase: number; taskId?: string }
  | { type: 'budget-warning'; usage: number; budget: number; percentage: number }
  | { type: 'budget-exceeded'; usage: number; budget: number }
  | { type: 'migration-interrupted'; reason: string }
  | { type: 'metric-recorded'; invocationId: string }
  | { type: 'report-generated'; path: string };
