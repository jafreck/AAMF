import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { MigrationRuntime } from '../../src/core/runtime.js';
import { buildRuntimePaths } from '../../src/core/runtime-paths.js';
import { fileExists } from '../../src/util/fs.js';
import { ScriptedAgentLauncher } from '../helpers/scripted-agent-launcher.js';
import { openReadOnly, listFiles } from '@jafreck/lore';
import { makeAgentResult } from '../helpers/mocks.js';
import type { AgentInvocation } from '../../src/agents/types.js';
import { TargetChangeSetManager } from '../../src/core/target-change-set.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createFixture(options: { git?: boolean; executionMode?: 'per-task' | 'wave-barrier' | 'sync-epoch' } = {}): Promise<{ root: string; configPath: string; targetDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aamf-no-network-flow-')));
  temporaryRoots.push(root);
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(join(sourceDir, 'excluded'), { recursive: true });
  await writeFile(
    join(sourceDir, 'calculator.py'),
    'def add(left: int, right: int) -> int:\n    return left + right\n',
    'utf-8',
  );
  await writeFile(
    join(sourceDir, 'main.py'),
    [
      'from calculator import add',
      '',
      'def main() -> None:',
      '    print(add(2, 3))',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(join(sourceDir, 'excluded', 'generated.py'), 'SECRET = "ignored"\n', 'utf-8');
  execFileSync('git', ['init', '--quiet'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.name', 'AAMF Test'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.email', 'aamf-test@local.invalid'], { cwd: sourceDir });
  execFileSync('git', ['add', '-A'], { cwd: sourceDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourceDir });

  const configPath = join(root, 'migration.config.json');
  await writeFile(configPath, JSON.stringify({
    projectName: 'no-network-flow',
    source: {
      path: './source',
      language: 'python',
      entryPoints: ['main.py'],
      excludePatterns: ['excluded/**'],
    },
    target: {
      language: 'typescript',
      framework: 'none',
      outputPath: './target',
    },
    models: { default: 'scripted' },
    options: {
      qualityPolicy: 'strict',
      maxParallelAgents: 2,
      maxRetriesPerTask: 1,
      maxLinesPerTask: 500,
      invocationDelayMs: 0,
      buildConcurrency: 1,
      continueOnBlocked: true,
      maxBlockedTasks: 0,
      executionMode: options.executionMode ?? 'per-task',
      reuseKb: false,
      git: {
        enabled: options.git ?? false,
        autoInit: true,
        commitPerTask: true,
        allowEmptyTaskCommits: false,
      },
      idiomaticRefactor: { enabled: false },
      kbIndex: {
        logLevel: 'error',
        embeddings: { enabled: false },
        lsp: { enabled: false },
        execution: { allowSubprocessExecution: true },
      },
    },
    agentBackend: {
      runtime: 'copilot',
      cliCommand: 'must-not-run',
      timeout: 5_000,
    },
    environment: { inheritShellPath: false, extraPath: [] },
  }, null, 2), 'utf-8');

  return { root, configPath, targetDir };
}

function git(targetDir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: targetDir, encoding: 'utf-8' }).trim();
}

async function initializeTargetRepository(targetDir: string): Promise<string> {
  await mkdir(targetDir, { recursive: true });
  git(targetDir, 'init', '--quiet');
  git(targetDir, 'config', 'user.name', 'AAMF Test');
  git(targetDir, 'config', 'user.email', 'aamf-test@local.invalid');
  await writeFile(join(targetDir, '.gitignore'), 'node_modules/\n', 'utf-8');
  await writeFile(join(targetDir, 'baseline.ts'), 'export const baseline = 1;\n', 'utf-8');
  git(targetDir, 'add', '-A');
  git(targetDir, 'commit', '--quiet', '-m', 'baseline');
  return git(targetDir, 'rev-parse', 'HEAD');
}

