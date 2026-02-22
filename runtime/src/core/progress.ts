import { join } from 'node:path';
import { atomicWrite, ensureDir } from '../util/fs.js';
import { MigrationConfig } from '../config/schema.js';

export interface TaskDetails {
  sourceFiles?: string[];
  targetFiles?: string[];
  parityScore?: number;
  testsGenerated?: number;
  error?: string;
}

export class ProgressWriter {
  private phases: Map<number, { name: string; status: string; notes?: string }> = new Map();
  private tasks: Map<string, { status: string; details?: TaskDetails }> = new Map();
  private events: string[] = [];
  private totalTasks: number = 0;
  private tokenUsage: { total: number } = { total: 0 };
  private startTime: Date = new Date();

  constructor(private filePath: string) {}

  /** Initialize fresh progress.md */
  async initialize(config: MigrationConfig): Promise<void> {
    this.startTime = new Date();
    this.phases.set(1, { name: 'Impact Assessment', status: 'pending' });
    this.phases.set(2, { name: 'Knowledge Base Construction', status: 'pending' });
    this.phases.set(3, { name: 'Migration Planning', status: 'pending' });
    this.phases.set(4, { name: 'Iterative Migration', status: 'pending' });
    this.phases.set(5, { name: 'Final Parity Verification', status: 'pending' });
    this.phases.set(6, { name: 'E2E Testing & Documentation', status: 'pending' });
    this.phases.set(7, { name: 'Completion', status: 'pending' });

    await this.write(config.projectName);
  }

  /** Update current phase status */
  async updatePhase(phase: number, status: string, notes?: string): Promise<void> {
    const existing = this.phases.get(phase);
    if (existing) {
      existing.status = status;
      existing.notes = notes;
    }
    await this.writeCurrentState();
  }

  /** Set total task count for progress bar */
  setTotalTasks(count: number): void {
    this.totalTasks = count;
  }

  /** Update task progress within Phase 4 */
  async updateTask(taskId: string, status: string, details?: TaskDetails): Promise<void> {
    this.tasks.set(taskId, { status, details });
    await this.writeCurrentState();
  }

  /** Update token usage */
  setTokenUsage(total: number): void {
    this.tokenUsage.total = total;
  }

  /** Append a timestamped event */
  async appendEvent(event: string): Promise<void> {
    const timestamp = new Date().toISOString();
    this.events.push(`[${timestamp}] ${event}`);
    await this.writeCurrentState();
  }

  /** Write completion summary */
  async finalize(result: { success: boolean; failedTasks: string[]; blockedTasks: string[]; totalDuration: number }): Promise<void> {
    await this.appendEvent(result.success ? 'Migration completed successfully!' : 'Migration completed with issues.');
    await this.writeCurrentState();
  }

  private async writeCurrentState(): Promise<void> {
    // infer project name from filepath
    const parts = this.filePath.split('/');
    const projectName = parts[parts.length - 2] ?? 'unknown';
    await this.write(projectName);
  }

  private async write(projectName: string): Promise<void> {
    const elapsed = this.formatDuration(Date.now() - this.startTime.getTime());
    const completedTasks = [...this.tasks.values()].filter(t => t.status === 'completed').length;

    let md = `# Migration Progress: ${projectName}\n\n`;
    md += `**Started:** ${this.startTime.toISOString()}\n`;
    md += `**Elapsed:** ${elapsed}\n`;
    md += `**Token Usage:** ${this.tokenUsage.total.toLocaleString()} tokens\n\n`;

    // Phase table
    md += `## Phases\n\n`;
    md += `| Phase | Name | Status | Notes |\n`;
    md += `|-------|------|--------|-------|\n`;
    for (const [id, phase] of this.phases) {
      const statusIcon = phase.status === 'completed' ? '✅' : phase.status === 'in-progress' ? '🔄' : phase.status === 'failed' ? '❌' : '⬜';
      md += `| ${id} | ${phase.name} | ${statusIcon} ${phase.status} | ${phase.notes ?? ''} |\n`;
    }
    md += '\n';

    // Task progress bar (Phase 4)
    if (this.totalTasks > 0) {
      md += `## Task Progress\n\n`;
      const pct = this.totalTasks > 0 ? Math.round((completedTasks / this.totalTasks) * 100) : 0;
      const filled = Math.round(pct / 5);
      const empty = 20 - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      md += `[${bar}] ${pct}% (${completedTasks}/${this.totalTasks} tasks)\n\n`;

      // Failed/blocked tasks
      const failed = [...this.tasks.entries()].filter(([_, t]) => t.status === 'failed');
      const blocked = [...this.tasks.entries()].filter(([_, t]) => t.status === 'blocked');

      if (failed.length > 0) {
        md += `### Failed Tasks\n`;
        for (const [id, t] of failed) {
          md += `- **${id}**: ${t.details?.error ?? 'unknown error'}\n`;
        }
        md += '\n';
      }
      if (blocked.length > 0) {
        md += `### Blocked Tasks\n`;
        for (const [id, t] of blocked) {
          md += `- **${id}**: ${t.details?.error ?? 'max retries exceeded'}\n`;
        }
        md += '\n';
      }
    }

    // Event log
    if (this.events.length > 0) {
      md += `## Event Log\n\n`;
      for (const ev of this.events.slice(-50)) { // last 50 events
        md += `- ${ev}\n`;
      }
      md += '\n';
    }

    await ensureDir(join(this.filePath, '..'));
    await atomicWrite(this.filePath, md);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
