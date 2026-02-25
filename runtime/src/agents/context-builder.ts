import { join } from 'node:path';
import { AgentName, AgentContext } from './types.js';
import { MigrationConfig } from '../config/schema.js';
import { writeJson, ensureDir } from '../util/fs.js';

/** Options for building an agent context file. */
export interface ContextBuildOptions {
  config: MigrationConfig;
  /** Progress directory, e.g. .aamf/migration/{projectName} */
  progressDir: string;
  phase: number;
  taskId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Builds per-agent context files.
 *
 * The context builder creates a JSON context file containing ONLY what each
 * agent needs — file paths, not contents. Each agent type receives a tailored
 * set of input files, an output path, and an optional payload.
 */
export class ContextBuilder {
  constructor(private config: MigrationConfig, private progressDir: string) {}

  /**
   * Build and write the context file for a given agent invocation.
   * @param agent - The agent to build context for.
   * @param phase - The current migration phase number.
   * @param taskId - Optional task identifier within the phase.
   * @param payload - Optional additional data for the agent.
   * @returns The absolute path to the written context JSON file.
   */
  async buildContext(
    agent: AgentName,
    phase: number,
    taskId?: string,
    payload?: Record<string, unknown>,
  ): Promise<string> {
    const context = this.createContext(agent, phase, taskId, payload);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${agent}-${taskId ?? 'main'}-${timestamp}.json`;
    const contextDir = join(this.progressDir, 'contexts');
    await ensureDir(contextDir);
    const contextPath = join(contextDir, filename);
    await writeJson(contextPath, context);
    return contextPath;
  }

  /**
   * Returns the effective context-window token limit based on `agentRuntime`.
   * When `agentRuntime === 'claude-code'`, `claudeCode.contextWindowTokens`
   * takes precedence over `options.contextWindowTokens`.
   */
  private getEffectiveContextWindowTokens(): number | undefined {
    if (this.config.agentRuntime === 'claude-code') {
      return this.config.claudeCode?.contextWindowTokens ?? this.config.options.contextWindowTokens;
    }
    return this.config.options.contextWindowTokens;
  }

  /**
   * Assemble an {@link AgentContext} object for the given agent and phase.
   * Includes a `contextWindowTokens` key so agents can self-limit their context usage.
   */
  private createContext(
    agent: AgentName,
    phase: number,
    taskId?: string,
    payload?: Record<string, unknown>,
  ): AgentContext & { contextWindowTokens?: number } {
    const base: Omit<AgentContext, 'inputFiles' | 'outputPath' | 'payload'> & { contextWindowTokens?: number } = {
      agent,
      projectName: this.config.projectName,
      phase,
      taskId,
      config: {
        source: {
          path: this.config.source.path,
          language: this.config.source.language,
        },
        target: {
          language: this.config.target.language,
          framework: this.config.target.framework,
          outputPath: this.config.target.outputPath,
        },
      },
      contextWindowTokens: this.getEffectiveContextWindowTokens(),
    };

    const { inputFiles, outputPath, agentPayload } = this.getAgentFiles(agent, taskId, payload);
    return { ...base, inputFiles, outputPath, payload: agentPayload ?? payload };
  }

  /**
   * Determine the input files, output path, and optional payload overrides
   * for a specific agent type.
   */
  private getAgentFiles(
    agent: AgentName,
    taskId?: string,
    payload?: Record<string, unknown>,
  ): { inputFiles: string[]; outputPath: string; agentPayload?: Record<string, unknown> } {
    const kbDir = join(this.progressDir, 'knowledge-base');
    const impactAssessment = join(this.progressDir, 'impact-assessment.md');
    const migrationPlan = join(this.progressDir, 'migration-plan.md');
    const src = this.config.source.path;
    const out = this.config.target.outputPath;

    switch (agent) {
      case 'impact-assessor':
        return { inputFiles: [src], outputPath: impactAssessment };

      case 'knowledge-builder':
        return {
          inputFiles: [src, impactAssessment],
          outputPath: kbDir,
          agentPayload: { largeFileThreshold: this.config.options.largeFileThreshold },
        };

      case 'large-file-analyzer':
        return {
          inputFiles: payload?.filePath ? [String(payload.filePath)] : [src],
          outputPath: join(kbDir, 'large-files'),
        };

      case 'migration-planner':
        return {
          inputFiles: [join(kbDir, 'index.md'), impactAssessment, join(kbDir, 'large-files')],
          outputPath: migrationPlan,
        };

      case 'adjudicator':
        return {
          inputFiles: payload?.competingStrategiesFile
            ? [String(payload.competingStrategiesFile)]
            : [],
          outputPath: join(this.progressDir, 'adjudication-result.md'),
          agentPayload: { decisionType: payload?.decisionType ?? 'migration-strategy' },
        };

      case 'code-migrator':
        return {
          inputFiles: [
            ...(payload?.taskPlanSlice ? [String(payload.taskPlanSlice)] : [migrationPlan]),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
          ],
          outputPath: out,
          agentPayload: {
            taskId,
            sourceFiles: payload?.sourceFiles ?? [],
            targetFiles: payload?.targetFiles ?? [],
          },
        };

      case 'parity-verifier':
        return {
          inputFiles: [
            ...(payload?.sourceFile ? [String(payload.sourceFile)] : []),
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.taskPlanSlice ? [String(payload.taskPlanSlice)] : [migrationPlan]),
          ],
          outputPath: join(this.progressDir, 'parity-reports', `${taskId ?? 'main'}.md`),
          agentPayload: { taskId },
        };

      case 'test-writer':
        return {
          inputFiles: [
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
            ...(payload?.parityReport ? [String(payload.parityReport)] : []),
          ],
          outputPath: join(out, '__tests__'),
          agentPayload: { taskId, testType: payload?.testType ?? 'unit' },
        };

      case 'failure-recovery':
        return {
          inputFiles: [
            ...(payload?.failureReport ? [String(payload.failureReport)] : []),
            ...(payload?.sourceFile ? [String(payload.sourceFile)] : []),
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
          ],
          outputPath: join(this.progressDir, 'recovery', `${taskId ?? 'main'}.md`),
          agentPayload: { taskId, attemptNumber: payload?.attemptNumber ?? 1 },
        };

      case 'final-parity-checker':
        return {
          inputFiles: [src, out, migrationPlan],
          outputPath: join(this.progressDir, 'final-parity-report.md'),
        };

      case 'e2e-test-crafter':
        return {
          inputFiles: [
            join(kbDir, 'architecture.md'),
            join(kbDir, 'integrations.md'),
            join(kbDir, 'index.md'),
          ],
          outputPath: join(out, 'e2e'),
        };

      case 'documentation-writer':
        return {
          inputFiles: [kbDir, migrationPlan, join(this.progressDir, 'final-parity-report.md')],
          outputPath: join(out, 'docs'),
        };

      case 'idiomatic-reviewer':
        return {
          inputFiles: [out],
          outputPath: join(this.progressDir, 'idiomatic-review-report.md'),
        };

      case 'idiomatic-refactorer':
        return {
          inputFiles: [
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.idiomaticReport ? [String(payload.idiomaticReport)] : []),
          ],
          outputPath: out,
        };

      default:
        // migration-orchestrator, migration-runner, etc.
        return {
          inputFiles: [src],
          outputPath: this.progressDir,
        };
    }
  }
}
