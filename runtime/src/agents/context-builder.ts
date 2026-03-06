import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentName, AgentContext } from './types.js';
import { MigrationConfig } from '../config/schema.js';
import { writeJson, ensureDir } from '../util/fs.js';
import type { RuntimePaths } from '../core/runtime-paths.js';

const TASK_DECOMPOSER_SCHEMA_PATH = fileURLToPath(
  new URL('./task-decomposer.tasks.schema.json', import.meta.url),
);

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
  private readonly paths: RuntimePaths;

  constructor(private config: MigrationConfig, private progressDir: string, paths: RuntimePaths) {
    this.paths = paths;
  }

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
    const contextDir = join(this.progressDir, 'artifacts', 'contexts');
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isLikelyPathString(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes('\n') || trimmed.includes('\r')) return false;
    if (trimmed.length > 320) return false;
    return true;
  }

  private getRemediationContext(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
    const nestedRemediation = payload?.remediationContext ?? payload?.remediation;
    if (this.isRecord(nestedRemediation)) {
      return nestedRemediation;
    }

    if (
      payload?.failureKind !== undefined ||
      payload?.failureSummary !== undefined ||
      payload?.failureTarget !== undefined ||
      payload?.artifactPaths !== undefined ||
      payload?.expectedSuccessCondition !== undefined
    ) {
      return {
        failureKind: payload?.failureKind,
        failureSummary: payload?.failureSummary,
        failureTarget: payload?.failureTarget,
        artifactPaths: payload?.artifactPaths,
        expectedSuccessCondition: payload?.expectedSuccessCondition,
      };
    }

    return undefined;
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
    const kbDir = this.paths.knowledgeBaseDir;
    const impactAssessment = this.paths.impactAssessmentFile;
    const migrationPlan = this.paths.migrationPlanFile;
    const src = this.config.source.path;
    const out = this.config.target.outputPath;
    const remediationContext = this.getRemediationContext(payload);

    switch (agent) {
      case 'impact-assessor':
        return { inputFiles: [src], outputPath: impactAssessment };

      case 'knowledge-builder':
        return {
          inputFiles: [src, impactAssessment],
          outputPath: kbDir,
        };

      case 'migration-planner':
        return {
          inputFiles: [join(kbDir, 'index.md'), impactAssessment],
          outputPath: join(this.progressDir, 'artifacts', 'planning'),
          agentPayload: {
            executionStrategy: this.buildExecutionStrategy(),
          },
        };

      case 'task-decomposer': {
        const strategyFile = String(payload?.strategyFile ?? join(this.progressDir, 'artifacts', 'planning', 'strategy.md'));
        const analysisFiles = Array.isArray(payload?.analysisFiles)
          ? (payload.analysisFiles as string[])
          : [];
        return {
          inputFiles: [TASK_DECOMPOSER_SCHEMA_PATH, strategyFile, ...analysisFiles],
          outputPath: join(this.progressDir, 'artifacts', 'planning', `tasks-${taskId ?? 'unknown'}.json`),
          agentPayload: {
            groupId: payload?.groupId,
            groupName: payload?.groupName,
            taskSchemaPath: TASK_DECOMPOSER_SCHEMA_PATH,
            maxLinesPerTask: this.config.options.maxLinesPerTask,
            executionStrategy: this.buildExecutionStrategy(),
          },
        };
      }

      case 'adjudicator':
        return {
          inputFiles: payload?.competingStrategiesFile
            ? [String(payload.competingStrategiesFile)]
            : [],
          outputPath: join(this.progressDir, 'artifacts', 'adjudication', 'adjudication-result.md'),
          agentPayload: { decisionType: payload?.decisionType ?? 'migration-strategy' },
        };

      case 'code-migrator': {
        // During parity recovery, include the parity report and adjudication
        // analysis as direct input files so the agent can read them.
        const recoveryInputFiles: string[] = [];
        if (remediationContext) {
          const parityPaths = (remediationContext.artifactPaths as string[] | undefined) ?? [];
          for (const p of parityPaths) {
            if (typeof p === 'string' && p.endsWith('.md') && this.isLikelyPathString(p)) {
              recoveryInputFiles.push(p);
            }
          }
          const adjudicationPath = (remediationContext as Record<string, unknown>).adjudicationReportPath;
          if (typeof adjudicationPath === 'string' && this.isLikelyPathString(adjudicationPath)) {
            recoveryInputFiles.push(adjudicationPath);
          }
        }
        return {
          inputFiles: [
            ...(payload?.taskPlanSlice ? [String(payload.taskPlanSlice)] : [migrationPlan]),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
            ...recoveryInputFiles,
          ],
          outputPath: out,
          agentPayload: {
            taskId,
            sourceFiles: payload?.sourceFiles ?? [],
            targetFiles: payload?.targetFiles ?? [],
            ...(remediationContext ? { remediationContext } : {}),
          },
        };
      }

      case 'parity-verifier':
        return {
          inputFiles: [
            ...(payload?.sourceFile ? [String(payload.sourceFile)] : []),
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.taskPlanSlice ? [String(payload.taskPlanSlice)] : [migrationPlan]),
          ],
          outputPath: join(this.progressDir, 'artifacts', 'parity', `${taskId ?? 'main'}.md`),
          agentPayload: { taskId },
        };

      case 'test-writer': {
        // Phase 6 per-suite E2E path: payload carries a full suite brief
        if (this.isRecord(payload?.e2eSuiteBrief)) {
          const brief = payload!.e2eSuiteBrief as Record<string, unknown>;
          const targetFiles = Array.isArray(brief.targetFiles) ? (brief.targetFiles as string[]) : [];
          const kbRefs = Array.isArray(brief.kbReferences) ? (brief.kbReferences as string[]) : [];
          return {
            inputFiles: [...targetFiles, ...kbRefs],
            outputPath: brief.outputLocation && typeof brief.outputLocation === 'string' ? brief.outputLocation : out,
            agentPayload: { taskId, testType: 'e2e', e2eSuiteBrief: brief },
          };
        }
        // Phase 4 unit-test path (unchanged)
        return {
          inputFiles: [
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
            ...(payload?.parityReport ? [String(payload.parityReport)] : []),
          ],
          outputPath: out,
          agentPayload: { taskId, testType: payload?.testType ?? 'unit' },
        };
      }

      case 'failure-adjudicator':
        {
          const failureReportPath = this.isLikelyPathString(payload?.failureReport)
            ? String(payload?.failureReport)
            : undefined;

        return {
          inputFiles: [
            ...(failureReportPath ? [failureReportPath] : []),
            ...(payload?.sourceFile ? [String(payload.sourceFile)] : []),
            ...(payload?.targetFile ? [String(payload.targetFile)] : []),
            ...(payload?.kbEntry ? [String(payload.kbEntry)] : []),
          ],
          outputPath: join(this.progressDir, 'artifacts', 'adjudication', `${taskId ?? 'main'}.md`),
          agentPayload: {
            taskId,
            failureType: payload?.failureType,
            failureReport: payload?.failureReport,
            attemptNumber: payload?.attemptNumber ?? 1,
            ...(remediationContext ? { remediationContext } : {}),
          },
        };
      }

      case 'final-parity-checker':
        return {
          inputFiles: [src, out, migrationPlan],
          outputPath: join(this.progressDir, 'artifacts', 'parity', 'final-parity-report.md'),
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
          inputFiles: [kbDir, migrationPlan, join(this.progressDir, 'artifacts', 'parity', 'final-parity-report.md')],
          outputPath: join(out, 'docs'),
        };

      case 'idiomatic-reviewer':
        return {
          inputFiles: [out],
          outputPath: join(this.progressDir, 'artifacts', 'parity', 'idiomatic-review-report.md'),
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

  /**
   * Build the execution-strategy descriptor from the current config.
   * Injected into the planning agents' payload so they can reason about
   * how Phase 4 will execute their task graph.
   */
  private buildExecutionStrategy(): import('./types.js').ExecutionStrategy {
    const opts = this.config.options;
    const waveControl = opts.waveControl ?? { waveSize: 3, maxConvergenceIterations: 3 };
    return {
      executionMode: opts.executionMode ?? 'per-task',
      maxParallelAgents: opts.maxParallelAgents,
      waveControl: {
        waveSize: waveControl.waveSize,
        maxConvergenceIterations: waveControl.maxConvergenceIterations,
      },
      maxRetriesPerTask: opts.maxRetriesPerTask,
      buildCommand: this.config.target.buildCommand,
      testCommand: this.config.target.testCommand,
      requiresNonOverlappingTargets: true,
    };
  }
}
