import { resolve, join, dirname } from 'node:path';
import { loadConfig, applyOverrides } from '../config/loader.js';
import { MigrationConfig } from '../config/schema.js';
import { MigrationOrchestrator } from './orchestrator.js';
import { CheckpointManager } from './checkpoint.js';
import { AgentLauncher } from './agent-launcher.js';
import { ProgressWriter } from './progress.js';
import { PHASES } from './phase-registry.js';
import { Logger } from '../logging/logger.js';
import { MigrationResult } from '../agents/types.js';
import { CostEstimator } from '../budget/cost-estimator.js';
import { fileExists } from '../util/fs.js';

export interface RuntimeOptions {
  configPath: string;
  resume?: boolean;
  dryRun?: boolean;
  phase?: number;   // run only this phase
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class MigrationRuntime {
  private config!: MigrationConfig;
  private logger!: Logger;
  private checkpoint!: CheckpointManager;
  private progress!: ProgressWriter;
  private launcher!: AgentLauncher;
  private progressDir!: string;
  private projectRoot!: string;
  private phase?: number;

  async initialize(options: RuntimeOptions): Promise<void> {
    // 1. Load config
    const rawConfig = await loadConfig(options.configPath);
    this.projectRoot = dirname(resolve(options.configPath));

    // Apply CLI overrides immutably
    this.config = applyOverrides(rawConfig, {
      dryRun: options.dryRun,
      resume: options.resume,
    });
    this.phase = options.phase;

    // 2. Setup directories
    this.progressDir = join(this.projectRoot, '.copilot', 'migration', this.config.projectName);
    const logDir = join(this.progressDir, 'logs');

    // 3. Create logger
    this.logger = new Logger({
      logDir,
      level: options.logLevel ?? 'info',
      console: true,
    });

    // 4. Create checkpoint manager
    this.checkpoint = new CheckpointManager(this.progressDir, this.logger);

    // 5. Create progress writer
    this.progress = new ProgressWriter(join(this.progressDir, 'progress.md'));

    // 6. Create agent launcher
    this.launcher = new AgentLauncher(this.config, this.projectRoot, this.logger);

    // 7. Validate agent files exist
    await this.validateAgentFiles();

    this.logger.info(`AAMF Runtime initialized for project: ${this.config.projectName}`);
    this.logger.info(`Source: ${this.config.source.language} → Target: ${this.config.target.language}`);

    // 8. Setup graceful shutdown
    this.setupShutdownHandlers();
  }

  async run(): Promise<MigrationResult> {
    // Load or create checkpoint
    await this.checkpoint.load(this.config.projectName);

    // Initialize progress
    if (!this.config.options.resume) {
      await this.progress.initialize(this.config);
    } else {
      // Reconstruct progress state from checkpoint on resume
      const state = this.checkpoint.getState();
      this.progress.reconstructFromCheckpoint(state);
    }

    // Dry run: just validate and log
    if (this.config.options.dryRun) {
      this.logger.info('Dry run mode — config validated, no migration will be performed');
      await this.progress.appendEvent('Dry run — validation only');
      return {
        success: true,
        projectName: this.config.projectName,
        phases: [],
        totalDuration: 0,
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        failedTasks: [],
        blockedTasks: [],
      };
    }

    // Create and run orchestrator
    const orchestrator = new MigrationOrchestrator(
      this.config,
      this.checkpoint,
      this.launcher,
      this.progress,
      this.logger,
      this.projectRoot,
      this.phase,
    );

    const result = await orchestrator.run();

    // Flush any buffered log entries before returning
    await this.logger.flush();

    // Print summary
    this.printSummary(result);
    return result;
  }

  async getStatus(): Promise<string> {
    const state = await this.checkpoint.load(this.config.projectName);
    // Format status from checkpoint state
    let status = `\nProject: ${state.projectName}\n`;
    status += `Phase: ${state.currentPhase}/7\n`;
    status += `Completed Phases: ${state.completedPhases.join(', ') || 'none'}\n`;
    status += `Completed Tasks: ${state.completedTasks.length}\n`;
    status += `Failed Tasks: ${state.failedTasks.length}\n`;
    status += `Blocked Tasks: ${state.blockedTasks.length}\n`;
    status += `Token Usage: ${state.tokenUsage.total.toLocaleString()}\n`;
    status += `Started: ${state.startedAt}\n`;
    status += `Last Checkpoint: ${state.lastCheckpoint}\n`;
    status += `Resume Count: ${state.resumeCount}\n`;
    return status;
  }

  async reset(fromPhase?: number): Promise<void> {
    // Implementation: if fromPhase specified, reset that phase and later.
    // Otherwise reset everything.
    const state = await this.checkpoint.load(this.config.projectName);
    if (fromPhase) {
      state.completedPhases = state.completedPhases.filter(p => p < fromPhase);
      state.currentPhase = fromPhase;
      state.currentTask = null;
      // Remove phase outputs for reset phases
      for (let p = fromPhase; p <= 7; p++) {
        delete state.phaseOutputs[p];
      }
      this.logger.info(`Reset migration from Phase ${fromPhase} onward`);
    } else {
      state.currentPhase = 1;
      state.currentTask = null;
      state.completedPhases = [];
      state.completedTasks = [];
      state.failedTasks = [];
      state.blockedTasks = [];
      state.phaseOutputs = {};
      state.tokenUsage = { total: 0, byPhase: {}, byAgent: {} };
      this.logger.info('Reset all migration state');
    }
    await this.checkpoint.save(state);
  }

  private printSummary(result: MigrationResult): void {
    console.log('\n' + '='.repeat(60));
    console.log(result.success ? '✅ Migration Complete' : '❌ Migration Failed');
    console.log('='.repeat(60));
    console.log(`Project: ${result.projectName}`);
    console.log(`Duration: ${this.formatDuration(result.totalDuration)}`);
    console.log(`Token Usage: ${result.tokenUsage.total.toLocaleString()}`);
    
    const model = this.config.copilot.model ?? 'gpt-4o';
    const estimator = new CostEstimator();
    const cost = estimator.estimateFromTotal(model, result.tokenUsage.total);
    console.log(`Estimated Cost: ${CostEstimator.formatCost(cost.total)}`);

    console.log('\nPhases:');
    for (const phase of result.phases) {
      const icon = phase.success ? '✅' : '❌';
      console.log(`  ${icon} Phase ${phase.phase}: ${phase.name} (${this.formatDuration(phase.duration)})`);
    }

    if (result.failedTasks.length > 0) {
      console.log(`\nFailed Tasks: ${result.failedTasks.join(', ')}`);
    }
    if (result.blockedTasks.length > 0) {
      console.log(`Blocked Tasks: ${result.blockedTasks.join(', ')}`);
    }
    console.log('='.repeat(60) + '\n');
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  private async validateAgentFiles(): Promise<void> {
    const agentDir = this.config.copilot.agentDir;
    const allAgents = [...new Set(PHASES.flatMap(p => p.agents))];
    const missing: string[] = [];

    for (const agent of allAgents) {
      const agentPath = join(agentDir, `${agent}.agent.md`);
      if (!(await fileExists(agentPath))) {
        missing.push(agentPath);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing agent file(s) — migration cannot proceed:\n${missing.map(p => `  - ${p}`).join('\n')}`,
      );
    }
  }

  private setupShutdownHandlers(): void {
    const handler = async (signal: string) => {
      this.logger.warn(`Received ${signal} — shutting down gracefully`);
      try {
        await this.logger.flush();
        await this.checkpoint.save(this.checkpoint.getState());
        await this.progress.appendEvent(`Migration interrupted by ${signal}`);
      } catch {
        // Best-effort save
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    
    process.on('SIGINT', () => void handler('SIGINT'));
    process.on('SIGTERM', () => void handler('SIGTERM'));
  }
}
