export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  phase?: number;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export type RuntimeEvent =
  | { type: 'migration-started'; projectName: string }
  | { type: 'migration-completed'; projectName: string; success: boolean; duration: number }
  | { type: 'phase-started'; phase: number; name: string }
  | { type: 'phase-completed'; phase: number; name: string; success: boolean; duration: number }
  | { type: 'phase-failed'; phase: number; name: string; error: string; exitCode?: number; stderr?: string }
  | { type: 'agent-launched'; agent: string; taskId?: string; phase?: number }
  | { type: 'agent-completed'; agent: string; taskId?: string; success: boolean; duration: number }
  | { type: 'agent-failed'; agent: string; taskId?: string; error: string; attempt: number }
  | { type: 'task-started'; taskId: string; name: string }
  | { type: 'task-completed'; taskId: string; name: string; duration: number }
  | { type: 'task-failed'; taskId: string; name: string; error: string; attempt: number }
  | { type: 'task-blocked'; taskId: string; name: string; reason: string }
  | { type: 'checkpoint-saved'; phase: number; taskId?: string }
  | { type: 'budget-warning'; usage: number; budget: number; percentage: number }
  | { type: 'budget-exceeded'; usage: number; budget: number }
  | { type: 'migration-interrupted'; reason: string };
