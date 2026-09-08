import { isAbsolute, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type {
  AgentContext,
  AgentInvocation,
  AgentResult,
} from '../../src/agents/types.js';
import { getOutputSchema } from '../../src/agents/registry.js';

export interface ScriptedAgentLauncherOptions {
  fail?: (
    invocation: AgentInvocation,
    context: AgentContext,
    invocationIndex: number,
  ) => string | undefined;
  structuredOutput?: (
    invocation: AgentInvocation,
    context: AgentContext,
    invocationIndex: number,
    defaultOutput: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
}

/**
 * Deterministic, no-network agent launcher used by assembled-flow tests.
 * It consumes the real context files, writes representative artifacts, and
 * returns output that is validated by the same Zod contract as live agents.
 */
export class ScriptedAgentLauncher {
  readonly invocations: AgentInvocation[] = [];

  constructor(private readonly options: ScriptedAgentLauncherOptions = {}) {}

  async init(): Promise<void> {}

  getResolvedPath(): string | undefined {
    return undefined;
  }

  async launchAgent(invocation: AgentInvocation): Promise<AgentResult> {
    const context = JSON.parse(await readFile(invocation.contextPath, 'utf-8')) as AgentContext;
    const invocationIndex = this.invocations.length;
    this.invocations.push(invocation);

    const failure = this.options.fail?.(invocation, context, invocationIndex);
    if (failure) {
      return this.result(invocation, context, {
        success: false,
        exitCode: 1,
        error: failure,
        structuredOutput: { status: 'failed', taskId: context.taskId },
      });
    }

    const outputFiles = await this.writeArtifacts(context);
    const defaultOutput = this.structuredOutput(context);
    const structuredOutput = this.options.structuredOutput?.(
      invocation,
      context,
      invocationIndex,
      defaultOutput,
    ) ?? defaultOutput;
    return this.result(invocation, context, {
      success: true,
      exitCode: 0,
      outputFiles,
      structuredOutput,
    });
  }

  private async writeArtifacts(context: AgentContext): Promise<string[]> {
    const outputFiles: string[] = [];
    const write = async (path: string, contents: string): Promise<void> => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents, 'utf-8');
      outputFiles.push(path);
    };

    switch (context.agent) {
      case 'knowledge-builder':
        await write(join(context.outputPath, 'index.md'), '# Knowledge Base\n');
        await write(join(context.outputPath, 'architecture.md'), '# Architecture\n');
        await write(join(context.outputPath, 'integrations.md'), '# Integrations\n');
        break;
      case 'migration-planner':
        await write(join(context.outputPath, 'strategy.md'), '# Migration Strategy\n');
        break;
      case 'adjudicator':
        await write(context.outputPath, '# Adjudication\n\nUse the deterministic strategy.\n');
        break;
      case 'code-migrator': {
        const targetFiles = this.stringArray(context.payload?.targetFiles);
        for (const targetFile of targetFiles) {
          const path = this.resolveTargetFile(context, targetFile);
          const symbol = (context.taskId ?? 'migration').replace(/[^a-zA-Z0-9_$]/g, '_');
          await write(path, `export const ${symbol} = true;\n`);
        }
        break;
      }
      case 'test-writer': {
        const suite = this.record(context.payload?.e2eSuiteBrief);
        const configuredLocation = typeof suite?.outputLocation === 'string'
          ? suite.outputLocation
          : join('tests', `${context.taskId ?? 'migration'}.test.ts`);
        const path = this.resolveTargetFile(context, configuredLocation);
        await write(path, "import { describe, expect, it } from 'vitest';\n\ndescribe('scripted migration', () => {\n  it('is deterministic', () => expect(true).toBe(true));\n});\n");
        break;
      }
      case 'e2e-test-crafter': {
        const targetRoot = context.config.target.outputPath;
        const testPath = join(targetRoot, 'tests', 'e2e', 'calculator.test.ts');
        await write(
          join(targetRoot, 'e2e', 'e2e-test-plan.md'),
          '# E2E Test Plan\n\n' +
          '### Suite: suite-001 - Calculator workflow\n\n' +
          '**Purpose:** Verify the migrated calculator workflow.\n\n' +
          '**Target Files:**\n- calculator.ts\n\n' +
          '**KB References:**\n- calculator\n\n' +
          '**Framework:** vitest\n\n' +
          `**Output Location:** ${testPath}\n\n` +
          '**Scenarios:**\n- adds two numbers\n',
        );
        break;
      }
      case 'documentation-writer':
        await write(join(context.outputPath, 'migration-guide.md'), '# Migration Guide\n');
        break;
      case 'idiomatic-refactorer': {
        const task = this.record(context.payload?.task);
        for (const file of this.stringArray(task?.files)) {
          const path = this.resolveTargetFile(context, file);
          await write(path, 'export const idiomatic = true;\n');
        }
        break;
      }
      case 'parity-verifier':
      case 'parity-failure-resolver':
      case 'final-parity-checker':
      case 'idiomatic-reviewer':
      case 'idiomatic-planner':
        break;
    }

    return outputFiles;
  }

  private structuredOutput(context: AgentContext): Record<string, unknown> {
    const base: Record<string, unknown> = {
      status: 'completed',
      ...(context.taskId ? { taskId: context.taskId } : {}),
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
    };

    if (context.agent === 'parity-verifier') {
      return { ...base, parity: 'pass', issues: [] };
    }
    if (context.agent === 'final-parity-checker') {
      return { ...base, fixes: [] };
    }
    if (context.agent === 'idiomatic-reviewer') {
      return { ...base, issues: [] };
    }
    if (context.agent === 'idiomatic-planner') {
      return { ...base, tasks: [] };
    }
    return base;
  }

  private result(
    invocation: AgentInvocation,
    context: AgentContext,
    options: {
      success: boolean;
      exitCode: number;
      error?: string;
      outputFiles?: string[];
      structuredOutput: Record<string, unknown>;
    },
  ): AgentResult {
    const parsedOutput = getOutputSchema(invocation.agent).parse(options.structuredOutput) as Record<string, unknown>;
    return {
      agent: invocation.agent,
      workItemId: invocation.workItemId,
      invocationId: invocation.invocationId,
      exitCode: options.exitCode,
      success: options.success,
      timedOut: false,
      duration: 1,
      stdout: `\`\`\`aamf-json\n${JSON.stringify(parsedOutput)}\n\`\`\``,
      stderr: '',
      tokenUsage: { input: 10, output: 5 },
      outputPath: context.outputPath,
      outputExists: (options.outputFiles?.length ?? 0) > 0,
      error: options.error,
      extensions: {
        outputFiles: options.outputFiles ?? [],
        outputParsed: true,
        structuredOutput: parsedOutput,
        tokenUsageSource: 'agent-reported',
      },
    };
  }

  private resolveTargetFile(context: AgentContext, path: string): string {
    return isAbsolute(path) ? path : join(context.config.target.outputPath, path);
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }
}