describe('deterministic no-network full flow', () => {
  it.each(['per-task', 'wave-barrier', 'sync-epoch'] as const)(
    'runs the production runtime, Lore index, Cadre flow, checkpoint, and reports in %s mode without a live agent',
    async executionMode => {
    const fixture = await createFixture({ executionMode });
    const launcher = new ScriptedAgentLauncher();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('External network access is forbidden in the scripted full-flow tier'),
    );
    const runtime = new MigrationRuntime({ createAgentLauncher: () => launcher });

    await runtime.initialize({ configPath: fixture.configPath, logLevel: 'error' });
    const result = await runtime.run();

    expect(result.success).toBe(true);
    expect(result.phases.map(phase => phase.phase)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(launcher.invocations.length).toBeGreaterThan(0);
    expect(new Set(launcher.invocations.map(invocation => invocation.agent))).toEqual(expect.objectContaining({
      size: expect.any(Number),
    }));
    expect(launcher.invocations.some(invocation => invocation.agent === 'knowledge-builder')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'migration-planner')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'code-migrator')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'parity-verifier')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'final-parity-checker')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'e2e-test-crafter')).toBe(true);
    expect(launcher.invocations.some(invocation => invocation.agent === 'documentation-writer')).toBe(true);

    const targetEntries = await readdir(fixture.targetDir, { recursive: true });
    expect(targetEntries.some(entry => entry.endsWith('.ts'))).toBe(true);
    expect(targetEntries).toContain(join('e2e', 'e2e-test-plan.md'));
    expect(targetEntries).toContain(join('docs', 'migration-guide.md'));

    const paths = buildRuntimePaths(fixture.root, 'no-network-flow');
    expect(await fileExists(paths.kbDbFile)).toBe(true);
    expect(await fileExists(paths.kbTargetDbFile)).toBe(true);
    expect(await fileExists(paths.checkpointFile)).toBe(true);
    expect(await fileExists(paths.progressReportFile)).toBe(true);
    expect(await fileExists(paths.metricsSummaryFile)).toBe(true);
    expect(await fileExists(paths.reportsObservabilityDir)).toBe(true);

    const sourceDb = openReadOnly(paths.kbDbFile);
    try {
      const indexedPaths = listFiles(sourceDb).map(file => file.path);
      expect(indexedPaths.some(path => path.includes('excluded/generated.py'))).toBe(false);
    } finally {
      sourceDb.close();
    }

    const tasks = JSON.parse(await readFile(join(paths.artifactsPlanningDir, 'tasks-merged.json'), 'utf-8')) as Array<{
      sourceFiles: string[];
    }>;
    expect(tasks.flatMap(task => task.sourceFiles).some(path => path.includes('excluded/generated.py'))).toBe(false);

    const checkpoint = JSON.parse(await readFile(paths.checkpointFile, 'utf-8')) as {
      __flowCheckpoint?: { completedExecutionIds?: string[] };
    };
    expect(checkpoint.__flowCheckpoint?.completedExecutionIds).toEqual(expect.arrayContaining([
      'aamf-migration/kb-index',
      'aamf-migration/task-graph-construction',
      'aamf-migration/kb-construction',
      'aamf-migration/migration-planning',
      'aamf-migration/final-parity-loop',
      'aamf-migration/final-parity-convergence-gate',
      'aamf-migration/finalization',
      'aamf-migration/phase-6-promote',
      'aamf-migration/completion',
    ]));
    },
    60_000,
  );

  it('rolls back a rejected task and resumes from the owning Cadre phase without changing Git HEAD', async () => {
    const fixture = await createFixture({ git: true });
    await initializeTargetRepository(fixture.targetDir);
    const planningLauncher = new ScriptedAgentLauncher();
    const planningRuntime = new MigrationRuntime({ createAgentLauncher: () => planningLauncher });
    await planningRuntime.initialize({ configPath: fixture.configPath, phase: 3, logLevel: 'error' });
    const planned = await planningRuntime.run();
    expect(planned.success).toBe(true);
    const baselineHead = git(fixture.targetDir, 'rev-parse', 'HEAD');
    expect(git(fixture.targetDir, 'status', '--porcelain')).toBe('');

    const firstLauncher = new ScriptedAgentLauncher({
      fail: invocation => invocation.agent === 'test-writer' && invocation.phase === 4
        ? 'injected required test-writer failure'
        : undefined,
    });
    const firstRuntime = new MigrationRuntime({ createAgentLauncher: () => firstLauncher });

    await firstRuntime.initialize({ configPath: fixture.configPath, resume: true, logLevel: 'error' });
    const failed = await firstRuntime.run();

    expect(failed.success).toBe(false);
    expect(failed.phases).toContainEqual(expect.objectContaining({ phase: 4, success: false }));
    expect(git(fixture.targetDir, 'rev-parse', 'HEAD')).toBe(baselineHead);
    expect(git(fixture.targetDir, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(fixture.targetDir, 'baseline.ts'), 'utf-8')).toBe('export const baseline = 1;\n');
    const paths = buildRuntimePaths(fixture.root, 'no-network-flow');
    expect(await fileExists(paths.kbTargetDbFile)).toBe(false);

    const resumedLauncher = new ScriptedAgentLauncher();
    const resumedRuntime = new MigrationRuntime({ createAgentLauncher: () => resumedLauncher });
    await resumedRuntime.initialize({
      configPath: fixture.configPath,
      resume: true,
      logLevel: 'error',
    });
    const resumed = await resumedRuntime.run();

    expect(resumed.success).toBe(true);
    expect(resumedLauncher.invocations.every(invocation => invocation.phase >= 4)).toBe(true);
    expect(git(fixture.targetDir, 'rev-parse', 'HEAD')).not.toBe(baselineHead);
    expect(git(fixture.targetDir, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('rejects resume when source changes after the cached KB was checkpointed', async () => {
    const fixture = await createFixture();
    const planningRuntime = new MigrationRuntime({
      createAgentLauncher: () => new ScriptedAgentLauncher(),
    });
    await planningRuntime.initialize({ configPath: fixture.configPath, phase: 3, logLevel: 'error' });
    await expect(planningRuntime.run()).resolves.toMatchObject({ success: true });

    await writeFile(
      join(fixture.root, 'source', 'calculator.py'),
      'def add(left: int, right: int) -> int:\n    return left + right + 1\n',
      'utf-8',
    );
    const resumeLauncher = new ScriptedAgentLauncher();
    const resumeRuntime = new MigrationRuntime({ createAgentLauncher: () => resumeLauncher });
    await resumeRuntime.initialize({
      configPath: fixture.configPath,
      resume: true,
      logLevel: 'error',
    });

    await expect(resumeRuntime.run()).rejects.toThrow('Resume KB validation failed');
    expect(resumeLauncher.invocations).toEqual([]);
  }, 60_000);

  it.each([
    { name: 'fails after repeated non-convergence', fixesBeforeClean: Number.POSITIVE_INFINITY, success: false, expectedChecks: 3 },
    { name: 'converges on the final allowed iteration', fixesBeforeClean: 2, success: true, expectedChecks: 3 },
  ])('$name', async ({ fixesBeforeClean, success, expectedChecks }) => {
    const fixture = await createFixture();
    let finalParityChecks = 0;
    const launcher = new ScriptedAgentLauncher({
      structuredOutput: (invocation, _context, _index, defaultOutput) => {
        if (invocation.agent !== 'final-parity-checker') return defaultOutput;
        finalParityChecks++;
        if (finalParityChecks > fixesBeforeClean) return defaultOutput;
        return {
          ...defaultOutput,
          fixes: [{
            description: 'Injected blocking parity gap',
            details: 'The deterministic harness keeps this gap open for convergence testing.',
            sourceFile: join(fixture.root, 'source', 'calculator.py'),
            targetFile: join(fixture.targetDir, 'calculator.ts'),
            sourceLocation: 'calculator.py:1-2',
            targetLocation: 'calculator.ts:1',
          }],
        };
      },
    });
    const runtime = new MigrationRuntime({ createAgentLauncher: () => launcher });
    await runtime.initialize({ configPath: fixture.configPath, logLevel: 'error' });

    const result = await runtime.run();

    expect(result.success).toBe(success);
    expect(finalParityChecks).toBe(expectedChecks);
    const phase6Invocations = launcher.invocations.filter(invocation => invocation.phase === 6);
    expect(phase6Invocations.length > 0).toBe(success);
  }, 60_000);

  it('cancels active agent work and prevents later Cadre nodes from starting', async () => {
    const fixture = await createFixture();
    const invocations: AgentInvocation[] = [];
    let markStarted!: () => void;
    let releaseAgent!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseAgent = resolve; });
    const launcher = {
      init: async () => undefined,
      getResolvedPath: () => undefined,
      launchAgent: async (invocation: AgentInvocation) => {
        invocations.push(invocation);
        markStarted();
        await released;
        return makeAgentResult({
          agent: invocation.agent,
          workItemId: invocation.workItemId,
          success: false,
          exitCode: 143,
          error: 'cancelled',
        });
      },
    };
    const terminateActiveProcesses = vi.fn(async () => { releaseAgent(); });
    const runtime = new MigrationRuntime({
      createAgentLauncher: () => launcher,
      terminateActiveProcesses,
    });
    await runtime.initialize({ configPath: fixture.configPath, logLevel: 'error' });

    const running = runtime.run();
    await started;
    await runtime.cancel();
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(result.success).toBe(false);
    expect(terminateActiveProcesses).toHaveBeenCalled();
    expect(invocations.map(invocation => invocation.agent)).toEqual(['knowledge-builder']);
  }, 60_000);

  it('restores a pending target transaction before fresh-run cleanup', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.targetDir, { recursive: true });
    await writeFile(join(fixture.targetDir, 'baseline.ts'), 'baseline\n');
    const paths = buildRuntimePaths(fixture.root, 'no-network-flow');
    const changes = new TargetChangeSetManager(fixture.targetDir, paths.stateDir, {
      info: () => undefined,
      warn: () => undefined,
    });
    await changes.begin('phase-6-finalization', { mode: 'full' });
    await writeFile(join(fixture.targetDir, 'crash-only.ts'), 'unvalidated\n');

    const launcher = new ScriptedAgentLauncher();
    const runtime = new MigrationRuntime({ createAgentLauncher: () => launcher });
    await runtime.initialize({ configPath: fixture.configPath, logLevel: 'error' });
    const result = await runtime.run();

    expect(result.success).toBe(true);
    expect(await fileExists(join(fixture.targetDir, 'crash-only.ts'))).toBe(false);
  }, 60_000);
});
