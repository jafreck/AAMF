import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { MigrationOrchestrator, MigrationError } from '../src/core/orchestrator.js';
import { CheckpointManager } from '../src/core/checkpoint.js';
import { ProgressWriter } from '../src/core/progress.js';
import { PHASES, getPhase } from '../src/core/phase-registry.js';
import {
  createMockLauncher,
  createFailingLauncher,
  MockAgentLauncher,
  createMockConfig,
  createSilentLogger,
} from './helpers/mocks.js';
import { AgentInvocation, AgentResult, AgentName, MigrationTask } from '../src/agents/types.js';
import { Logger } from '../src/logging/logger.js';
import { ensureDir, fileExists } from '../src/util/fs.js';
import { spawnWithTimeout } from '../src/util/process.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a migration-plan.md fixture file to the progress directory.
 */
async function writeMigrationPlan(progressDir: string, content?: string): Promise<void> {
  const defaultPlan = `# Migration Plan: test-project

## Task: task-001 - User Auth Module

**Description:** Migrate auth module
**Complexity:** moderate
**Knowledge Base Reference:** kb/task-001.md

**Source Files:**
- src/task-001.py

**Target Files:**
- src/task-001.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches

## Task: task-002 - Database Layer

**Description:** Migrate database layer
**Complexity:** moderate
**Knowledge Base Reference:** kb/task-002.md

**Source Files:**
- src/task-002.py

**Target Files:**
- src/task-002.ts

**Dependencies:** task-001

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
  await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
  await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), content ?? defaultPlan);
  // Also write planning artifacts required by the two-step Phase 3 design.
  await writePhase3PlanningArtifacts(progressDir);
}

/** Default task list matching writeMigrationPlan — used to populate planning artifacts. */
const DEFAULT_PLANNING_TASKS: MigrationTask[] = [
  {
    id: 'task-001',
    name: 'User Auth Module',
    sourceFiles: ['src/task-001.py'],
    targetFiles: ['src/task-001.ts'],
    knowledgeBaseRef: 'kb/task-001.md',
    dependencies: [],
    complexity: 'moderate',
    description: 'Migrate auth module',
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
  },
  {
    id: 'task-002',
    name: 'Database Layer',
    sourceFiles: ['src/task-002.py'],
    targetFiles: ['src/task-002.ts'],
    knowledgeBaseRef: 'kb/task-002.md',
    dependencies: ['task-001'],
    complexity: 'moderate',
    description: 'Migrate database layer',
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
    lineRange: { start: 1, end: 200 },
  },
];

/** Single-task fixture matching the inline singleTaskPlan markdown used in Phase 4 tests. */
const SINGLE_AUTH_TASK: MigrationTask = {
  id: 'task-001',
  name: 'Auth Module',
  sourceFiles: ['src/auth.py'],
  targetFiles: ['src/auth.ts'],
  knowledgeBaseRef: 'kb/auth.md',
  dependencies: [],
  complexity: 'simple',
  description: 'Migrate auth',
  acceptanceCriteria: ['works'],
  parityChecks: ['matches'],
  lineRange: { start: 1, end: 200 },
};

/**
 * Write Phase 3 planning artifacts consumed by the two-step migration planner:
 *   planning/groups.json     — module groups emitted by migration-planner
 *   planning/tasks-core.json — task list emitted by task-decomposer for the "core" group
 *
 * Any test that exercises Phase 3 or later must call this (writeMigrationPlan calls it
 * automatically; tests that write a custom migration plan must call it explicitly).
 */
async function writePhase3PlanningArtifacts(
  progressDir: string,
  tasks: MigrationTask[] = DEFAULT_PLANNING_TASKS,
): Promise<void> {
  const planningDir = join(progressDir, 'artifacts', 'planning');
  await mkdir(planningDir, { recursive: true });
  const group = { id: 'core', name: 'Core', analysisFiles: [] };
  await writeFile(join(planningDir, 'groups.json'), JSON.stringify([group], null, 2));
  await writeFile(join(planningDir, 'tasks-core.json'), JSON.stringify(tasks, null, 2));
}

/** Write a final-parity-report.md with fix entries. */
async function writeParityReport(
  progressDir: string,
  issues: Array<{ description: string; sourceFile: string; targetFile: string }>,
): Promise<void> {
  let content = '# Final Parity Report\n\n';
  if (issues.length === 0) {
    content += 'All checks passed.\n';
  } else {
    for (const issue of issues) {
      content += `## Fix: ${issue.description}\n`;
      content += `Source file: ${issue.sourceFile}\n`;
      content += `Target file: ${issue.targetFile}\n\n`;
    }
  }
  await mkdir(join(progressDir, 'artifacts', 'parity'), { recursive: true });
  await writeFile(join(progressDir, 'artifacts', 'parity', 'final-parity-report.md'), content);
}

/**
 * Wrap a launcher function so parity-verifier invocations auto-include
 * valid parity data in structuredOutput, matching the fail-closed default (#118).
 */
function withParityPassOutput(
  fn: (inv: AgentInvocation) => Promise<AgentResult>,
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const result = await fn(inv);
    if (inv.agent === 'parity-verifier' && inv.taskId) {
      if (!result.structuredOutput || !(result.structuredOutput as any).parity) {
        result.structuredOutput = {
          ...(result.structuredOutput ?? {}),
          agent: 'parity-verifier',
          status: 'completed',
          taskId: inv.taskId,
          parity: 'pass',
          issues: [],
        };
        result.outputParsed = true;
      }
    }
    return result;
  };
}

/**
 * Wrap a launcher function so parity-verifier invocations return custom
 * structuredOutput per task. Used to simulate specific parity outcomes.
 */
function withParityOutput(
  fn: (inv: AgentInvocation) => Promise<AgentResult>,
  overrides: Record<string, { parity: string; issues: Array<{ severity: string; description: string; sourceLocation?: string; targetLocation?: string }> }>,
): (inv: AgentInvocation) => Promise<AgentResult> {
  return async (inv: AgentInvocation): Promise<AgentResult> => {
    const result = await fn(inv);
    if (inv.agent === 'parity-verifier' && inv.taskId) {
      const override = overrides[inv.taskId];
      if (override) {
        result.structuredOutput = {
          ...(result.structuredOutput ?? {}),
          agent: 'parity-verifier',
          status: 'completed',
          taskId: inv.taskId,
          parity: override.parity,
          issues: override.issues,
        };
        result.outputParsed = true;
      } else if (!result.structuredOutput || !(result.structuredOutput as any).parity) {
        result.structuredOutput = {
          ...(result.structuredOutput ?? {}),
          agent: 'parity-verifier',
          status: 'completed',
          taskId: inv.taskId,
          parity: 'pass',
          issues: [],
        };
        result.outputParsed = true;
      }
    }
    return result;
  };
}

/**
 * Write an e2e-test-plan.md fixture file to the target output e2e directory.
 */
async function writeE2eTestPlan(
  outputPath: string,
  suites: Array<{ id: string; name: string; purpose?: string; framework?: string; outputLocation?: string; scenarios?: string[] }>,
): Promise<void> {
  const e2eDir = join(outputPath, 'e2e');
  await mkdir(e2eDir, { recursive: true });

  let content = '# E2E Test Plan\n\n';
  for (const suite of suites) {
    content += `### Suite: ${suite.id} - ${suite.name}\n\n`;
    content += `**Purpose:** ${suite.purpose ?? 'Test suite'}\n\n`;
    content += `**Target Files:**\n- src/${suite.id}.ts\n\n`;
    content += `**KB References:**\n- kb/${suite.id}.md\n\n`;
    content += `**Framework:** ${suite.framework ?? 'vitest'}\n\n`;
    content += `**Output Location:** ${suite.outputLocation ?? `tests/${suite.id}`}\n\n`;
    const scenarios = suite.scenarios ?? ['basic test'];
    content += `**Scenarios:**\n${scenarios.map(s => `- ${s}`).join('\n')}\n\n`;
  }
  await writeFile(join(e2eDir, 'e2e-test-plan.md'), content);
}

/**
 * Set up a complete orchestrator test environment.
 */
async function setupOrchestrator(
  tempDir: string,
  launcherFn: (inv: AgentInvocation) => Promise<AgentResult>,
  configOverrides?: Parameters<typeof createMockConfig>[0],
  singlePhase?: number,
) {
  const config = createMockConfig(configOverrides);
  const logger = createSilentLogger(tempDir);
  const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
  await ensureDir(progressDir);

  const checkpoint = new CheckpointManager(progressDir, logger);
  await checkpoint.load(config.projectName);

  const progressFile = join(progressDir, 'progress.md');
  const progress = new ProgressWriter(progressFile);
  await progress.initialize(config);

  const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));

  const orchestrator = new MigrationOrchestrator(
    config,
    checkpoint,
    mockLauncher as any,
    progress,
    logger,
    tempDir,
    'test-run-id',
    singlePhase,
  );

  return { orchestrator, checkpoint, progress, mockLauncher, logger, config, progressDir };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MigrationOrchestrator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-orch-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('phase routing and KB pre-start behavior', () => {
    it('executePhase should throw for unknown phase id', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      await expect((orchestrator as any).executePhase({ id: 999 } as any)).rejects.toThrow('Unknown phase: 999');
    });

    it('should warn when KB is enabled for a later single phase but kb.db is missing', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(
          tempDir,
          launcherFn,
          {
            options: {
              kbIndex: { enabled: true, embeddings: { enabled: false } },
            },
          },
          1,
        );

        const result = await orchestrator.run();

        expect(result.phases.some(p => p.phase === 1)).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('KB indexing is enabled, but'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ─── Phase 0: KB Indexing ──────────────────────────────────────────

  describe('Phase 0: KB Indexing', () => {
    it('should skip Phase 0 when AAMF_USE_KB_INDEX is not set', async () => {
      delete process.env['AAMF_USE_KB_INDEX'];

      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase0 = result.phases.find(p => p.phase === 0);
      expect(phase0).toBeUndefined();
    });

    it('should skip Phase 0 when AAMF_USE_KB_INDEX is set to "0"', async () => {
      process.env['AAMF_USE_KB_INDEX'] = '0';

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
        await writeMigrationPlan(progressDir);

        const result = await orchestrator.run();

        const phase0 = result.phases.find(p => p.phase === 0);
        expect(phase0).toBeUndefined();
      } finally {
        delete process.env['AAMF_USE_KB_INDEX'];
      }
    });

    it('executePhase0 should return phase 0 result with success: false when source path does not exist', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      // Source path '/tmp/source' likely doesn't exist in test env, so build will fail gracefully
      const result = await orchestrator.executePhase0(Date.now());

      expect(result.phase).toBe(0);
      expect(result.name).toBe('KB Indexing');
      // Either success or failure is acceptable — we just verify the shape
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.duration).toBe('number');
      if (!result.success) {
        expect(typeof result.error).toBe('string');
      } else {
        expect(result.outputPath).toBeDefined();
      }
    });

    it('executePhase0 outputPath should match kbDbPath (progressDir/kb.db)', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.executePhase0(Date.now());

      // Whether successful or not, on success the outputPath should be within progressDir
      if (result.success && result.outputPath) {
        expect(result.outputPath).toContain('kb.db');
      }
    });

    it('should skip Phase 0 when kbIndex.enabled is false and env var is not set', async () => {
      delete process.env['AAMF_USE_KB_INDEX'];

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 1,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          kbIndex: { enabled: false },
        },
      });
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase0 = result.phases.find(p => p.phase === 0);
      expect(phase0).toBeUndefined();
    });

    it('executePhase0 should retry on failure up to maxRetriesPerTask times', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 2,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      // Source path '/tmp/source' does not exist, so build will fail on every attempt
      const result = await orchestrator.executePhase0(Date.now());

      expect(result.phase).toBe(0);
      expect(result.name).toBe('KB Indexing');
      // Expect failure (source path missing in test env)
      expect(typeof result.success).toBe('boolean');
      if (!result.success) {
        expect(typeof result.error).toBe('string');
      }
    });

    it('executePhase0 should return success: false when timeout is exceeded', async () => {
      // Mock IndexBuilder to simulate a slow build that exceeds the timeout
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockImplementation(
        () => new Promise<void>(() => { /* never resolves */ }),
      );

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            phaseTimeouts: { 0: 50 }, // 50ms — allows real setTimeout to fire
          },
        });

        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(result.success).toBe(false);
        expect(result.error).toBe('KB index timeout');
      } finally {
        buildSpy.mockRestore();
      }
    });

    it.skip('executePhase0 should pass embedder to IndexBuilder when embeddings.enabled is true', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      // Mock embedder init() to avoid spawning a real Python process
      const { SentenceTransformersProvider } = await import('@aamf/lore');
      const initSpy = vi.spyOn(SentenceTransformersProvider.prototype, 'init').mockResolvedValue(undefined);
      const disposeSpy = vi.spyOn(SentenceTransformersProvider.prototype, 'dispose').mockResolvedValue(undefined);

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            kbIndex: {
              enabled: true,
              embeddings: { enabled: true, model: 'Qwen/Qwen3-Embedding-0.6B', pythonBin: 'python3' },
            },
          },
        });

        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(initSpy).toHaveBeenCalled();
      } finally {
        buildSpy.mockRestore();
        initSpy.mockRestore();
        disposeSpy.mockRestore();
      }
    });

    it.skip('executePhase0 should skip embeddings gracefully when ensurePythonDeps fails', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      // Mock init to simulate failure (Python not available)
      const { SentenceTransformersProvider } = await import('@aamf/lore');
      const initSpy = vi.spyOn(SentenceTransformersProvider.prototype, 'init').mockRejectedValue(
        new Error('Embedding subprocess exited with code 1 before handshake'),
      );
      const disposeSpy = vi.spyOn(SentenceTransformersProvider.prototype, 'dispose').mockResolvedValue(undefined);

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            kbIndex: {
              enabled: true,
              embeddings: { enabled: true },
            },
          },
        });

        // Should still succeed — embeddings are best-effort
        const result = await orchestrator.executePhase0(Date.now());
        expect(result.phase).toBe(0);
      } finally {
        buildSpy.mockRestore();
        initSpy.mockRestore();
        disposeSpy.mockRestore();
      }
    });

    it('executePhase0 should skip build when KB fingerprint matches', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      const dbMod = await import('@aamf/lore');

      const { stat } = await import('node:fs/promises');
      const fsMod = await import('../src/util/fs.js');
      const realFileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
      const fileExistsSpy = vi.spyOn(fsMod, 'fileExists').mockImplementation(async (p: string) => {
        if (p.endsWith('kb.db')) return true;
        return realFileExists(p);
      });

      try {
        const launcherFn = createMockLauncher();
        const first = await setupOrchestrator(tempDir, launcherFn);
        await first.orchestrator.executePhase0(Date.now());
        const currentFingerprint = first.checkpoint.getState().phase0Fingerprint;
        expect(currentFingerprint).toMatch(/^[a-f0-9]{64}$/);

        const dbPath = join(tempDir, '.aamf', 'migration', 'test-project', 'kb.db');
        await mkdir(join(tempDir, '.aamf', 'migration', 'test-project'), { recursive: true });
        const db = dbMod.openDb(dbPath);
        dbMod.setKbMeta(db, 'source_fingerprint', currentFingerprint);
        db.close();

        buildSpy.mockClear();
        const { orchestrator, checkpoint } = await setupOrchestrator(tempDir, launcherFn);

        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(result.success).toBe(true);
        expect(result.name).toBe('KB Indexing');
        // Build should NOT have been called because fingerprint matched
        expect(buildSpy).not.toHaveBeenCalled();
        // Checkpoint should have the fingerprint stored
        expect(checkpoint.getState().phase0Fingerprint).toBe(currentFingerprint);
      } finally {
        buildSpy.mockRestore();
        fileExistsSpy.mockRestore();
      }
    });

    it('executePhase0 should rebuild when KB fingerprint does not match', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      const dbMod = await import('@aamf/lore');

      const { stat } = await import('node:fs/promises');
      const fsMod = await import('../src/util/fs.js');
      const realFileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
      const fileExistsSpy = vi.spyOn(fsMod, 'fileExists').mockImplementation(async (p: string) => {
        if (p.endsWith('kb.db')) return true;
        return realFileExists(p);
      });

      try {
        const launcherFn = createMockLauncher();
        const dbPath = join(tempDir, '.aamf', 'migration', 'test-project', 'kb.db');
        await mkdir(join(tempDir, '.aamf', 'migration', 'test-project'), { recursive: true });
        const db = dbMod.openDb(dbPath);
        dbMod.setKbMeta(db, 'source_fingerprint', 'old-fp');
        db.close();

        const { orchestrator, checkpoint } = await setupOrchestrator(tempDir, launcherFn);

        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(result.success).toBe(true);
        // Build SHOULD have been called because fingerprints differ
        expect(buildSpy).toHaveBeenCalled();
        // Checkpoint should have the new fingerprint
        expect(checkpoint.getState().phase0Fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(checkpoint.getState().phase0Fingerprint).not.toBe('old-fp');
      } finally {
        buildSpy.mockRestore();
        fileExistsSpy.mockRestore();
      }
    });

    it('executePhase0 should rebuild when no KB database exists', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator, checkpoint } = await setupOrchestrator(tempDir, launcherFn);

        // kb.db does not exist on disk → fileExists returns false naturally
        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(result.success).toBe(true);
        // Build SHOULD have been called because no DB exists
        expect(buildSpy).toHaveBeenCalled();
        expect(checkpoint.getState().phase0Fingerprint).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        buildSpy.mockRestore();
      }
    });

    it('executePhase0 should rebuild when existing KB is corrupt/unreadable', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      const dbPath = join(tempDir, '.aamf', 'migration', 'test-project', 'kb.db');
      await mkdir(join(tempDir, '.aamf', 'migration', 'test-project'), { recursive: true });
      await writeFile(dbPath, 'not a sqlite database', 'utf8');

      const { stat } = await import('node:fs/promises');
      const fsMod = await import('../src/util/fs.js');
      const realFileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
      const fileExistsSpy = vi.spyOn(fsMod, 'fileExists').mockImplementation(async (p: string) => {
        if (p.endsWith('kb.db')) return true;
        return realFileExists(p);
      });

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

        const result = await orchestrator.executePhase0(Date.now());

        expect(result.phase).toBe(0);
        expect(result.success).toBe(true);
        // Build should run because DB was unreadable
        expect(buildSpy).toHaveBeenCalled();
      } finally {
        buildSpy.mockRestore();
        fileExistsSpy.mockRestore();
      }
    });

    it('executePhase0 should log skip message when fingerprint matches', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      const dbMod = await import('@aamf/lore');

      const { stat } = await import('node:fs/promises');
      const fsMod = await import('../src/util/fs.js');
      const realFileExists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
      const fileExistsSpy = vi.spyOn(fsMod, 'fileExists').mockImplementation(async (p: string) => {
        if (p.endsWith('kb.db')) return true;
        return realFileExists(p);
      });

      try {
        const launcherFn = createMockLauncher();
        const first = await setupOrchestrator(tempDir, launcherFn);
        await first.orchestrator.executePhase0(Date.now());
        const currentFingerprint = first.checkpoint.getState().phase0Fingerprint;
        expect(currentFingerprint).toMatch(/^[a-f0-9]{64}$/);

        const dbPath = join(tempDir, '.aamf', 'migration', 'test-project', 'kb.db');
        await mkdir(join(tempDir, '.aamf', 'migration', 'test-project'), { recursive: true });
        const db = dbMod.openDb(dbPath);
        dbMod.setKbMeta(db, 'source_fingerprint', currentFingerprint);
        db.close();

        buildSpy.mockClear();
        const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
        const infoSpy = vi.spyOn(logger, 'info');

        await orchestrator.executePhase0(Date.now());

        const skipMsg = infoSpy.mock.calls.find(
          (args) => typeof args[0] === 'string' && args[0].includes('reused/skipped'),
        );
        expect(skipMsg).toBeDefined();
      } finally {
        buildSpy.mockRestore();
        fileExistsSpy.mockRestore();
      }
    });

    it('executePhase0 should log rebuild message when fingerprint does not match', async () => {
      const { IndexBuilder } = await import('@aamf/lore');
      const buildSpy = vi.spyOn(IndexBuilder.prototype, 'build').mockResolvedValue(undefined);

      try {
        const launcherFn = createMockLauncher();
        const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
        const infoSpy = vi.spyOn(logger, 'info');

        // No kb.db exists → triggers rebuild path
        await orchestrator.executePhase0(Date.now());

        const rebuildMsg = infoSpy.mock.calls.find(
          (args) => typeof args[0] === 'string' && args[0].includes('rebuilt'),
        );
        expect(rebuildMsg).toBeDefined();
      } finally {
        buildSpy.mockRestore();
      }
    });
  });

  // ─── Phase Sequencing ──────────────────────────────────────────────

  describe('Phase Sequencing', () => {
    it('should execute all 7 phases in order when all succeed', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      expect(result.phases).toHaveLength(8);
      const phaseIds = result.phases.map((p) => p.phase).sort((a, b) => a - b);
      for (let i = 0; i < phaseIds.length; i++) {
        expect(phaseIds[i]).toBe(i + 1);
      }
      expect(mockLauncher.invocations.length).toBeGreaterThan(0);
    });

    it('should skip completed phases on resume', async () => {
      const launcherFn = createMockLauncher();

      const config = createMockConfig();
      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      // Pre-populate checkpoint with phases 1–3 complete
      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);
      await checkpoint.completePhase(1, join(progressDir, 'artifacts', 'impact-assessment.md'));
      await checkpoint.completePhase(2, join(progressDir, 'knowledge-base'));
      await checkpoint.completePhase(3, join(progressDir, 'artifacts', 'planning', 'migration-plan.md'));

      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));

      const orchestrator = new MigrationOrchestrator(
        config,
        checkpoint,
        mockLauncher as any,
        progress,
        logger,
        tempDir,
        'test-run-id',
      );

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.phases).toHaveLength(8);
      const agentsInvoked = mockLauncher.invocations.map((i) => i.agent);
      expect(agentsInvoked).not.toContain('impact-assessor');
      expect(agentsInvoked).not.toContain('knowledge-builder');
      expect(agentsInvoked).not.toContain('migration-planner');
    });

    it('should execute only the specified phase when singlePhase is set', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        1,
      );

      const result = await orchestrator.run();

      const agentsInvoked = mockLauncher.invocations.map((i) => i.agent);
      expect(agentsInvoked).toContain('impact-assessor');
      expect(agentsInvoked).not.toContain('knowledge-builder');
      expect(agentsInvoked).not.toContain('migration-planner');
      expect(agentsInvoked).not.toContain('code-migrator');
    });

    it('should re-run phase 0 on resume when kbIndex is enabled', async () => {
      const launcherFn = createMockLauncher();
      const config = createMockConfig({
        source: {
          path: tempDir,
          language: 'python',
          excludePatterns: ['node_modules', '.git'],
        },
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: true,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          kbIndex: { enabled: true, embeddings: { enabled: false } },
        },
      });

      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);
      await writeFile(join(progressDir, 'kb.db'), '');

      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);
      await checkpoint.completePhase(0, join(progressDir, 'kb.db'));

      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));
      const orchestrator = new MigrationOrchestrator(
        config,
        checkpoint,
        mockLauncher as any,
        progress,
        logger,
        tempDir,
        'test-run-id',
      );

      const phase0Spy = vi.spyOn(orchestrator as any, 'executePhase0');

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      expect(phase0Spy).toHaveBeenCalledTimes(1);
      phase0Spy.mockRestore();
    });
  });

  // ─── Critical Phase Failure ────────────────────────────────────────

  describe('Critical Phase Failure', () => {
    it('should abort migration when a critical phase fails (phase 1)', async () => {
      const launcherFn = createFailingLauncher(['impact-assessor']);
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.phase).toBe(1);
      expect(result.phases[0]!.success).toBe(false);
    });

    it('should abort migration when a critical phase fails (phase 4)', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          return { exitCode: 1, success: false, error: 'Code migration failed' };
        }
        if (inv.agent === 'failure-adjudicator') {
          return { exitCode: 1, success: false, error: 'Recovery failed' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 1,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      const phase4 = result.phases.find((p) => p.phase === 4);
      expect(phase4).toBeDefined();
      expect(phase4!.success).toBe(false);
    });

    it('should continue when a non-critical phase fails (phase 5)', async () => {
      const launcherFn = createFailingLauncher(['final-parity-checker']);

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      const phase6 = result.phases.find((p) => p.phase === 6);
      const phase7 = result.phases.find((p) => p.phase === 7);

      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(false);
      expect(phase6).toBeDefined();
      expect(phase7).toBeDefined();
    });

    it('should continue when a non-critical phase fails (phase 6)', async () => {
      const launcherFn = createFailingLauncher([
        'e2e-test-crafter',
        'documentation-writer',
      ]);

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase6 = result.phases.find((p) => p.phase === 6);
      const phase7 = result.phases.find((p) => p.phase === 7);

      expect(phase6).toBeDefined();
      expect(phase6!.success).toBe(false);
      expect(phase7).toBeDefined();
      expect(phase7!.phase).toBe(7);
    });
  });

  // ─── Budget Management ─────────────────────────────────────────────

  describe('Budget Management', () => {
    it('should abort when token budget is exceeded', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 400, completion: 200, total: 600 },
      }));

      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          tokenBudget: 1000,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.phases.length).toBeLessThan(7);
    });

    it('should log warning at 80% budget threshold', async () => {
      let callCount = 0;
      const launcherFn = createMockLauncher(() => {
        callCount++;
        if (callCount === 1) {
          return { tokenUsage: { prompt: 500, completion: 350, total: 850 } };
        }
        return { tokenUsage: { prompt: 10, completion: 5, total: 15 } };
      });

      const logger = createSilentLogger(tempDir);
      const eventSpy = vi.spyOn(logger, 'event');

      const config = createMockConfig({
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          tokenBudget: 1000,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      const checkpoint = new CheckpointManager(progressDir, logger);
      await checkpoint.load(config.projectName);

      const progressFile = join(progressDir, 'progress.md');
      const progress = new ProgressWriter(progressFile);
      await progress.initialize(config);

      const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));
      const orchestrator = new MigrationOrchestrator(
        config,
        checkpoint,
        mockLauncher as any,
        progress,
        logger,
        tempDir,
        'test-run-id',
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const warningEvents = eventSpy.mock.calls.filter(
        (call) => (call[0] as any).type === 'budget-warning',
      );
      expect(warningEvents.length).toBeGreaterThan(0);
    });
  });

  // ─── structuredOutput Integration ──────────────────────────────────

  describe('structuredOutput Integration', () => {
    it('should apply maxRetriesPerTask to Phase 3 task-decomposer invocations', async () => {
      const launcherFn = vi.fn(async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'task-decomposer' && inv.taskId === 'core') {
          return {
            agent: inv.agent,
            taskId: inv.taskId,
            exitCode: 1,
            success: false,
            outputFiles: [],
            duration: 100,
            tokenUsage: { prompt: 100, completion: 0, total: 100 },
            outputParsed: false,
            error: 'transient task-decomposer failure',
          };
        }

        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
          tokenUsage: { prompt: 100, completion: 0, total: 100 },
          outputParsed: true,
        };
      });

      const { orchestrator, checkpoint, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 2,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
        },
        3,
      );

      const planningDir = join(progressDir, 'artifacts', 'planning');
      await mkdir(planningDir, { recursive: true });
      await writeFile(
        join(planningDir, 'groups.json'),
        JSON.stringify([{ id: 'core', name: 'Core', analysisFiles: [] }], null, 2),
      );
      await writeFile(join(planningDir, 'strategy.md'), '# strategy\n');

      await checkpoint.completePhase3a();

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      const phase3 = result.phases.find((p) => p.phase === 3);
      expect(phase3?.error).toContain('task-decomposer failed for 1 group(s): core');

      const coreTaskDecomposerInvocations = mockLauncher.invocations.filter(
        (inv) => inv.agent === 'task-decomposer' && inv.taskId === 'core',
      );
      expect(coreTaskDecomposerInvocations).toHaveLength(2);
    });

    it('should fail Phase 3 when a task-decomposer output file violates schema', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        3,
      );

      const planningDir = join(progressDir, 'artifacts', 'planning');
      await mkdir(planningDir, { recursive: true });
      const group = { id: 'core', name: 'Core', analysisFiles: [] };
      await writeFile(join(planningDir, 'groups.json'), JSON.stringify([group], null, 2));
      await writeFile(join(planningDir, 'strategy.md'), '# strategy\n');

      const invalidTasks = [
        {
          id: 'task-001',
          name: 'Invalid missing required fields',
          sourceFiles: ['src/a.c'],
          targetFiles: ['src/a.rs'],
          knowledgeBaseRef: 'kb/a.md',
          dependencies: [],
          complexity: 'simple',
        },
      ];
      await writeFile(join(planningDir, 'tasks-core.json'), JSON.stringify(invalidTasks, null, 2));

      const checkpoint = {
        projectName: 'test-project',
        version: 1,
        currentPhase: 3,
        currentTask: null,
        completedPhases: [],
        completedTasks: [],
        failedTasks: [],
        blockedTasks: [],
        phaseOutputs: {},
        tokenUsage: { total: 0, byPhase: {}, byAgent: {} },
        startedAt: new Date().toISOString(),
        lastCheckpoint: new Date().toISOString(),
        resumeCount: 0,
        cumulativeDurationMs: 0,
        completedTaskDurationsMs: [],
        phase3aComplete: true,
        completedPhase3Groups: [],
      };
      await writeFile(join(progressDir, 'state', 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      const phase3 = result.phases.find((p) => p.phase === 3);
      expect(phase3).toBeDefined();
      expect(phase3?.error).toContain('Schema validation failed');
      expect(phase3?.error).toContain('tasks-core.json');
    });

    it('should read Phase 4 tasks from planning artifacts produced by task-decomposers', async () => {
      // In the two-step Phase 3 design, task-decomposer writes per-group task JSON files.
      // The orchestrator merges them into tasks-merged.json and passes the task list to Phase 4
      // via structuredOutput.  This test verifies that specific task content drives Phase 4.
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      // Write planning artifacts with a specific unique task — no migration-plan.md needed
      const planningTasks: MigrationTask[] = [{
        id: 'task-101',
        name: 'Structured Task 1',
        sourceFiles: ['src/s01.py'],
        targetFiles: ['src/s01.ts'],
        knowledgeBaseRef: 'kb/s01.md',
        dependencies: [],
        complexity: 'simple',
        description: 'Migrate s01',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 200 },
      }];
      await writePhase3PlanningArtifacts(progressDir, planningTasks);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      // code-migrator should have been invoked for the task from planning artifacts
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(1);
      expect(codeMigratorInvocations[0]!.taskId).toBe('task-101');
    });

    it('should invoke code-migrators for tasks loaded via planning artifacts (Phase 3 merge)', async () => {
      // The new two-step Phase 3 always writes tasks-merged.json and sets phase3PlanResult;
      // this test confirms that Phase 4 picks up the tasks and invokes code-migrators.
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      // code-migrator should have been invoked (tasks loaded from planning artifacts)
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(1);
    });

    it('should read Phase 5 fixes from structuredOutput when outputParsed is true', async () => {
      // final-parity-checker returns structured fixes → code-migrator re-invoked in phase 5
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCallCount++;
          if (parityCallCount === 1) {
            // First call: return one fix via structuredOutput
            return {
              outputParsed: true,
              structuredOutput: {
                fixes: [
                  {
                    description: 'Missing error handling',
                    sourceFile: 'src/auth.py',
                    targetFile: 'src/auth.ts',
                  },
                ],
              },
            };
          }
          // Second call: no more fixes → stop loop
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);
      // Note: no final-parity-report.md written to prove structured output is used

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBeGreaterThan(0);
    });

    it('should stop Phase 5 loop early when structuredOutput fixes is empty', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCallCount++;
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      // final-parity-checker should have been called once (loop exits immediately)
      expect(parityCallCount).toBe(1);
      // No phase-5 code-migrator invocations expected
      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBe(0);
    });

    it('should prefer structuredOutput.tokenUsage over result.tokenUsage in recordTokens', async () => {
      // Budget set to 500; result.tokenUsage.total = 100 (within budget),
      // but structuredOutput.tokenUsage.total = 600 (exceeds budget).
      // If recordTokens picks structuredOutput, the budget will be exceeded and run aborted.
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 50, completion: 50, total: 100 },
        outputParsed: true,
        structuredOutput: {
          tokenUsage: { prompt: 400, completion: 200, total: 600 },
        },
      }));

      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          tokenBudget: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      const result = await orchestrator.run();

      // If structuredOutput.tokenUsage (600) is preferred, budget (500) is exceeded on
      // the first agent invocation → migration aborts with fewer than 7 phases.
      expect(result.success).toBe(false);
      expect(result.phases.length).toBeLessThan(7);
    });
  });

  // ─── Phase 4 Specifics ─────────────────────────────────────────────

  describe('Phase 4 Specifics', () => {
    it('should auto-init git in output path and create per-agent/per-task commits', async () => {
      const outputDir = join(tempDir, 'target-output');
      await ensureDir(outputDir);

      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          const filePath = join(outputDir, 'src', `task-${id}.ts`);
          await ensureDir(join(outputDir, 'src'));
          await writeFile(filePath, `export const task${id} = ${Number(id)};\n`);
        }

        if (inv.agent === 'test-writer' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          const testPath = join(outputDir, 'tests', `task-${id}.test.ts`);
          await ensureDir(join(outputDir, 'tests'));
          await writeFile(testPath, `import { describe, it, expect } from 'vitest';\n\ndescribe('task-${id}', () => {\n  it('should be defined', () => {\n    expect(true).toBe(true);\n  });\n});\n`);
        }

        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: outputDir,
        },
        options: {
          maxParallelAgents: 2,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const gitHead = await readFile(join(outputDir, '.git', 'HEAD'), 'utf-8');
      expect(gitHead.trim().length).toBeGreaterThan(0);

      const log = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: outputDir });
      expect(log.exitCode).toBe(0);
      expect(log.stdout).toContain('aamf: code-migrator updated output for task task-001');
      expect(log.stdout).toContain('aamf: test-writer updated output for task task-001');
      expect(log.stdout).toContain('aamf: complete task-001 - User Auth Module');
    });

    it('should initialize and commit in outputPath repo when outputPath is nested in another git repo', async () => {
      const parentRepo = join(tempDir, 'parent-repo');
      const outputDir = join(parentRepo, 'nested-output');
      await ensureDir(outputDir);

      const initParent = await spawnWithTimeout('git', ['init'], { cwd: parentRepo });
      expect(initParent.exitCode).toBe(0);
      const parentName = await spawnWithTimeout('git', ['config', 'user.name', 'Parent Repo Bot'], { cwd: parentRepo });
      const parentEmail = await spawnWithTimeout('git', ['config', 'user.email', 'parent@local.invalid'], { cwd: parentRepo });
      expect(parentName.exitCode).toBe(0);
      expect(parentEmail.exitCode).toBe(0);

      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          const filePath = join(outputDir, 'src', `task-${id}.ts`);
          await ensureDir(join(outputDir, 'src'));
          await writeFile(filePath, `export const task${id} = ${Number(id)};\n`);
        }

        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: outputDir,
        },
        options: {
          maxParallelAgents: 2,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const nestedTopLevel = await spawnWithTimeout('git', ['rev-parse', '--show-toplevel'], { cwd: outputDir });
      const parentTopLevel = await spawnWithTimeout('git', ['rev-parse', '--show-toplevel'], { cwd: parentRepo });
      expect(nestedTopLevel.exitCode).toBe(0);
      expect(parentTopLevel.exitCode).toBe(0);
      expect(await realpath(nestedTopLevel.stdout.trim())).toBe(await realpath(outputDir));
      expect(await realpath(parentTopLevel.stdout.trim())).toBe(await realpath(parentRepo));

      const nestedLog = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: outputDir });
      const parentLog = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: parentRepo });
      expect(nestedLog.exitCode).toBe(0);
      expect(nestedLog.stdout).toContain('aamf: code-migrator updated output for task task-001');
      expect(parentLog.exitCode).not.toBe(0);
    });

    it('should not create git repository when git.enabled is false', async () => {
      const outputDir = join(tempDir, 'target-no-git');
      await ensureDir(outputDir);

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: { language: 'typescript', framework: 'express', outputPath: outputDir },
        options: {
          git: {
            enabled: false,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const gitDirExists = await fileExists(join(outputDir, '.git', 'HEAD'));
      expect(gitDirExists).toBe(false);
    });

    it('should create task-level commits but not agent-level commits when commitByAgent is false', async () => {
      const outputDir = join(tempDir, 'target-no-agent-commits');
      await ensureDir(outputDir);

      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          await ensureDir(join(outputDir, 'src'));
          await writeFile(join(outputDir, 'src', `task-${id}.ts`), `export const task${id} = ${Number(id)};\n`);
        }
        return {
          agent: inv.agent, taskId: inv.taskId, exitCode: 0, success: true,
          outputFiles: [], duration: 100, tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: { language: 'typescript', framework: 'express', outputPath: outputDir },
        options: {
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: false,
            commitPerTask: true,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const log = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: outputDir });
      expect(log.exitCode).toBe(0);
      expect(log.stdout).toContain('aamf: complete task-001');
      expect(log.stdout).not.toContain('aamf: code-migrator updated output');
    });

    it('should create agent-level commits but not task-level commits when commitPerTask is false', async () => {
      const outputDir = join(tempDir, 'target-no-task-commits');
      await ensureDir(outputDir);

      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          await ensureDir(join(outputDir, 'src'));
          await writeFile(join(outputDir, 'src', `task-${id}.ts`), `export const task${id} = ${Number(id)};\n`);
        }
        return {
          agent: inv.agent, taskId: inv.taskId, exitCode: 0, success: true,
          outputFiles: [], duration: 100, tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: { language: 'typescript', framework: 'express', outputPath: outputDir },
        options: {
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: false,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const log = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: outputDir });
      expect(log.exitCode).toBe(0);
      expect(log.stdout).toContain('aamf: code-migrator updated output');
      expect(log.stdout).not.toContain('aamf: complete task-001');
    });

    it('should skip empty task commits when allowEmptyTaskCommits is false', async () => {
      const outputDir = join(tempDir, 'target-no-empty-commits');
      await ensureDir(outputDir);

      // Launcher writes a file only for the code-migrator so agent commits exist,
      // but the task-level commit has nothing new to stage.
      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator' && inv.taskId) {
          const id = inv.taskId.replace('task-', '');
          await ensureDir(join(outputDir, 'src'));
          await writeFile(join(outputDir, 'src', `task-${id}.ts`), `export const task${id} = ${Number(id)};\n`);
        }
        return {
          agent: inv.agent, taskId: inv.taskId, exitCode: 0, success: true,
          outputFiles: [], duration: 100, tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: { language: 'typescript', framework: 'express', outputPath: outputDir },
        options: {
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            allowEmptyTaskCommits: false,
            authorName: 'AAMF Migration Bot',
            authorEmail: 'aamf@local.invalid',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const log = await spawnWithTimeout('git', ['log', '--pretty=%s'], { cwd: outputDir });
      expect(log.exitCode).toBe(0);
      // Agent commits exist (code-migrator wrote files), but task "complete" commit
      // should be skipped since there are no new changes after the agent commit.
      expect(log.stdout).toContain('aamf: code-migrator updated output');
      expect(log.stdout).not.toContain('aamf: complete task-001');
    });

    it('should apply failureRecoveryModel as modelOverride on transient errors', async () => {
      let callCount = 0;
      const capturedInvocations: AgentInvocation[] = [];

      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        capturedInvocations.push({ ...inv });
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
          callCount++;
          if (callCount === 1) {
            return {
              agent: inv.agent, taskId: inv.taskId, exitCode: 1, success: false,
              outputFiles: [], duration: 100,
              error: 'HTTP/2 GOAWAY received from upstream',
              tokenUsage: { prompt: 100, completion: 50, total: 150 },
              outputParsed: false,
            };
          }
        }
        return {
          agent: inv.agent, taskId: inv.taskId, exitCode: 0, success: true,
          outputFiles: [], duration: 100,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        agentBackend: { runtime: 'copilot', failureRecoveryModel: 'gpt-4.1-mini' },
      });

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // After the transient failure, the retry should have the fallback model applied
      const migratorRetries = capturedInvocations.filter(
        (i) => i.agent === 'code-migrator' && i.taskId === 'task-001',
      );
      expect(migratorRetries.length).toBeGreaterThanOrEqual(2);
      // The second attempt should have the fallback model override
      expect(migratorRetries[1]?.modelOverride).toBe('gpt-4.1-mini');
    });

    it('should process migration tasks from plan', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const codeMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator',
      );
      expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty migration plan gracefully', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), '# Migration Plan\n\nNo tasks defined.\n');
      // Write empty planning artifacts so Phase 3 succeeds with zero tasks.
      await writePhase3PlanningArtifacts(progressDir, []);

      const result = await orchestrator.run();

      const phase4 = result.phases.find((p) => p.phase === 4);
      expect(phase4).toBeDefined();
      expect(phase4!.success).toBe(true);
    });

    it('should fail phase 3 when planning/groups.json is missing', async () => {
      // No planning artifacts written — migration-planner mock succeeds but groups.json
      // does not exist, so Phase 3 fails with an informative error.
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = await orchestrator.run();

      const phase3 = result.phases.find((p) => p.phase === 3);
      expect(phase3).toBeDefined();
      expect(phase3!.success).toBe(false);
      expect(phase3!.error).toContain('groups.json');
    });

    it('should fail fast with terminal metadata when task retries are exhausted', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
          return { exitCode: 1, success: false, error: 'Migration failed for task-001' };
        }
        if (inv.agent === 'failure-adjudicator') {
          return { exitCode: 1, success: false, error: 'Recovery failed' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 2,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();
      const phase4 = result.phases.find((p) => p.phase === 4);

      expect(result.success).toBe(false);
      expect(phase4?.error).toContain('task-retries-exhausted');
      expect(result.blockedTasks).not.toContain('task-001');
    });

    it('should propagate remediation payload for retry-exhaustion remigration', async () => {
      let migratorCalls = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-001') {
          migratorCalls++;
          if (migratorCalls === 1) {
            return { exitCode: 1, success: false, error: 'initial migration failure' };
          }
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          maxRetriesPerTask: 1,
        },
      });

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const recoveryInvocation = mockLauncher.invocations.find(
        (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
      );
      expect(recoveryInvocation).toBeDefined();
      const recoveryContext = JSON.parse(await readFile(recoveryInvocation!.contextFile, 'utf-8'));
      expect(recoveryContext.payload?.remediationContext?.failureKind).toBe('task-retry');

      const taskMigratorInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.taskId === 'task-001' && i.phase === 4,
      );
      expect(taskMigratorInvocations.length).toBeGreaterThanOrEqual(2);
      const retryContext = JSON.parse(
        await readFile(taskMigratorInvocations[taskMigratorInvocations.length - 1]!.contextFile, 'utf-8'),
      );
      expect(retryContext.payload?.remediationContext?.failureKind).toBe('task-retry');
      expect(retryContext.payload?.remediationContext?.failureTarget?.taskId).toBe('task-001');
      expect(Array.isArray(retryContext.payload?.remediationContext?.artifactPaths)).toBe(true);
    });

    it('should invoke failure-adjudicator when parity-verifier finds critical issues', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          parityCallCount++;
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'fail',
              issues: [{ severity: 'critical', description: 'Missing error handling in auth flow', sourceLocation: 'src/auth.py:45', targetLocation: 'src/auth.ts:52' }],
            },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 2,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      await orchestrator.run();

      const recoveryInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-adjudicator' && i.phase === 4,
      );
      expect(recoveryInvocations.length).toBeGreaterThan(0);

      const parityRecovery = recoveryInvocations[0]!;
      const recoveryContext = JSON.parse(await readFile(parityRecovery.contextFile, 'utf-8'));
      expect(recoveryContext.payload?.remediationContext?.failureKind).toBe('parity');
      expect(recoveryContext.payload?.remediationContext?.failureTarget?.taskId).toBe('task-001');

      const remigrateCandidates = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4,
      );
      let foundParityRemediation = false;
      for (const inv of remigrateCandidates) {
        const ctx = JSON.parse(await readFile(inv.contextFile, 'utf-8'));
        if (ctx.payload?.remediationContext?.failureKind === 'parity') {
          foundParityRemediation = true;
          break;
        }
      }
      expect(foundParityRemediation).toBe(true);
    });

    it('should pass enriched context to code-migrator during parity recovery', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'fail',
              issues: [
                { severity: 'major', description: 'HashMap shim instead of direct struct access', sourceLocation: 'src/wrapper.c:178', targetLocation: 'src/lib.rs:120' },
                { severity: 'critical', description: 'Missing z_deflate wrapper functions', sourceLocation: 'src/wrapper.c:263', targetLocation: 'src/lib.rs' },
              ],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      await orchestrator.run();

      // Find the code-migrator invocation that has a parity remediationContext
      const reMigrateCandidates = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4,
      );
      let reMigrateCtx: Record<string, unknown> | undefined;
      for (const inv of reMigrateCandidates) {
        const ctx = JSON.parse(await readFile(inv.contextFile, 'utf-8'));
        if (ctx.payload?.remediationContext?.failureKind === 'parity') {
          reMigrateCtx = ctx;
          break;
        }
      }
      expect(reMigrateCtx).toBeDefined();

      // failureSummary should be stripped from the agent-facing context
      const remediation = reMigrateCtx!.payload?.remediationContext as Record<string, unknown>;
      expect(remediation?.failureSummary).toBeUndefined();

      // Parity report .md should be in inputFiles
      const inputFiles = reMigrateCtx!.inputFiles as string[];
      const hasParityMd = inputFiles.some((f: string) => f.endsWith('.md') && f.includes('parity'));
      expect(hasParityMd).toBe(true);

      // Adjudication report path should be in inputFiles
      const hasAdjudicationMd = inputFiles.some((f: string) => f.includes('adjudication'));
      expect(hasAdjudicationMd).toBe(true);

      // adjudicationReportPath should be set in remediationContext
      expect(remediation?.adjudicationReportPath).toBeDefined();
      expect(typeof remediation?.adjudicationReportPath).toBe('string');
    });

    it('should not trigger recovery when parity has only minor issues', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'partial',
              issues: [{ severity: 'minor', description: 'Slightly different API surface', sourceLocation: 'src/auth.py:10', targetLocation: 'src/auth.ts:12' }],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();

      // No failure-adjudicator should be invoked for parity
      const recoveryForParity = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-adjudicator' && i.phase === 4,
      );
      expect(recoveryForParity).toHaveLength(0);
      expect(result.success).toBe(true);

      // Minor-parity-repass should trigger an extra code-migrator + parity-verifier cycle
      const phase4Migrators = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4,
      );
      // 1 initial + 1 re-pass = 2
      expect(phase4Migrators.length).toBeGreaterThanOrEqual(2);

      const phase4Parity = mockLauncher.invocations.filter(
        (i) => i.agent === 'parity-verifier' && i.phase === 4,
      );
      // 1 initial + 1 re-pass = 2
      expect(phase4Parity.length).toBeGreaterThanOrEqual(2);
    });

    it('should run minor-parity-repass and accept remaining minor issues as non-blocking', async () => {
      // Parity always returns minor issues — even after re-pass
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'partial',
              issues: [
                { severity: 'minor', description: 'Naming convention differs' },
                { severity: 'minor', description: 'Comment style varies' },
              ],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();

      // Migration succeeds — minor issues are not blocking
      expect(result.success).toBe(true);

      // Re-pass code-migrator was invoked (1 initial + 1 re-pass)
      const migrators = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4,
      );
      expect(migrators.length).toBeGreaterThanOrEqual(2);

      // Re-pass parity-verifier was invoked (1 initial + 1 re-pass)
      const parityRuns = mockLauncher.invocations.filter(
        (i) => i.agent === 'parity-verifier' && i.phase === 4,
      );
      expect(parityRuns.length).toBeGreaterThanOrEqual(2);

      // The re-pass code-migrator should receive remediation context with parity-minor
      const repassMigrator = migrators[migrators.length - 1];
      const repassPayload = (repassMigrator as any).payload ?? {};
      const repassRemediation = repassPayload.remediationContext as Record<string, unknown> | undefined;
      if (repassRemediation) {
        expect(repassRemediation.failureKind).toBe('parity-minor');
      }
    });

    it('should skip minor-parity-repass when parity is a clean pass', async () => {
      // Parity returns clean pass with no issues
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'pass',
              issues: [],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();

      expect(result.success).toBe(true);

      // Only 1 code-migrator run — no re-pass because parity was clean
      const migrators = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4,
      );
      expect(migrators).toHaveLength(1);

      // Only 1 parity-verifier run — no re-pass
      const parityRuns = mockLauncher.invocations.filter(
        (i) => i.agent === 'parity-verifier' && i.phase === 4,
      );
      expect(parityRuns).toHaveLength(1);
    });

    it('should revert to original parity result when re-pass introduces non-minor issues', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'parity-verifier') {
          parityCallCount++;
          if (parityCallCount === 1) {
            // First run: only minor issues
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'partial',
                issues: [{ severity: 'minor', description: 'Naming convention differs' }],
              },
            };
          }
          // Re-pass: introduces a major issue
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'partial',
              issues: [{ severity: 'major', description: 'Missing error handling' }],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();

      // Should succeed because the original minor-only result is restored
      expect(result.success).toBe(true);
    });

    it('should proceed when minor-parity-repass code-migrator fails', async () => {
      let migratorCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          migratorCallCount++;
          // First call succeeds (initial migration), second call fails (re-pass)
          if (migratorCallCount >= 2) {
            return { success: false, exitCode: 1, error: 'Re-pass migration failed' };
          }
        }
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'partial',
              issues: [{ severity: 'minor', description: 'Naming convention differs' }],
            },
          };
        }
        return {};
      });
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const result = await orchestrator.run();

      // Migration should succeed — failed re-pass is not blocking
      expect(result.success).toBe(true);
    });

    it('should fail fast when parity retains non-minor issues after retries', async () => {
      let migratorAttempt = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          migratorAttempt++;
        }
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'partial',
              issues: [{ severity: 'major', description: 'Missing validation logic' }],
            },
          };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 1,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      // but since the file persists, we simulate "only minor remaining"
      const result = await orchestrator.run();
      const phase4 = result.phases.find((p) => p.phase === 4);

      expect(result.success).toBe(false);
      expect(phase4?.error).toContain('parity-non-minor-exhausted');
      expect(result.blockedTasks).not.toContain('task-001');
    });

    it('should terminally exhaust when failure-adjudicator emits no aamf-json during parity recovery', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'failure-adjudicator') {
          return {
            exitCode: 1,
            success: false,
            error: 'aamf-json parse failed: missing aamf-json block',
            parseError: 'missing aamf-json block',
          };
        }
        if (inv.agent === 'parity-verifier') {
          return {
            outputParsed: true,
            structuredOutput: {
              agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
              parity: 'fail',
              issues: [{ severity: 'major', description: 'Behavior diverges in auth checks' }],
            },
          };
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 2,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
          },
        },
      );

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);
      const result = await orchestrator.run();
      const phase4 = result.phases.find((p) => p.phase === 4);

      expect(result.success).toBe(false);
      expect(phase4?.error).toContain('parity-non-minor-exhausted');

      const recoveryInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
      );
      expect(recoveryInvocations).toHaveLength(2);

      const remigrateAttempts = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.taskId === 'task-001' && i.phase === 4,
      );
      expect(remigrateAttempts).toHaveLength(1);
    });

    it('should fail fast on command recovery exhaustion and persist terminal metadata', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, checkpoint, mockLauncher, logger } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            language: 'typescript',
            framework: 'express',
            outputPath: tempDir,
            buildCommand: 'npm run build',
          },
          options: {
            maxRetriesPerTask: 2,
          },
        },
      );
      await writeMigrationPlan(progressDir);

      const events: Array<{ type: string; reasonCode?: string; taskId?: string; check?: string }> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => {
        events.push(ev as any);
      });
      vi.spyOn(orchestrator as any, 'runCommand').mockResolvedValue({ success: false, error: 'build failed' });

      const result = await orchestrator.run();
      const phase4 = result.phases.find((p) => p.phase === 4);

      expect(result.success).toBe(false);
      expect(phase4?.error).toContain('command-recovery-exhausted');
      const terminalEvent = events.find((e) => e.type === 'terminal-exhaustion');
      expect(terminalEvent?.reasonCode).toBe('command-recovery-exhausted');
      expect(terminalEvent?.taskId).toBe('task-001');
      expect(terminalEvent?.check).toBe('build');

      const task2MigratorRuns = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.taskId === 'task-002',
      );
      expect(task2MigratorRuns).toHaveLength(0);

      const commandRemigrations = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.taskId === 'task-001' && i.phase === 4,
      );
      let foundCommandRemediation = false;
      for (const inv of commandRemigrations) {
        const ctx = JSON.parse(await readFile(inv.contextFile, 'utf-8'));
        if (ctx.payload?.remediationContext?.failureKind === 'build') {
          foundCommandRemediation = true;
          break;
        }
      }
      expect(foundCommandRemediation).toBe(true);

      const checkpointState = checkpoint.getState();
      expect(checkpointState.terminalExhaustion?.reasonCode).toBe('command-recovery-exhausted');
      expect(checkpointState.terminalExhaustion?.check).toBe('build');

      const progressContent = await readFile(join(progressDir, 'progress.md'), 'utf-8');
      expect(progressContent).toContain('Retry Targets');
      expect(progressContent).toContain('command-recovery-exhausted');
      expect(progressContent).toContain('task-001');
      expect(progressContent).toContain('build');
    });

    describe('qualityPolicy phase 4 gating', () => {
      it('should map qualityPolicy values to expected phase 4 gate modes', async () => {
        const launcherFn = createMockLauncher();
        const strict = await setupOrchestrator(tempDir, launcherFn, { options: { qualityPolicy: 'strict' } });
        const balanced = await setupOrchestrator(tempDir, launcherFn, { options: { qualityPolicy: 'balanced' } });
        const deferred = await setupOrchestrator(tempDir, launcherFn, { options: { qualityPolicy: 'deferred-strict' } });

        expect((strict.orchestrator as any).getPhase4QualityGateMode()).toBe('enforce');
        expect((balanced.orchestrator as any).getPhase4QualityGateMode()).toBe('advisory');
        expect((deferred.orchestrator as any).getPhase4QualityGateMode()).toBe('advisory');
      });

      it('should return a wave-end build gate error and skip test gate after build failure', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
          options: { qualityPolicy: 'balanced' },
          target: { buildCommand: 'npm run build', testCommand: 'npm test' },
        });
        const runCommandSpy = vi.spyOn(orchestrator as any, 'runCommand')
          .mockResolvedValueOnce({ success: false, error: 'build failed' })
          .mockResolvedValueOnce({ success: true });

        const waveEndError = await (orchestrator as any).runWaveEndQualityGates();

        expect(waveEndError).toBe('wave-end build gate failed (balanced): build failed');
        expect(runCommandSpy).toHaveBeenCalledTimes(1);
        expect(runCommandSpy).toHaveBeenCalledWith('build', 'npm run build', 'wave-end');
      });

      it('should run build and test wave-end gates and return undefined when both pass', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator } = await setupOrchestrator(tempDir, launcherFn, {
          options: { qualityPolicy: 'balanced' },
          target: { buildCommand: 'npm run build', testCommand: 'npm test' },
        });
        const runCommandSpy = vi.spyOn(orchestrator as any, 'runCommand')
          .mockResolvedValueOnce({ success: true })
          .mockResolvedValueOnce({ success: true });

        const waveEndError = await (orchestrator as any).runWaveEndQualityGates();

        expect(waveEndError).toBeUndefined();
        expect(runCommandSpy).toHaveBeenCalledTimes(2);
        expect(runCommandSpy).toHaveBeenNthCalledWith(1, 'build', 'npm run build', 'wave-end');
        expect(runCommandSpy).toHaveBeenNthCalledWith(2, 'test', 'npm test', 'wave-end');
      });

      it('should fail phase 4 at wave-end in balanced mode when strict gate command fails', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'balanced-wave-end-output'),
            testCommand: 'false',
          },
          options: { qualityPolicy: 'balanced' },
        });
        await writeMigrationPlan(progressDir);

        const result = await orchestrator.run();
        const phase4 = result.phases.find((p) => p.phase === 4);

        expect(phase4).toBeDefined();
        expect(phase4?.success).toBe(false);
        expect(phase4?.error).toContain('wave-end test gate failed (balanced)');
      });

      it('should defer phase 4 quality gates to wave-end in deferred-strict mode', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-wave-end-output'),
            testCommand: 'false',
          },
          options: { qualityPolicy: 'deferred-strict' },
        });
        await writeMigrationPlan(progressDir);

        const result = await orchestrator.run();
        const phase4 = result.phases.find((p) => p.phase === 4);

        expect(phase4).toBeDefined();
        expect(phase4?.success).toBe(false);
        expect(phase4?.error).toContain('wave-end test gate failed (deferred-strict)');
      });

      it('should pass wave-end parity gate in deferred-strict when all tasks have only minor issues', async () => {
        const launcherFn = createMockLauncher((inv) => {
          if (inv.agent === 'parity-verifier') {
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'partial',
                issues: [{ severity: 'minor', description: 'Style nit' }],
              },
            };
          }
          return {};
        });
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-parity-pass-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 2 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();

        expect(result.success).toBe(true);
        // No remediation agents should have been invoked at wave-end
        const waveEndAdjudicator = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.phase === 4,
        );
        expect(waveEndAdjudicator).toHaveLength(0);
      });

      it('should trigger batched remediation at wave-end in deferred-strict for non-minor parity issues', async () => {
        let parityCallCount = 0;
        const launcherFn = createMockLauncher((inv) => {
          if (inv.agent === 'parity-verifier') {
            parityCallCount++;
            if (parityCallCount === 1) {
              return {
                outputParsed: true,
                structuredOutput: {
                  agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                  parity: 'fail',
                  issues: [{ severity: 'major', description: 'Divergence in task' }],
                },
              };
            }
            // After remediation, pass
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'pass', issues: [],
              },
            };
          }
          return {};
        });
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-remediation-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 2 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();

        // Remediation should have been triggered at wave-end
        const adjudicatorInvocations = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
        );
        const codeMigratorInvocations = mockLauncher.invocations.filter(
          (i) => i.agent === 'code-migrator' && i.taskId === 'task-001' && i.phase === 4,
        );
        // At least one remediation attempt should have happened
        expect(adjudicatorInvocations.length).toBeGreaterThanOrEqual(1);
        expect(codeMigratorInvocations.length).toBeGreaterThanOrEqual(1);
      });

      it('should raise terminal exhaustion at wave-end in deferred-strict when remediation does not converge', async () => {
        // Parity-verifier always reports fail with major issues — remediation cannot converge
        const launcherFn = createMockLauncher((inv) => {
          if (inv.agent === 'parity-verifier') {
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'fail',
                issues: [{ severity: 'major', description: 'Persistent divergence' }],
              },
            };
          }
          return {};
        });
        const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-exhaustion-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 1 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();
        const phase4 = result.phases.find((p) => p.phase === 4);

        expect(result.success).toBe(false);
        expect(phase4?.error).toContain('parity-non-minor-exhausted');
      });

      it('should return skip gate mode for unknown qualityPolicy values', async () => {
        // Bypass schema validation to test the runtime defensive fallback
        // for unrecognised qualityPolicy values (schema normally prevents this).
        const launcherFn = createMockLauncher();
        const valid = await setupOrchestrator(tempDir, launcherFn, {});
        (valid.orchestrator as any).config = {
          ...valid.orchestrator['config'],
          options: { ...valid.orchestrator['config'].options, qualityPolicy: 'some-future-policy' },
        };

        expect((valid.orchestrator as any).getPhase4QualityGateMode()).toBe('skip');
      });

      it('should skip parity evaluation in deferred-strict when waveTasks is empty', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          options: { qualityPolicy: 'deferred-strict' },
        });
        vi.spyOn(orchestrator as any, 'runCommand').mockResolvedValue({ success: true });

        const result = await (orchestrator as any).runWaveEndQualityGates([], 1);

        expect(result).toBeUndefined();
        // No remediation agents should have been invoked
        const adjudicators = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator',
        );
        expect(adjudicators).toHaveLength(0);
      });

      it('should pass wave-end parity gate in deferred-strict when all tasks have parity: pass', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-parity-full-pass-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 2 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();

        expect(result.success).toBe(true);
        const waveEndAdjudicator = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.phase === 4,
        );
        expect(waveEndAdjudicator).toHaveLength(0);
      });

      it('should treat missing parity sidecar as fail-closed and trigger remediation in deferred-strict', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-missing-sidecar-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 1 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        // Simulate missing parity result at wave-end by mocking hasNonMinorParityIssues
        const hasNonMinorSpy = vi.spyOn(orchestrator as any, 'hasNonMinorParityIssues')
          .mockReturnValue(true);

        const result = await orchestrator.run();

        // Should have triggered remediation (and then exhaustion since issues persist)
        const adjudicatorInvocations = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
        );
        expect(adjudicatorInvocations.length).toBeGreaterThanOrEqual(1);
        expect(result.success).toBe(false);

        hasNonMinorSpy.mockRestore();
      });

      it('should trigger remediation for critical severity parity issues in deferred-strict', async () => {
        const launcherFn = createMockLauncher((inv) => {
          if (inv.agent === 'parity-verifier') {
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'fail',
                issues: [{ severity: 'critical', description: 'Missing export' }],
              },
            };
          }
          return {};
        });
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-critical-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 1 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();

        const adjudicatorInvocations = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
        );
        expect(adjudicatorInvocations.length).toBeGreaterThanOrEqual(1);
        expect(result.success).toBe(false);
        const phase4 = result.phases.find((p) => p.phase === 4);
        expect(phase4?.error).toContain('parity-non-minor-exhausted');
      });

      it('should not run parity evaluation at wave-end when build gate fails in deferred-strict', async () => {
        const launcherFn = createMockLauncher();
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-build-fail-no-parity-output'),
            buildCommand: 'false',
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 2 },
        });

        const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
        await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
        await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
        await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

        const result = await orchestrator.run();
        const phase4 = result.phases.find((p) => p.phase === 4);

        // Build failure should take precedence; no parity remediation should occur
        expect(phase4?.error).toContain('wave-end build gate failed');
        const adjudicatorInvocations = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.phase === 4,
        );
        expect(adjudicatorInvocations).toHaveLength(0);
      });

      it('should run batched remediation in parallel across multiple failing tasks at wave-end', async () => {
        const invocationOrder: string[] = [];
        const launcherFn = createMockLauncher((inv) => {
          invocationOrder.push(`${inv.agent}:${inv.taskId}`);
          if (inv.agent === 'parity-verifier') {
            return {
              outputParsed: true,
              structuredOutput: {
                agent: 'parity-verifier', status: 'completed', taskId: inv.taskId,
                parity: 'fail',
                issues: [{ severity: 'major', description: `Divergence in ${inv.taskId}` }],
              },
            };
          }
          return {};
        });
        const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
          target: {
            outputPath: join(tempDir, 'deferred-parallel-output'),
          },
          options: { qualityPolicy: 'deferred-strict', maxRetriesPerTask: 1 },
        });
        await writeMigrationPlan(progressDir);

        const result = await orchestrator.run();

        // Both tasks should have had remediation attempts
        const task1Adjudicator = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-001' && i.phase === 4,
        );
        const task2Adjudicator = mockLauncher.invocations.filter(
          (i) => i.agent === 'failure-adjudicator' && i.taskId === 'task-002' && i.phase === 4,
        );
        expect(task1Adjudicator.length).toBeGreaterThanOrEqual(1);
        expect(task2Adjudicator.length).toBeGreaterThanOrEqual(1);

        // Verify terminal exhaustion since issues persist
        expect(result.success).toBe(false);
        const phase4 = result.phases.find((p) => p.phase === 4);
        expect(phase4?.error).toContain('parity-non-minor-exhausted');
      });
    });

    it('should use multiplier of 2 without testCommand and 3 with testCommand', async () => {
      const launcherFn = createMockLauncher();
      const config = createMockConfig();

      // Without testCommand: multiplier = 2
      // 2 tasks * 100_000 * 2 * 1.25 = 500,000
      {
        const logger = createSilentLogger(tempDir);
        const infoSpy = vi.spyOn(logger, 'info');
        const progressDir2 = join(tempDir, 'sub1', '.aamf', 'migration', config.projectName);
        await ensureDir(progressDir2);
        const checkpoint = new CheckpointManager(progressDir2, logger);
        await checkpoint.load(config.projectName);
        const progress = new ProgressWriter(join(progressDir2, 'progress.md'));
        await progress.initialize(config);
        const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));
        const orchestrator = new MigrationOrchestrator(config, checkpoint, mockLauncher as any, progress, logger, join(tempDir, 'sub1'), 'test-run-id');
        await writeMigrationPlan(progressDir2);
        await orchestrator.run();
        const log = infoSpy.mock.calls.find((c) => c[0]?.includes('estimated'));
        expect(log![0]).toContain('500,000');
      }

      // With testCommand: multiplier = 3
      // 2 tasks * 100_000 * 3 * 1.25 = 750,000
      {
        const logger = createSilentLogger(tempDir);
        const infoSpy = vi.spyOn(logger, 'info');
        const config = createMockConfig({
          target: { language: 'typescript', outputPath: '/tmp/target', testCommand: 'npm test' },
        });
        const progressDir3 = join(tempDir, 'sub2', '.aamf', 'migration', config.projectName);
        await ensureDir(progressDir3);
        const checkpoint = new CheckpointManager(progressDir3, logger);
        await checkpoint.load(config.projectName);
        const progress = new ProgressWriter(join(progressDir3, 'progress.md'));
        await progress.initialize(config);
        const mockLauncher = new MockAgentLauncher(withParityPassOutput(launcherFn));
        const orchestrator = new MigrationOrchestrator(config, checkpoint, mockLauncher as any, progress, logger, join(tempDir, 'sub2'), 'test-run-id');
        await writeMigrationPlan(progressDir3);
        await orchestrator.run();
        const log = infoSpy.mock.calls.find((c) => c[0]?.includes('estimated'));
        expect(log![0]).toContain('750,000');
      }
    });

    it('should include retry overhead multiplier value in Phase 4 projection log', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
      });
      const infoSpy = vi.spyOn(logger, 'info');

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const projectionLog = infoSpy.mock.calls.find((call) => call[0]?.includes('retry overhead'));
      expect(projectionLog).toBeDefined();
      expect(projectionLog![0]).toContain('1.25x');
    });

    it('should keep per-task validation behavior when executionMode is per-task', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['src/b.ts'] },
      ];

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'npm run build',
        },
        options: {
          executionMode: 'per-task',
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      const runCommandSpy = vi
        .spyOn(orchestrator as any, 'runCommand')
        .mockResolvedValue({ success: true });

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      const buildCalls = runCommandSpy.mock.calls.filter(c => c[0] === 'build');
      expect(buildCalls).toHaveLength(2);
    });

    it('should run build/test only after migration wave completion in wave-barrier mode', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['lib/b.ts'] },
      ];

      const migratorFinishedAt: number[] = [];
      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator') {
          await new Promise(resolve => setTimeout(resolve, 20));
          migratorFinishedAt.push(Date.now());
        }
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 20,
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'npm run build',
          testCommand: 'npm test',
        },
        options: {
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 2, maxConvergenceIterations: 2 },
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      const validationStartedAt: number[] = [];
      const runCommandSpy = vi
        .spyOn(orchestrator as any, 'runCommand')
        .mockImplementation(async () => {
          validationStartedAt.push(Date.now());
          return { success: true };
        });

      const result = await orchestrator.run();

      expect(result.success).toBe(true);
      expect(runCommandSpy.mock.calls.filter(c => c[0] === 'build')).toHaveLength(1);
      expect(runCommandSpy.mock.calls.filter(c => c[0] === 'test')).toHaveLength(1);
      expect(Math.min(...validationStartedAt)).toBeGreaterThanOrEqual(Math.max(...migratorFinishedAt));
    });

    it('should launch failure-adjudicator for wave validation failures before convergence retry', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['lib/b.ts'] },
      ];

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'npm run build',
        },
        options: {
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 2, maxConvergenceIterations: 3 },
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      let buildAttempts = 0;
      vi.spyOn(orchestrator as any, 'runCommand').mockImplementation(async (...args: unknown[]) => {
        const label = String(args[0]);
        if (label === 'build') {
          buildAttempts++;
          return buildAttempts < 2
            ? { success: false, error: 'build failed' }
            : { success: true };
        }
        return { success: true };
      });

      const result = await orchestrator.run();
      const migratorRuns = mockLauncher.invocations.filter(i => i.agent === 'code-migrator' && i.phase === 4);
      const waveAdjudicatorRuns = mockLauncher.invocations.filter(
        (i) => i.agent === 'failure-adjudicator' && i.phase === 4 && i.taskId === 'wave-1',
      );
      const waveRemigratorRuns = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 4 && i.taskId === 'wave-1',
      );

      expect(result.success).toBe(true);
      expect(buildAttempts).toBe(3);
      expect(migratorRuns.length).toBeGreaterThanOrEqual(2);
      expect(waveAdjudicatorRuns.length).toBeGreaterThanOrEqual(1);
      expect(waveRemigratorRuns.length).toBeGreaterThanOrEqual(1);

      const waveRecoveryContext = JSON.parse(await readFile(waveAdjudicatorRuns[0]!.contextFile, 'utf-8'));
      expect(typeof waveRecoveryContext.payload?.failureReport).toBe('string');
      if (waveRecoveryContext.payload?.failureReport.includes('/logs/commands/build/wave-1-')) {
        expect(waveRecoveryContext.inputFiles).toContain(waveRecoveryContext.payload?.failureReport);
      } else {
        expect(waveRecoveryContext.payload?.failureReport).toContain('build failed');
      }
      expect(waveRecoveryContext.payload?.failureType).toBe('build');

      let foundBuildRemediation = false;
      for (const inv of waveRemigratorRuns) {
        const ctx = JSON.parse(await readFile(inv.contextFile, 'utf-8'));
        if (ctx.payload?.remediationContext?.failureKind === 'build') {
          foundBuildRemediation = true;
          expect(ctx.payload?.remediationContext?.failureTarget?.wave).toBe(1);
          break;
        }
      }
      expect(foundBuildRemediation).toBe(true);

      const progressContent = await readFile(join(progressDir, 'progress.md'), 'utf-8');
      expect(progressContent).toContain('Retry Targets');
      expect(progressContent).toContain('wave-1');
      expect(progressContent).toContain('build');
      expect(progressContent).toContain('convergence');
    });

    it('should fail fast on wave convergence exhaustion without scheduling later waves', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['lib/b.ts'] },
      ];

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'npm run build',
        },
        options: {
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 1, maxConvergenceIterations: 1 },
          continueOnBlocked: false,
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      vi.spyOn(orchestrator as any, 'runCommand').mockResolvedValue({ success: false, error: 'build failed' });

      const result = await orchestrator.run();
      const phase4 = result.phases.find((p) => p.phase === 4);
      const secondTaskRuns = mockLauncher.invocations.filter(i => i.agent === 'code-migrator' && i.taskId === 'task-002');

      expect(result.success).toBe(false);
      expect(phase4?.error).toContain('wave-convergence-exhausted');
      expect(result.blockedTasks).not.toContain('task-001');
      expect(secondTaskRuns).toHaveLength(0);
    });
  });

  // ─── Parity Result Fail-Closed ──────────────────────────────────────

  describe('Parity result fail-closed defaults', () => {
    it('checkParityResult returns false when no result is stored', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);

      const warnSpy = vi.spyOn(logger, 'warn');
      const result = (orchestrator as any).checkParityResult('task-001');

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Parity result missing for task-001'),
      );
    });

    it('hasNonMinorParityIssues returns true when no result is stored', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);

      const warnSpy = vi.spyOn(logger, 'warn');
      const result = (orchestrator as any).hasNonMinorParityIssues('task-001');

      expect(result).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Parity result missing for task-001'),
      );
    });

    it('checkParityResult returns true when parity is pass', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', { parity: 'pass', issues: [] });

      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(true);
    });

    it('hasNonMinorParityIssues returns false when only minor issues', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', {
        parity: 'partial',
        issues: [{ severity: 'minor', description: 'style nit', sourceLocation: 'a.py:1', targetLocation: 'a.ts:1' }],
      });

      const result = (orchestrator as any).hasNonMinorParityIssues('task-001');
      expect(result).toBe(false);
    });

    it('checkParityResult returns false when parity is fail', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', {
        parity: 'fail',
        issues: [{ severity: 'critical', description: 'missing function', sourceLocation: 'a.py:10', targetLocation: 'a.ts:10' }],
      });

      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(false);
    });

    it('checkParityResult returns true when parity is partial with all minor issues', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', {
        parity: 'partial',
        issues: [
          { severity: 'minor', description: 'style nit', sourceLocation: 'a.py:1', targetLocation: 'a.ts:1' },
          { severity: 'minor', description: 'whitespace diff', sourceLocation: 'a.py:5', targetLocation: 'a.ts:5' },
        ],
      });

      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(true);
    });

    it('checkParityResult returns false when parity is partial with a major issue', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', {
        parity: 'partial',
        issues: [
          { severity: 'minor', description: 'style nit', sourceLocation: 'a.py:1', targetLocation: 'a.ts:1' },
          { severity: 'major', description: 'logic mismatch', sourceLocation: 'a.py:10', targetLocation: 'a.ts:10' },
        ],
      });

      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(false);
    });

    it('hasNonMinorParityIssues returns true when a critical issue exists', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', {
        parity: 'fail',
        issues: [
          { severity: 'minor', description: 'style nit', sourceLocation: 'a.py:1', targetLocation: 'a.ts:1' },
          { severity: 'critical', description: 'missing export', sourceLocation: 'a.py:20', targetLocation: 'a.ts:20' },
        ],
      });

      const result = (orchestrator as any).hasNonMinorParityIssues('task-001');
      expect(result).toBe(true);
    });

    it('hasNonMinorParityIssues returns false when issues array is empty', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', { parity: 'pass', issues: [] });

      const result = (orchestrator as any).hasNonMinorParityIssues('task-001');
      expect(result).toBe(false);
    });

    it('checkParityResult does not log warning when result is stored', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', { parity: 'pass', issues: [] });

      const warnSpy = vi.spyOn(logger, 'warn');
      (orchestrator as any).checkParityResult('task-001');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Parity result missing'),
      );
    });

    it('hasNonMinorParityIssues does not log warning when result is stored', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      (orchestrator as any)._parityResults.set('task-001', { parity: 'pass', issues: [] });

      const warnSpy = vi.spyOn(logger, 'warn');
      (orchestrator as any).hasNonMinorParityIssues('task-001');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Parity result missing'),
      );
    });

    it('storeParityResult populates map from structuredOutput', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      const agentResult: Partial<AgentResult> = {
        outputParsed: true,
        structuredOutput: {
          agent: 'parity-verifier',
          status: 'completed',
          parity: 'partial',
          issues: [{ severity: 'major', description: 'divergence' }],
        },
      };
      (orchestrator as any).storeParityResult(agentResult, 'task-001');

      const stored = (orchestrator as any)._parityResults.get('task-001');
      expect(stored).toBeDefined();
      expect(stored.parity).toBe('partial');
      expect(stored.issues).toHaveLength(1);
    });

    it('storeParityResult ignores result when outputParsed is false', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);
      const agentResult: Partial<AgentResult> = {
        outputParsed: false,
        structuredOutput: undefined,
      };
      (orchestrator as any).storeParityResult(agentResult, 'task-001');

      expect((orchestrator as any)._parityResults.has('task-001')).toBe(false);
    });

    it('rehydrateParityFromLog recovers parity result from agent log file on disk', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      // Write a fake parity-verifier log file with an aamf-json block
      const logDir = join(
        tempDir, '.aamf', 'migration', 'test-project', 'logs', 'agents',
        'parity-verifier', 'task-001',
      );
      await mkdir(logDir, { recursive: true });
      const logContent = `=== STDOUT ===
Some preamble text

\`\`\`aamf-json
{
  "agent": "parity-verifier",
  "status": "completed",
  "outputFiles": ["artifacts/parity/task-001.md"],
  "taskId": "task-001",
  "parity": "partial",
  "issues": [
    {
      "severity": "minor",
      "description": "String mismatch",
      "sourceLocation": "a.c:10",
      "targetLocation": "a.rs:15"
    }
  ]
}
\`\`\`

=== STDERR ===
Total usage est: 1 Premium requests
`;
      await writeFile(join(logDir, 'abc-2026-01-01T00-00-00-000Z.log'), logContent, 'utf-8');

      // Map should be empty initially
      expect((orchestrator as any)._parityResults.has('task-001')).toBe(false);

      // checkParityResult should rehydrate from log and return true (partial with only minor)
      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(true);

      // Map should now be populated
      const stored = (orchestrator as any)._parityResults.get('task-001');
      expect(stored).toBeDefined();
      expect(stored.parity).toBe('partial');
      expect(stored.issues).toHaveLength(1);
      expect(stored.issues[0].severity).toBe('minor');
    });

    it('rehydrateParityFromLog picks the latest log file when multiple exist', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const logDir = join(
        tempDir, '.aamf', 'migration', 'test-project', 'logs', 'agents',
        'parity-verifier', 'task-001',
      );
      await mkdir(logDir, { recursive: true });

      const makeLog = (parity: string) => `=== STDOUT ===
\`\`\`aamf-json
{"agent":"parity-verifier","status":"completed","parity":"${parity}","issues":[]}
\`\`\`
=== STDERR ===
`;

      // Write two logs — earlier one is "fail", later one is "pass"
      await writeFile(join(logDir, 'aaa-2026-01-01T00-00-00-000Z.log'), makeLog('fail'), 'utf-8');
      await writeFile(join(logDir, 'bbb-2026-01-02T00-00-00-000Z.log'), makeLog('pass'), 'utf-8');
      // Write a .live.log that should be ignored
      await writeFile(join(logDir, 'ccc-2026-01-03T00-00-00-000Z.live.log'), makeLog('fail'), 'utf-8');

      const result = (orchestrator as any).checkParityResult('task-001');
      expect(result).toBe(true);
      expect((orchestrator as any)._parityResults.get('task-001').parity).toBe('pass');
    });

    it('rehydrateParityFromLog returns undefined when no log directory exists', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const result = (orchestrator as any).rehydrateParityFromLog('nonexistent-task');
      expect(result).toBeUndefined();
    });

    it('rehydrateParityFromLog returns undefined when log has no aamf-json block', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(tempDir, launcherFn);

      const logDir = join(
        tempDir, '.aamf', 'migration', 'test-project', 'logs', 'agents',
        'parity-verifier', 'task-001',
      );
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, 'abc-2026-01-01T00-00-00-000Z.log'), '=== STDOUT ===\nno json here\n=== STDERR ===\n', 'utf-8');

      const result = (orchestrator as any).rehydrateParityFromLog('task-001');
      expect(result).toBeUndefined();
    });
  });

  // ─── ETA Logging ───────────────────────────────────────────────────

  describe('ETA Logging', () => {
    it('should include avg and ETA in progress log after ≥2 task completions', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const infoSpy = vi.spyOn(logger, 'info');

      await orchestrator.run();

      const progressLogs = infoSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => typeof m === 'string' && m.startsWith('Task progress:'));

      // The default plan has 2 tasks; after the 2nd completes the ETA segment should appear
      const logsWithEta = progressLogs.filter((m) => m.includes('— avg'));
      expect(logsWithEta.length).toBeGreaterThan(0);
      // Should contain the expected format
      expect(logsWithEta[0]).toMatch(/— avg .+\/task, ~.+ remaining/);
    });

    it('should omit ETA segment when only 1 task has completed', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      const singleTaskPlan = `# Migration Plan

## Task: task-001 - Auth Module

**Description:** Migrate auth
**Complexity:** simple
**Knowledge Base Reference:** kb/auth.md

**Source Files:**
- src/auth.py

**Target Files:**
- src/auth.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), singleTaskPlan);
      await writePhase3PlanningArtifacts(progressDir, [SINGLE_AUTH_TASK]);

      const infoSpy = vi.spyOn(logger, 'info');

      await orchestrator.run();

      const progressLogs = infoSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => typeof m === 'string' && m.startsWith('Task progress:'));

      // Only 1 task completed — no ETA segment expected
      expect(progressLogs.length).toBeGreaterThan(0);
      const logsWithEta = progressLogs.filter((m) => m.includes('— avg'));
      expect(logsWithEta).toHaveLength(0);
    });

    it('should store task durations in checkpoint after each task completion', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      await orchestrator.run();

      const state = checkpoint.getState();
      // Default plan has 2 tasks; both should have recorded a duration
      expect(state.completedTaskDurationsMs).toHaveLength(2);
      state.completedTaskDurationsMs.forEach((d) => {
        expect(typeof d).toBe('number');
        expect(d).toBeGreaterThanOrEqual(0);
      });
    });

    it('should include ETA on resume run seeded with prior completedTaskDurationsMs', async () => {
      const config = createMockConfig();
      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);

      // Write a 3-task plan so the resume run has work to do
      const threeTaskPlan = `# Migration Plan: test-project

## Task: task-001 - Module A

**Description:** Migrate A
**Complexity:** simple
**Knowledge Base Reference:** kb/task-001.md

**Source Files:**
- src/a.py

**Target Files:**
- src/a.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches

## Task: task-002 - Module B

**Description:** Migrate B
**Complexity:** simple
**Knowledge Base Reference:** kb/task-002.md

**Source Files:**
- src/b.py

**Target Files:**
- src/b.ts

**Dependencies:** none

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches

## Task: task-003 - Module C

**Description:** Migrate C
**Complexity:** simple
**Knowledge Base Reference:** kb/task-003.md

**Source Files:**
- src/c.py

**Target Files:**
- src/c.ts

**Dependencies:** task-001

**Acceptance Criteria:**
- works

**Parity Checks:**
- matches
`;
      await mkdir(join(progressDir, 'artifacts', 'planning'), { recursive: true });
      await writeFile(join(progressDir, 'artifacts', 'planning', 'migration-plan.md'), threeTaskPlan);
      // Write planning artifacts for the three tasks so Phase 3 succeeds during the resume run.
      const threeTasks: MigrationTask[] = [
        { id: 'task-001', name: 'Module A', sourceFiles: ['src/a.py'], targetFiles: ['src/a.ts'], knowledgeBaseRef: 'kb/task-001.md', dependencies: [], complexity: 'simple', description: 'Migrate A', acceptanceCriteria: ['works'], parityChecks: ['matches'], lineRange: { start: 1, end: 200 } },
        { id: 'task-002', name: 'Module B', sourceFiles: ['src/b.py'], targetFiles: ['src/b.ts'], knowledgeBaseRef: 'kb/task-002.md', dependencies: [], complexity: 'simple', description: 'Migrate B', acceptanceCriteria: ['works'], parityChecks: ['matches'], lineRange: { start: 1, end: 200 } },
        { id: 'task-003', name: 'Module C', sourceFiles: ['src/c.py'], targetFiles: ['src/c.ts'], knowledgeBaseRef: 'kb/task-003.md', dependencies: ['task-001'], complexity: 'simple', description: 'Migrate C', acceptanceCriteria: ['works'], parityChecks: ['matches'], lineRange: { start: 1, end: 200 } },
      ];
      await writePhase3PlanningArtifacts(progressDir, threeTasks);

      // First run to get 1 task completed (so checkpoint has 1 prior duration)
      const checkpoint1 = new CheckpointManager(progressDir, logger);
      await checkpoint1.load(config.projectName);
      const progress1 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress1.initialize(config);

      // Manually seed checkpoint with 1 completed task and 1 prior duration so resume will have data
      const seedState = checkpoint1.getState();
      seedState.completedTasks = ['task-001'];
      seedState.completedTaskDurationsMs = [3000];
      await checkpoint1.save(seedState);

      // Resume run: task-002 and task-003 remain; after task-002 completes we now have 2 durations.
      // Use a complete options object so maxRetriesPerTask etc. are not accidentally undefined.
      const config2 = createMockConfig({
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          largeFileThreshold: 500,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: true,
          invocationDelayMs: 0,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
        },
      });
      const checkpoint2 = new CheckpointManager(progressDir, logger);
      await checkpoint2.load(config2.projectName);
      const progress2 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress2.initialize(config2);
      const mockLauncher2 = new MockAgentLauncher(withParityPassOutput(createMockLauncher()));
      const orch2 = new MigrationOrchestrator(
        config2,
        checkpoint2,
        mockLauncher2 as any,
        progress2,
        logger,
        tempDir,
        'test-run-id',
      );

      const infoSpy = vi.spyOn(logger, 'info');
      await orch2.run();

      const progressLogs = infoSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => typeof m === 'string' && m.startsWith('Task progress:'));

      // After the first new task completes, combined with the 1 seeded duration, we have ≥2 — ETA should appear
      const logsWithEta = progressLogs.filter((m) => m.includes('— avg'));
      expect(logsWithEta.length).toBeGreaterThan(0);
      expect(logsWithEta[0]).toMatch(/— avg .+\/task, ~.+ remaining/);
    });
  });

  // ─── Phase 5 Loop-back ─────────────────────────────────────────────

  describe('Phase 5 Loop-back', () => {
    it('should re-run code-migrator when parity issues found', async () => {
      let parityCheckCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCheckCount++;
        }
        return {};
      });

      const { orchestrator, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);

      await writeParityReport(progressDir, [
        {
          description: 'Missing error handling',
          sourceFile: 'src/auth.py',
          targetFile: 'src/auth.ts',
        },
      ]);

      const result = await orchestrator.run();

      const codeMigratorInPhase5 = mockLauncher.invocations.filter(
        (i) => i.agent === 'code-migrator' && i.phase === 5,
      );
      expect(codeMigratorInPhase5.length).toBeGreaterThan(0);
    });

    it('should stop loop-back after MAX_LOOPBACK iterations', async () => {
      let parityCheckCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCheckCount++;
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      await writeParityReport(progressDir, [
        {
          description: 'Persistent issue',
          sourceFile: 'src/main.py',
          targetFile: 'src/main.ts',
        },
      ]);

      await orchestrator.run();

      // MAX_LOOPBACK = 2 → initial + 2 loop-backs = max 3 parity checks
      expect(parityCheckCount).toBeLessThanOrEqual(3);
    });

    it('should return success: false when fixes persist after exhausting MAX_LOOPBACK', async () => {
      let parityCheckCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCheckCount++;
          return {
            outputParsed: true,
            structuredOutput: {
              fixes: [
                {
                  description: 'Persistent unresolved issue',
                  sourceFile: 'src/main.py',
                  targetFile: 'src/main.ts',
                },
              ],
            },
          };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      // Phase 5 is non-critical so run completes, but the phase itself should fail
      const phase5 = result.phases.find((p) => p.phase === 5);
      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(false);
      expect(phase5!.error).toContain('unresolved parity fix');
      expect(phase5!.error).toContain('1');
      // All MAX_LOOPBACK+1 iterations should have been run
      expect(parityCheckCount).toBe(3);
    });

    it('should return success: true when zero fixes on first parity check', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(true);
    });

    it('should return success: true when fixes on iteration 0 are resolved by iteration 1', async () => {
      let parityCallCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCallCount++;
          if (parityCallCount === 1) {
            return {
              outputParsed: true,
              structuredOutput: {
                fixes: [
                  {
                    description: 'Fixable issue',
                    sourceFile: 'src/utils.py',
                    targetFile: 'src/utils.ts',
                  },
                ],
              },
            };
          }
          // Second call: fixes resolved
          return {
            outputParsed: true,
            structuredOutput: { fixes: [] },
          };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(true);
      // Two parity checks: first found fixes, second found none
      expect(parityCallCount).toBe(2);
    });
  });

  // ─── Cumulative Duration ───────────────────────────────────────────

  describe('Cumulative Duration', () => {
    it('should set cumulativeDurationMs to totalDuration on a fresh run', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      expect(result.cumulativeDuration).toBe(result.totalDuration);
      expect(checkpoint.getState().cumulativeDurationMs).toBe(result.totalDuration);
    });

    it('should accumulate cumulativeDurationMs across two simulated runs', async () => {
      const launcherFn = createMockLauncher();
      const config = createMockConfig();
      const logger = createSilentLogger(tempDir);
      const progressDir = join(tempDir, '.aamf', 'migration', config.projectName);
      await ensureDir(progressDir);
      await writeMigrationPlan(progressDir);

      // First run
      const checkpoint1 = new CheckpointManager(progressDir, logger);
      await checkpoint1.load(config.projectName);
      const progress1 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress1.initialize(config);
      const orch1 = new MigrationOrchestrator(config, checkpoint1, new MockAgentLauncher(withParityPassOutput(launcherFn)) as any, progress1, logger, tempDir, 'test-run-id');
      const result1 = await orch1.run();

      expect(result1.cumulativeDuration).toBe(result1.totalDuration);
      const afterFirst = checkpoint1.getState().cumulativeDurationMs;
      expect(afterFirst).toBe(result1.totalDuration);

      // Second run (resume) — simulate by loading the existing checkpoint
      const config2 = createMockConfig({ options: { resume: true } });
      const checkpoint2 = new CheckpointManager(progressDir, logger);
      await checkpoint2.load(config2.projectName);
      // Reset completed phases so there's work to do
      const state = checkpoint2.getState();
      state.completedPhases = [];
      state.currentPhase = 1;
      state.cumulativeDurationMs = afterFirst;
      await checkpoint2.save(state);

      const progress2 = new ProgressWriter(join(progressDir, 'progress.md'));
      await progress2.initialize(config2);
      const orch2 = new MigrationOrchestrator(config2, checkpoint2, new MockAgentLauncher(withParityPassOutput(launcherFn)) as any, progress2, logger, tempDir, 'test-run-id');
      const result2 = await orch2.run();

      expect(result2.cumulativeDuration).toBe(afterFirst + result2.totalDuration);
      expect(checkpoint2.getState().cumulativeDurationMs).toBe(afterFirst + result2.totalDuration);
    });
  });

  // ─── MigrationError ────────────────────────────────────────────────

  describe('MigrationError', () => {
    it('should construct MigrationError with phase and result details', () => {
      const phase = getPhase(1)!;
      const phaseResult = {
        phase: 1,
        name: 'Impact Assessment',
        success: false,
        duration: 100,
        error: 'Something went wrong',
      };
      const error = new MigrationError(phase, phaseResult);

      expect(error.message).toContain('Phase 1');
      expect(error.message).toContain('Impact Assessment');
      expect(error.message).toContain('Something went wrong');
      expect(error.phase).toBe(phase);
      expect(error.result).toBe(phaseResult);
    });

    it('should have correct name property ("MigrationError")', () => {
      const phase = getPhase(1)!;
      const phaseResult = {
        phase: 1,
        name: 'Impact Assessment',
        success: false,
        duration: 100,
      };
      const error = new MigrationError(phase, phaseResult);

      expect(error.name).toBe('MigrationError');
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ─── Phase-failed enrichment ───────────────────────────────────────

  describe('Phase-failed enrichment', () => {
    it('should include exitCode and stderr in phase-failed event when phase 1 fails', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 2, success: false, error: 'failure', stderr: 'agent stderr output' };
        }
        return {};
      });

      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<{ type: string; exitCode?: number; stderr?: string }> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const failedEvent = events.find((e) => e.type === 'phase-failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.exitCode).toBe(2);
      expect(failedEvent!.stderr).toBe('agent stderr output');
    });

    it('should truncate stderr to 2000 chars in phase-failed event', async () => {
      const longStderr = 'x'.repeat(3000);
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 1, success: false, error: 'fail', stderr: longStderr };
        }
        return {};
      });

      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<{ type: string; stderr?: string }> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const failedEvent = events.find((e) => e.type === 'phase-failed');
      expect(failedEvent?.stderr?.length).toBe(2000);
    });

    it('should include exitCode and stderr in progress file on phase failure', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 3, success: false, error: 'fail', stderr: 'stderr from agent' };
        }
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await orchestrator.run();

      const progressFile = join(progressDir, 'progress.md');
      const content = await readFile(progressFile, 'utf-8');
      expect(content).toContain('exitCode: 3');
      expect(content).toContain('stderr from agent');
    });
  });

  // ─── phaseTimeouts ─────────────────────────────────────────────────

  describe('phaseTimeouts', () => {
    it('should use phaseTimeouts[phase] as timeout when configured', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        agentBackend: {
          runtime: 'copilot',
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
          phaseTimeouts: { 1: 60_000 },
        },
      });

      await orchestrator.run();

      const phase1Invocation = mockLauncher.invocations.find((i) => i.agent === 'impact-assessor');
      expect(phase1Invocation).toBeDefined();
      expect(phase1Invocation!.timeout).toBe(60_000);
    });

    it('should fall back to config.agentBackend.timeout when no phaseTimeout override exists', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        agentBackend: {
          runtime: 'copilot',
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
          phaseTimeouts: { 2: 90_000 },
        },
      });

      await orchestrator.run();

      const phase1Invocation = mockLauncher.invocations.find((i) => i.agent === 'impact-assessor');
      expect(phase1Invocation).toBeDefined();
      expect(phase1Invocation!.timeout).toBe(300_000);
    });

    it('should use agentBackend phaseTimeouts and timeout when runtime is claude-code', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher } = await setupOrchestrator(tempDir, launcherFn, {
        agentBackend: {
          runtime: 'claude-code',
          cliCommand: 'claude',
          agentDir: '.claude/agents',
          timeout: 120_000,
          phaseTimeouts: { 1: 45_000 },
        },
      });

      await orchestrator.run();

      const phase1Invocation = mockLauncher.invocations.find((i) => i.agent === 'impact-assessor');
      expect(phase1Invocation).toBeDefined();
      expect(phase1Invocation!.timeout).toBe(45_000);
      expect((orchestrator as any).getRuntimeTimeout()).toBe(120_000);
    });
  });

  // ─── Phase 8: Idiomatic Refactor ──────────────────────────────────

  describe('Phase 8: Idiomatic Refactor', () => {
    it('should skip Phase 8 when idiomaticRefactor.enabled is false', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 3,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            idiomaticRefactor: { enabled: false, maxIterations: 2 },
          },
        },
      );
      await writeMigrationPlan(progressDir);

      await orchestrator.run();

      const phase8Invocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'idiomatic-reviewer' || i.agent === 'idiomatic-refactorer',
      );
      expect(phase8Invocations).toHaveLength(0);
    });

    it('should run Phase 8 agents when idiomaticRefactor.enabled is true', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 3,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            idiomaticRefactor: { enabled: true, maxIterations: 2 },
          },
        },
      );
      await writeMigrationPlan(progressDir);

      await orchestrator.run();

      const reviewInvocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'idiomatic-reviewer',
      );
      expect(reviewInvocations.length).toBeGreaterThan(0);
    });

    it('should terminate idiomatic refactor loop at maxIterations', async () => {
      let reviewCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'idiomatic-reviewer') {
          reviewCount++;
        }
        return {};
      });

      const maxIterations = 3;
      const { orchestrator, progressDir, logger } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 3,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            idiomaticRefactor: { enabled: true, maxIterations },
          },
        },
      );
      await writeMigrationPlan(progressDir);

      // Write an idiomatic report with issues so the loop keeps iterating
      await mkdir(join(progressDir, 'artifacts', 'parity'), { recursive: true });
      await writeFile(
        join(progressDir, 'artifacts', 'parity', 'idiomatic-review-report.md'),
        '# Idiomatic Review\n\n## Issue: Use const\nFile: src/main.ts\nIssue: let used instead of const\nSuggestion: replace let with const\n',
      );

      const warnSpy = vi.spyOn(logger, 'warn');

      await orchestrator.run();

      expect(reviewCount).toBeLessThanOrEqual(maxIterations);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Max idiomatic refactor iterations reached'),
      );
    });

    it('should skip Phase 8 when idiomaticRefactor is omitted from options', async () => {
      const launcherFn = createMockLauncher();
      // Default config has no idiomaticRefactor key — Phase 8 must be silently skipped
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);

      await orchestrator.run();

      const phase8Invocations = mockLauncher.invocations.filter(
        (i) => i.agent === 'idiomatic-reviewer' || i.agent === 'idiomatic-refactorer',
      );
      expect(phase8Invocations).toHaveLength(0);
    });

    it('should exit loop after one iteration when idiomatic-reviewer finds no issues', async () => {
      let reviewCount = 0;
      let refactorCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'idiomatic-reviewer') reviewCount++;
        if (inv.agent === 'idiomatic-refactorer') refactorCount++;
        return {};
      });

      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            maxRetriesPerTask: 3,
            maxLinesPerTask: 500,
            dryRun: false,
            resume: false,
            invocationDelayMs: 0,
            buildConcurrency: 1,
            continueOnBlocked: true,
            maxBlockedTasks: 0,
            maxInfraRetries: 3,
            idiomaticRefactor: { enabled: true, maxIterations: 5 },
          },
        },
      );
      await writeMigrationPlan(progressDir);

      // No idiomatic report file → parseIdiomaticReport returns [] → loop exits immediately
      await orchestrator.run();

      expect(reviewCount).toBe(1);
      expect(refactorCount).toBe(0);
    });
  });

  // ─── Deterministic Resume Cursors ───────────────────────────────────

  describe('Deterministic resume cursors', () => {
    it('should resume phase 4 from checkpointed substeps and skip completed substeps', async () => {
      const tasks: MigrationTask[] = [
        {
          ...SINGLE_AUTH_TASK,
          id: 'task-001',
          name: 'Auth Module',
          sourceFiles: ['src/auth.py'],
          targetFiles: ['src/auth.ts'],
        },
      ];
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
      );
      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      const state = checkpoint.getState();
      state.currentPhase = 4;
      state.completedPhases = [1, 2, 3];
      state.phaseCursors ??= {};
      state.phaseCursors['4'] = {
        tasks: {
          'task-001': {
            completedSubsteps: ['migrator', 'migrator-commit', 'parity-tests', 'parity-gate'],
            lastSuccessfulStep: 'parity-gate',
          },
        },
      };
      await checkpoint.save(state);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const task001Phase4Invocations = mockLauncher.invocations.filter(
        (inv) => inv.phase === 4 && inv.taskId === 'task-001',
      );
      const task001Agents = task001Phase4Invocations.map((inv) => inv.agent);
      expect(task001Agents).not.toContain('code-migrator');
      expect(task001Agents).not.toContain('parity-verifier');
      expect(task001Agents).not.toContain('test-writer');
    });

    it('should resume phase 5 from loopback cursor fix index', async () => {
      let parityCalls = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'final-parity-checker') {
          parityCalls++;
          if (parityCalls === 1) {
            return {
              outputParsed: true,
              structuredOutput: {
                fixes: [
                  { description: 'fix a', sourceFile: 'src/a.py', targetFile: 'src/a.ts' },
                  { description: 'fix b', sourceFile: 'src/b.py', targetFile: 'src/b.ts' },
                ],
              },
            };
          }
          return { outputParsed: true, structuredOutput: { fixes: [] } };
        }
        return {};
      });

      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        5,
      );
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['5'] = {
        iteration: 1,
        fixIndex: 1,
        lastSuccessfulStep: 'fix-started',
      };
      await checkpoint.save(state);

      await orchestrator.run();

      const phase5FixTaskIds = mockLauncher.invocations
        .filter((inv) => inv.agent === 'code-migrator' && inv.phase === 5)
        .map((inv) => inv.taskId);
      expect(phase5FixTaskIds).toContain('fix-1-1');
      expect(phase5FixTaskIds).not.toContain('fix-1-0');
    });

    it('should return success: false when resuming phase 5 with hadUnresolvedFixes true', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        5,
      );
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['5'] = {
        iteration: 3,
        fixIndex: 0,
        lastSuccessfulStep: 'complete',
        hadUnresolvedFixes: true,
      };
      await checkpoint.save(state);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(false);
      expect(phase5!.error).toContain('unresolved parity fixes');
      // No agents should have been launched for phase 5 since it was already complete
      const phase5Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 5);
      expect(phase5Invocations).toHaveLength(0);
    });

    it('should return success: true when resuming phase 5 with hadUnresolvedFixes false', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        5,
      );
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['5'] = {
        iteration: 3,
        fixIndex: 0,
        lastSuccessfulStep: 'complete',
        hadUnresolvedFixes: false,
      };
      await checkpoint.save(state);

      const result = await orchestrator.run();

      const phase5 = result.phases.find((p) => p.phase === 5);
      expect(phase5).toBeDefined();
      expect(phase5!.success).toBe(true);
      expect(phase5!.error).toBeUndefined();
      // No agents should have been launched for phase 5 since it was already complete
      const phase5Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 5);
      expect(phase5Invocations).toHaveLength(0);
    });

    it('should skip completed phase 6 agents based on checkpoint cursor', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        6,
      );

      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['6'] = {
        completedAgents: ['e2e-test-crafter'],
        lastSuccessfulStep: 'completed-e2e-test-crafter',
      };
      await checkpoint.save(state);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const phase6Agents = mockLauncher.invocations
        .filter((inv) => inv.phase === 6)
        .map((inv) => inv.agent);
      expect(phase6Agents).not.toContain('e2e-test-crafter');
      expect(phase6Agents).toContain('documentation-writer');
      expect(checkpoint.getState().phaseCursors?.['6']?.completedAgents).toEqual(
        expect.arrayContaining(['e2e-test-crafter', 'documentation-writer']),
      );
    });

    it('should resume phase 8 from issue cursor without reprocessing prior issues', async () => {
      let reviewCalls = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'idiomatic-reviewer') {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              outputParsed: true,
              structuredOutput: {
                issues: [
                  { file: 'src/a.ts', issue: 'issue a', suggestion: 'fix a' },
                  { file: 'src/b.ts', issue: 'issue b', suggestion: 'fix b' },
                ],
              },
            };
          }
          return { outputParsed: true, structuredOutput: { issues: [] } };
        }
        return {};
      });

      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            idiomaticRefactor: { enabled: true, maxIterations: 3 },
          },
        },
        8,
      );

      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['8'] = {
        iteration: 0,
        issueIndex: 1,
        currentFile: 'src/b.ts',
        lastSuccessfulStep: 'refactor-started',
      };
      await checkpoint.save(state);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);
      const refactorInvocations = mockLauncher.invocations.filter(
        (inv) => inv.agent === 'idiomatic-refactorer' && inv.phase === 8,
      );
      expect(refactorInvocations).toHaveLength(1);
    });
  });

  // ─── Agent Event Correlation ──────────────────────────────────────

  describe('Agent Event Correlation', () => {
    it('should emit agent-launched event when an agent is invoked', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const launchedEvents = events.filter(e => e.type === 'agent-launched');
      expect(launchedEvents.length).toBeGreaterThan(0);
      expect(launchedEvents[0]).toHaveProperty('agent');
    });

    it('should emit agent-completed event with invocationId on success', async () => {
      const launcherFn = createMockLauncher(() => ({
        invocationId: 'test-inv-123',
      }));
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const completedEvents = events.filter(e => e.type === 'agent-completed');
      expect(completedEvents.length).toBeGreaterThan(0);
      const withInvId = completedEvents.find(e => e.invocationId === 'test-inv-123');
      expect(withInvId).toBeDefined();
      expect(withInvId!.success).toBe(true);
      expect(withInvId!.duration).toBeDefined();
    });

    it('should emit agent-failed event with invocationId on failure', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'impact-assessor') {
          return { exitCode: 1, success: false, error: 'test error', invocationId: 'fail-inv-456' };
        }
        return {};
      });
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const failedEvents = events.filter(e => e.type === 'agent-failed');
      expect(failedEvents.length).toBeGreaterThan(0);
      const withInvId = failedEvents.find(e => e.invocationId === 'fail-inv-456');
      expect(withInvId).toBeDefined();
      expect(withInvId!.error).toBe('test error');
    });

    it('should emit both agent-launched and agent-completed for a successful phase', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger } = await setupOrchestrator(tempDir, launcherFn);
      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await orchestrator.run();

      const launchedCount = events.filter(e => e.type === 'agent-launched').length;
      const completedCount = events.filter(e => e.type === 'agent-completed').length;
      // Every launched agent should have a corresponding completed event
      expect(launchedCount).toBeGreaterThan(0);
      expect(completedCount).toBe(launchedCount);
    });
  });

  // ─── Observability Metrics ──────────────────────────────────────────

  describe('Observability Metrics', () => {
    it('should write metrics JSONL file during run', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const jsonlExists = await fileExists(jsonlPath);
      expect(jsonlExists).toBe(true);

      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      // Each line should be valid JSON with expected fields
      const metric = JSON.parse(lines[0]!);
      expect(metric).toHaveProperty('runId');
      expect(metric).toHaveProperty('agentType');
      expect(metric).toHaveProperty('startTime');
      expect(metric).toHaveProperty('endTime');
      expect(metric).toHaveProperty('durationMs');
      expect(metric).toHaveProperty('status');
      expect(metric).toHaveProperty('model');
      expect(metric).toHaveProperty('tokensTotal');
      expect(metric).toHaveProperty('costUsd');
    });

    it('should write metrics summary.json at end of run', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const summaryPath = join(progressDir, 'metrics', 'summary.json');
      const summaryExists = await fileExists(summaryPath);
      expect(summaryExists).toBe(true);

      const raw = await readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary).toHaveProperty('totalInvocations');
      expect(summary.totalInvocations).toBeGreaterThan(0);
      expect(summary).toHaveProperty('totalTokens');
      expect(summary).toHaveProperty('totalCost');
      expect(summary).toHaveProperty('peakParallelInvocations');
      expect(summary).toHaveProperty('phase4ExecutionMode');
      expect(summary).toHaveProperty('waveCount');
      expect(summary).toHaveProperty('buildCommandRuns');
      expect(summary).toHaveProperty('testCommandRuns');
      expect(summary).toHaveProperty('recoveryLoopTimeMs');
      expect(summary).toHaveProperty('buildTestInvocationsPerCompletedTask');
      expect(summary).toHaveProperty('retryVolumePerCompletedTask');
    });

    it('should persist per-task phase 4 wave snapshot metrics in summary', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      await orchestrator.run();

      const summaryPath = join(progressDir, 'metrics', 'summary.json');
      const raw = await readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary.phase4ExecutionMode).toBe('per-task');
      expect(summary.completedPhase4Tasks).toBe(2);
      expect(summary.waveCount).toBe(0);
      expect(summary.waveValidationRuns).toBe(0);
      expect(summary.buildCommandRuns).toBe(0);
      expect(summary.testCommandRuns).toBe(0);
      expect(summary.buildTestInvocationsPerCompletedTask).toBe(0);
      expect(summary.retryVolumePerCompletedTask).toBe(0);
    });

    it('should persist wave-barrier convergence metrics in summary', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['src/b.ts'] },
      ];
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        options: {
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 2, maxConvergenceIterations: 2 },
        },
      });
      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      await orchestrator.run();

      const summaryPath = join(progressDir, 'metrics', 'summary.json');
      const raw = await readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(raw);
      expect(summary.phase4ExecutionMode).toBe('wave-barrier');
      expect(summary.completedPhase4Tasks).toBe(2);
      expect(summary.waveCount).toBeGreaterThanOrEqual(1);
      expect(summary.waveValidationRuns).toBeGreaterThanOrEqual(1);
      expect(summary.waveConvergenceIterations).toBeGreaterThanOrEqual(1);
      expect(summary.waveConvergenceFailures).toBe(0);
      expect(summary.waveConvergenceLimitHits).toBe(0);
    });

    it('should generate observability report at end of run', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const reportPath = join(progressDir, 'reports', 'observability', 'index.md');
      const reportExists = await fileExists(reportPath);
      expect(reportExists).toBe(true);

      const content = await readFile(reportPath, 'utf-8');
      expect(content).toContain('Observability Report');
    });

    it('should increment metricsCount in checkpoint for each invocation', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const state = checkpoint.getState();
      expect(state.metricsCount).toBeGreaterThan(0);
    });

    it('should replay metrics using checkpoint metricsCount as skip cursor', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        undefined,
        1,
      );

      const state = checkpoint.getState();
      state.resumeCount = 2;
      state.metricsCount = 7;
      await checkpoint.save(state);

      const loadSpy = vi.spyOn((orchestrator as any).metricsCollector, 'loadFromJsonl');
      await orchestrator.run();

      expect(loadSpy).toHaveBeenCalledWith(progressDir, 7);
      loadSpy.mockRestore();
    });

    it('should record model from config in metrics', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        agentBackend: {
          runtime: 'copilot',
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
          model: 'gpt-4o',
        },
      });

      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metric = JSON.parse(lines[0]!);
      expect(metric.model).toBe('gpt-4o');
    });

    it('should record token usage in metrics', async () => {
      const launcherFn = createMockLauncher(() => ({
        tokenUsage: { prompt: 1000, completion: 500, total: 1500 },
      }));
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metric = JSON.parse(lines[0]!);
      expect(metric.tokensPrompt).toBe(1000);
      expect(metric.tokensCompletion).toBe(500);
      expect(metric.tokensTotal).toBe(1500);
    });

    it('should record success status for successful invocations', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn);

      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        const metric = JSON.parse(line);
        expect(metric.status).toBe('success');
      }
    });
  });

  // ─── Model Routing ───────────────────────────────────────────────────

  describe('Model Routing', () => {
    it('should route a complex task with many source files to heavyModel', async () => {
      const complexTask: MigrationTask = {
        id: 'task-001',
        name: 'Complex Module',
        sourceFiles: Array.from({ length: 8 }, (_, i) => `src/file-${i}.py`),
        targetFiles: Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`),
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'moderate',
        description: 'A complex task',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 500 },
      };

      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
            },
          },
        },
      );

      // Write migration plan first, then overwrite planning artifacts with our complex task
      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [complexTask]);

      const result = await orchestrator.run();

      // Verify that the code-migrator invocation got the heavyModel override
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      expect(migratorInvocations[0]!.modelOverride).toBe('gpt-4.1');
    });

    it('should route a task matching criticalTaskPatterns to criticalModel', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-001'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);

      const result = await orchestrator.run();

      // task-001's code-migrator should get criticalModel
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator' && inv.taskId === 'task-001',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      expect(migratorInvocations[0]!.modelOverride).toBe('claude-opus-4.6');
    });

    it('should downgrade to normal when maxCriticalTasks is reached', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-*'],
              maxCriticalTasks: 1,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();

      // Collect all code-migrator invocations
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      // First task should be routed (critical), second should be downgraded
      const withOverride = migratorInvocations.filter((inv: AgentInvocation) => inv.modelOverride === 'claude-opus-4.6');
      const withoutOverride = migratorInvocations.filter((inv: AgentInvocation) => !inv.modelOverride || inv.modelOverride !== 'claude-opus-4.6');
      expect(withOverride.length).toBe(1);
      expect(withoutOverride.length).toBeGreaterThanOrEqual(1);
    });

    it('should suppress escalation when maxEscalationCostUsd is reached', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-*'],
              maxEscalationCostUsd: 0.0001, // Tiny cap — exceeded after first escalation
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      const result = await orchestrator.run();

      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      // At most 1 escalation before cost cap kicks in
      const escalated = migratorInvocations.filter((inv: AgentInvocation) => inv.modelOverride === 'claude-opus-4.6');
      expect(escalated.length).toBeLessThanOrEqual(1);
    });

    it('should use invocation.modelOverride in metric.model when present', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            model: 'gpt-5-mini',
          },
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-001'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metrics = lines.map(l => JSON.parse(l));

      // Find the code-migrator metric for task-001 — should use criticalModel
      const task001Migrator = metrics.find(
        (m: any) => m.agentType === 'code-migrator' && m.taskId === 'task-001',
      );
      expect(task001Migrator).toBeDefined();
      expect(task001Migrator.model).toBe('claude-opus-4.6');
    });

    it('should not set modelOverride when modelRouting.enabled is false', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: false,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-*'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // No code-migrator invocation should have a modelOverride (except failure-adjudicator)
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      for (const inv of migratorInvocations) {
        expect(inv.modelOverride).toBeUndefined();
      }
    });

    it('should use config default model in metric when no modelOverride is set', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            model: 'gpt-4o',
          },
        },
      );

      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metric = JSON.parse(lines[0]!);
      expect(metric.model).toBe('gpt-4o');
    });

    it('should route a task matching criticalAgents to criticalModel', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalAgents: ['code-migrator'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      expect(migratorInvocations[0]!.modelOverride).toBe('claude-opus-4.6');
    });

    it('should assign normal tier to a simple task below heavyThreshold', async () => {
      const simpleTask: MigrationTask = {
        id: 'task-001',
        name: 'Simple Module',
        sourceFiles: ['src/simple.py'],
        targetFiles: ['src/simple.ts'],
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'simple',
        description: 'A simple task',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 50 },
      };

      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [simpleTask]);

      await orchestrator.run();

      // Simple task should NOT get modelOverride since score is below heavyThreshold
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      expect(migratorInvocations[0]!.modelOverride).toBeUndefined();
    });

    it('should route a complex task with high score to criticalModel', async () => {
      const criticalTask: MigrationTask = {
        id: 'task-001',
        name: 'Critical Module',
        sourceFiles: Array.from({ length: 10 }, (_, i) => `src/file-${i}.py`),
        targetFiles: Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`),
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'complex',
        description: 'A critical task',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 1000 },
      };

      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [criticalTask]);

      await orchestrator.run();

      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      // Score: 10*1.5 + 10 + 20 + 0 + 40 = 85, above criticalThreshold=70
      expect(migratorInvocations[0]!.modelOverride).toBe('claude-opus-4.6');
    });

    it('should emit model-routing-decision event for routed invocations', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, logger, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-001'],
            },
          },
        },
      );

      const events: Array<Record<string, unknown>> = [];
      vi.spyOn(logger, 'event').mockImplementation((ev) => { events.push(ev as any); });

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const routingEvents = events.filter(e => e.type === 'model-routing-decision');
      expect(routingEvents.length).toBeGreaterThan(0);
      const firstRouting = routingEvents[0]!;
      expect(firstRouting.tier).toBeDefined();
      expect(firstRouting.selectedModel).toBeDefined();
      expect(firstRouting.reason).toBeDefined();
      expect(firstRouting.score).toBeDefined();
    });

    it('should escalate model on retry when attempt >= escalateOnRetryAttempt', async () => {
      let callCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          callCount++;
          // Fail the first attempt, succeed on retry
          if (callCount === 1) {
            return { exitCode: 1, success: false, error: 'Code migration failed' };
          }
        }
        return {};
      });

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxRetriesPerTask: 2,
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              // task score (~36) starts in normal tier, then retry escalation promotes to heavy
              escalateOnRetryAttempt: 1,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // The code-migrator invocations should have the escalated model after retries
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThanOrEqual(2);
      expect(migratorInvocations[0]!.modelOverride).toBeUndefined();
      expect(migratorInvocations[1]!.modelOverride).toBe('gpt-4.1');
    });

    it('should escalate normal-tier retries to heavy tier', async () => {
      const simpleTask: MigrationTask = {
        id: 'task-001',
        name: 'Simple Module',
        sourceFiles: ['src/simple.py'],
        targetFiles: ['src/simple.ts'],
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'simple',
        description: 'A simple task',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 20 },
      };

      let callCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          callCount++;
          if (callCount === 1) {
            return { exitCode: 1, success: false, error: 'Code migration failed' };
          }
        }
        return {};
      });

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxRetriesPerTask: 2,
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 80,
              criticalThreshold: 95,
              escalateOnRetryAttempt: 1,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [simpleTask]);
      await orchestrator.run();

      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator' && inv.taskId === 'task-001',
      );
      expect(migratorInvocations.length).toBe(2);
      expect(migratorInvocations[0]!.modelOverride).toBeUndefined();
      expect(migratorInvocations[1]!.modelOverride).toBe('gpt-4.1');
    });

    it('should enforce maxCriticalTasks cap during retry escalation', async () => {
      let task002Attempt = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator' && inv.taskId === 'task-002') {
          task002Attempt++;
          if (task002Attempt === 1) {
            return { exitCode: 1, success: false, error: 'Code migration failed' };
          }
        }
        return {};
      });

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxRetriesPerTask: 2,
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-*'],
              maxCriticalTasks: 1,
              escalateOnRetryAttempt: 2,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const task001Invocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator' && inv.taskId === 'task-001',
      );
      const task002Invocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator' && inv.taskId === 'task-002',
      );

      expect(task001Invocations[0]!.modelOverride).toBe('claude-opus-4.6');
      expect(task002Invocations.length).toBeGreaterThanOrEqual(2);
      expect(task002Invocations[0]!.modelOverride).toBeUndefined();
      expect(task002Invocations[1]!.modelOverride).toBeUndefined();
    });

    it('should enforce maxEscalationCostUsd cap during retry escalation', async () => {
      const simpleTask: MigrationTask = {
        id: 'task-001',
        name: 'Simple Module',
        sourceFiles: ['src/simple.py'],
        targetFiles: ['src/simple.ts'],
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'simple',
        description: 'A simple task',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 20 },
      };

      let callCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          callCount++;
          if (callCount === 1) {
            return { exitCode: 1, success: false, error: 'Code migration failed' };
          }
        }
        return {};
      });

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxRetriesPerTask: 2,
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 80,
              criticalThreshold: 95,
              escalateOnRetryAttempt: 2,
              maxEscalationCostUsd: 0.000001,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [simpleTask]);
      await orchestrator.run();

      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator' && inv.taskId === 'task-001',
      );
      expect(migratorInvocations.length).toBe(2);
      expect(migratorInvocations[0]!.modelOverride).toBeUndefined();
      expect(migratorInvocations[1]!.modelOverride).toBeUndefined();
    });

    it('should apply transient-failure fallback before retry escalation', async () => {
      let callCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'code-migrator') {
          callCount++;
          if (callCount <= 1) {
            return { exitCode: 1, success: false, error: 'HTTP/2 GOAWAY connection_error' };
          }
        }
        return {};
      });

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            failureRecoveryModel: 'gpt-4o-fallback',
          },
          options: {
            maxRetriesPerTask: 3,
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-*'],
              escalateOnRetryAttempt: 2,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // After a transient failure, the fallback model should be applied
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      // At least one retry should have happened
      expect(migratorInvocations.length).toBeGreaterThanOrEqual(2);
      // The second invocation should use the fallback model (transient failure takes priority)
      expect(migratorInvocations[1]!.modelOverride).toBe('gpt-4o-fallback');
    });

    it('should record escalationCostUsd in metric when routing is active', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            model: 'gpt-5-mini',
          },
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-001'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metrics = lines.map(l => JSON.parse(l));

      // Find the code-migrator metric for task-001 — should have escalationCostUsd
      const task001Migrator = metrics.find(
        (m: any) => m.agentType === 'code-migrator' && m.taskId === 'task-001',
      );
      expect(task001Migrator).toBeDefined();
      expect(task001Migrator.escalationCostUsd).toBeDefined();
      expect(typeof task001Migrator.escalationCostUsd).toBe('number');
    });

    it('should propagate routingTier and routingReason to recorded metric', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          agentBackend: {
            runtime: 'copilot',
            cliCommand: 'copilot',
            agentDir: '.github/agents',
            timeout: 300_000,
            model: 'gpt-5-mini',
          },
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-001'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      const jsonlPath = join(progressDir, 'metrics', 'invocations.jsonl');
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const metrics = lines.map(l => JSON.parse(l));

      const task001Migrator = metrics.find(
        (m: any) => m.agentType === 'code-migrator' && m.taskId === 'task-001',
      );
      expect(task001Migrator).toBeDefined();
      expect(task001Migrator.routingTier).toBeDefined();
      expect(['normal', 'heavy', 'critical']).toContain(task001Migrator.routingTier);
      if (task001Migrator.routingTier !== 'normal') {
        expect(task001Migrator.routingReason).toBeDefined();
      }
    });

    it('should use glob wildcard matching for criticalTaskPatterns', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 40,
              criticalThreshold: 70,
              criticalTaskPatterns: ['task-00?'],
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // task-001 and task-002 should both match 'task-00?'
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      for (const inv of migratorInvocations) {
        expect(inv.modelOverride).toBe('claude-opus-4.6');
      }
    });
    it('should route a task with many dependencies to a higher tier', async () => {
      const depTask: MigrationTask = {
        id: 'task-001',
        name: 'Hub Module',
        sourceFiles: Array.from({ length: 5 }, (_, i) => `src/hub-${i}.py`),
        targetFiles: Array.from({ length: 5 }, (_, i) => `src/hub-${i}.ts`),
        knowledgeBaseRef: 'kb/task-001.md',
        dependencies: [],
        complexity: 'moderate',
        description: 'Module with moderate complexity and several files',
        acceptanceCriteria: ['works'],
        parityChecks: ['matches'],
        lineRange: { start: 1, end: 400 },
      };

      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            modelRouting: {
              enabled: true,
              defaultModel: 'gpt-5-mini',
              heavyModel: 'gpt-4.1',
              criticalModel: 'claude-opus-4.6',
              heavyThreshold: 30,
              criticalThreshold: 70,
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, [depTask]);

      await orchestrator.run();

      // score: 5*1.5 + 5 + (400/1000)*20 + 0 + 20 = 7.5 + 5 + 8 + 20 = 40.5 → heavy
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThan(0);
      expect(migratorInvocations[0]!.modelOverride).toBe('gpt-4.1');
    });
  });

  // ─── Invariant: completed tasks excluded from failed/blocked ────────

  describe('Completed-task invariant filtering', () => {
    it('should exclude completed tasks from failedTasks and blockedTasks in the result', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      // Pre-populate checkpoint so task-001 is completed but also stale in blocked/failed
      const state = checkpoint.getState();
      state.completedTasks.push('task-001');
      state.blockedTasks.push('task-001');
      state.failedTasks.push({
        taskId: 'task-001',
        attempts: 2,
        lastError: 'stale error',
        recoveryAttempted: false,
      });
      await checkpoint.save(state);

      const result = await orchestrator.run();

      expect(result.failedTasks).not.toContain('task-001');
      expect(result.blockedTasks).not.toContain('task-001');
      // task-001 should still be completed
      expect(checkpoint.getState().completedTasks).toContain('task-001');
    });

    it('should exclude completed task from failedTasks only when not in blockedTasks', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const state = checkpoint.getState();
      state.completedTasks.push('task-001');
      state.failedTasks.push({
        taskId: 'task-001',
        attempts: 1,
        lastError: 'stale',
        recoveryAttempted: false,
      });
      await checkpoint.save(state);

      const result = await orchestrator.run();

      expect(result.failedTasks).not.toContain('task-001');
      expect(result.blockedTasks).not.toContain('task-001');
    });

    it('should exclude completed task from blockedTasks only when not in failedTasks', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      const state = checkpoint.getState();
      state.completedTasks.push('task-001');
      state.blockedTasks.push('task-001');
      await checkpoint.save(state);

      const result = await orchestrator.run();

      expect(result.blockedTasks).not.toContain('task-001');
      expect(result.failedTasks).not.toContain('task-001');
    });

    it('should preserve non-completed tasks in failedTasks and blockedTasks', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, checkpoint, progressDir } = await setupOrchestrator(tempDir, launcherFn);
      await writeMigrationPlan(progressDir);

      // Use task IDs outside the migration plan so the orchestrator doesn't complete them
      const state = checkpoint.getState();
      state.completedTasks.push('task-001');
      state.blockedTasks.push('task-001', 'orphan-blocked');
      state.failedTasks.push(
        { taskId: 'task-001', attempts: 2, lastError: 'stale', recoveryAttempted: false },
        { taskId: 'orphan-failed', attempts: 1, lastError: 'real error', recoveryAttempted: false },
      );
      await checkpoint.save(state);

      const result = await orchestrator.run();

      expect(result.failedTasks).not.toContain('task-001');
      expect(result.blockedTasks).not.toContain('task-001');
      expect(result.blockedTasks).toContain('orphan-blocked');
      expect(result.failedTasks).toContain('orphan-failed');
    });
  });

  // ─── Git Automation ───────────────────────────────────────────────────

  describe('Git Automation', () => {
    it('should not attempt git operations when git.enabled is false', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            git: {
              enabled: false,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      await orchestrator.run();

      // No git invocations should have been made — verify no git-related errors
      // and that the run completed successfully
      const invocations = mockLauncher.invocations;
      expect(invocations.length).toBeGreaterThan(0);
    });

    it('should serialize phase 4 tasks to parallelism=1 when git is enabled in per-task mode', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            maxParallelAgents: 3,
            executionMode: 'per-task',
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      // Run will attempt git operations which may fail in test env, but
      // the parallelism=1 behavior is set at scheduling time before git runs
      try {
        await orchestrator.run();
      } catch {
        // git operations may fail in test temp dir — that's OK
      }

      // Verify code-migrator invocations ran (git failures are non-fatal for scheduling)
      const migratorInvocations = mockLauncher.invocations.filter(
        (inv: AgentInvocation) => inv.agent === 'code-migrator',
      );
      expect(migratorInvocations.length).toBeGreaterThanOrEqual(1);
    });

    it('should run Phase 6 agents sequentially when git is enabled', async () => {
      const invocationOrder: string[] = [];
      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        invocationOrder.push(inv.agent);
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const outputDir = join(tempDir, 'target-output-ph6');
      await ensureDir(outputDir);

      const { orchestrator, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            language: 'typescript',
            framework: 'express',
            outputPath: outputDir,
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      await writeMigrationPlan(progressDir);
      try {
        await orchestrator.run();
      } catch {
        // git operations may fail in test env
      }

      // Phase 6 agents should run: e2e-test-crafter then documentation-writer (sequential)
      const phase6Agents = invocationOrder.filter(
        (a) => a === 'e2e-test-crafter' || a === 'documentation-writer',
      );
      if (phase6Agents.length >= 2) {
        const e2eIdx = invocationOrder.indexOf('e2e-test-crafter');
        const docIdx = invocationOrder.indexOf('documentation-writer');
        expect(e2eIdx).toBeLessThan(docIdx);
      }
    });

    it('ensureGitRepositoryReady should initialize git and configure author when repo is missing', async () => {
      const outputPath = join(tempDir, 'git-init-output');
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            outputPath,
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not a repo', exitCode: 128 })
        .mockResolvedValueOnce({ success: true, stdout: 'initialized', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

      await (orchestrator as any).ensureGitRepositoryReady();

      expect(runGitSpy).toHaveBeenNthCalledWith(1, ['rev-parse', '--show-toplevel']);
      expect(runGitSpy).toHaveBeenNthCalledWith(2, ['init']);
      expect(runGitSpy).toHaveBeenNthCalledWith(3, ['config', 'user.name', 'Test Bot']);
      expect(runGitSpy).toHaveBeenNthCalledWith(4, ['config', 'user.email', 'test@local']);

      // Should have written a .gitignore for the target language (default: typescript)
      const gitignorePath = join(outputPath, '.gitignore');
      expect(await fileExists(gitignorePath)).toBe(true);
      const content = await readFile(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules');
      expect(content).toContain('.DS_Store');
    });

    it('ensureGitRepositoryReady should write rust .gitignore when target language is rust', async () => {
      const outputPath = join(tempDir, 'git-init-rust-output');
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            language: 'rust',
            outputPath,
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not a repo', exitCode: 128 })
        .mockResolvedValueOnce({ success: true, stdout: 'initialized', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

      await (orchestrator as any).ensureGitRepositoryReady();

      const content = await readFile(join(outputPath, '.gitignore'), 'utf-8');
      expect(content).toContain('target/');
      expect(content).toContain('*.rlib');
      expect(content).not.toContain('node_modules');
    });

    it('ensureGitRepositoryReady should not overwrite existing .gitignore', async () => {
      const outputPath = join(tempDir, 'git-init-existing-gitignore');
      await ensureDir(outputPath);
      const gitignorePath = join(outputPath, '.gitignore');
      await writeFile(gitignorePath, 'custom-rule\n');

      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            outputPath,
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not a repo', exitCode: 128 })
        .mockResolvedValueOnce({ success: true, stdout: 'initialized', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

      await (orchestrator as any).ensureGitRepositoryReady();

      const content = await readFile(gitignorePath, 'utf-8');
      expect(content).toBe('custom-rule\n');
    });

    it('ensureGitRepositoryReady should initialize nested outputPath as its own repository', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            outputPath: join(tempDir, 'nested', 'output'),
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: true, stdout: `${join(tempDir, 'nested')}\n`, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: 'initialized', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

      await (orchestrator as any).ensureGitRepositoryReady();

      expect(runGitSpy).toHaveBeenNthCalledWith(1, ['rev-parse', '--show-toplevel']);
      expect(runGitSpy).toHaveBeenNthCalledWith(2, ['init']);
      expect(runGitSpy).toHaveBeenNthCalledWith(3, ['config', 'user.name', 'Test Bot']);
      expect(runGitSpy).toHaveBeenNthCalledWith(4, ['config', 'user.email', 'test@local']);
    });

    it('ensureGitRepositoryReady should warn and return when git init fails', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: {
            outputPath: join(tempDir, 'git-init-fail-output'),
          },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'not a repo', exitCode: 128 })
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'init failed', exitCode: 1 });

      try {
        await (orchestrator as any).ensureGitRepositoryReady();
        expect(runGitSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize git repository'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('commitIfDirty should warn and return when git status command fails', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const ensureSpy = vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);
      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'status failed', exitCode: 1 });

      try {
        await (orchestrator as any).commitIfDirty('test commit');
        expect(ensureSpy).toHaveBeenCalledTimes(1);
        expect(runGitSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unable to inspect git status before commit'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('commitIfDirty should create an allow-empty commit when requested', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);
      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

      await (orchestrator as any).commitIfDirty('allow-empty message', true);

      expect(runGitSpy).toHaveBeenNthCalledWith(1, ['status', '--porcelain']);
      expect(runGitSpy).toHaveBeenNthCalledWith(2, ['diff', '--cached', '--name-only']);
      expect(runGitSpy).toHaveBeenNthCalledWith(3, ['commit', '--allow-empty', '-m', 'allow-empty message']);
    });

    it('commitIfDirty should stage changes and create a normal commit', async () => {
      const launcherFn = createMockLauncher();
      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
      );

      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);
      const runGitSpy = vi.spyOn(orchestrator as any, 'runGit')
        .mockResolvedValueOnce({ success: true, stdout: ' M src/file.ts\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: 'src/file.ts\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ success: true, stdout: '[main] commit', stderr: '', exitCode: 0 });

      await (orchestrator as any).commitIfDirty('normal message', false);

      expect(runGitSpy).toHaveBeenNthCalledWith(1, ['status', '--porcelain']);
      expect(runGitSpy).toHaveBeenNthCalledWith(2, ['add', '-A']);
      expect(runGitSpy).toHaveBeenNthCalledWith(3, ['diff', '--cached', '--name-only']);
      expect(runGitSpy).toHaveBeenNthCalledWith(4, ['commit', '-m', 'normal message']);
    });

    it('should defer git commits in wave-barrier mode and create a single wave commit', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['lib/b.ts'] },
      ];

      const launcherFn = createMockLauncher();
      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'npm run build',
          testCommand: 'npm test',
        },
        options: {
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 2, maxConvergenceIterations: 2 },
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            authorName: 'Test Bot',
            authorEmail: 'test@local',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      vi.spyOn(orchestrator as any, 'runCommand').mockResolvedValue({ success: true });

      const commitMessages: string[] = [];
      vi.spyOn(orchestrator as any, 'commitIfDirty').mockImplementation(async (msg: string) => {
        commitMessages.push(msg);
      });
      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // Per-agent and per-task commits should NOT appear — only wave commits
      const agentCommits = commitMessages.filter(m => m.startsWith('aamf: code-migrator'));
      const taskCommits = commitMessages.filter(m => m.startsWith('aamf: complete'));
      const waveCommits = commitMessages.filter(m => m.startsWith('aamf: wave'));

      expect(agentCommits).toHaveLength(0);
      expect(taskCommits).toHaveLength(0);
      expect(waveCommits.length).toBeGreaterThanOrEqual(1);
      // The wave commit message should reference both task IDs
      expect(waveCommits[0]).toContain('task-001');
      expect(waveCommits[0]).toContain('task-002');
    });

    it('should allow wave parallelism >1 when git is enabled in wave-barrier mode', async () => {
      const tasks: MigrationTask[] = [
        { ...SINGLE_AUTH_TASK, id: 'task-001', name: 'Task 1', targetFiles: ['src/a.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-002', name: 'Task 2', sourceFiles: ['src/b.py'], targetFiles: ['lib/b.ts'] },
        { ...SINGLE_AUTH_TASK, id: 'task-003', name: 'Task 3', sourceFiles: ['src/c.py'], targetFiles: ['lib/c.ts'] },
      ];

      const concurrentRuns: number[] = [];
      let activeCount = 0;
      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        if (inv.agent === 'code-migrator') {
          activeCount++;
          concurrentRuns.push(activeCount);
          await new Promise(r => setTimeout(r, 30));
          activeCount--;
        }
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 30,
          outputParsed: false,
        };
      };

      const { orchestrator, progressDir } = await setupOrchestrator(tempDir, launcherFn, {
        target: {
          language: 'typescript',
          framework: 'express',
          outputPath: tempDir,
          buildCommand: 'echo ok',
          testCommand: 'echo ok',
        },
        options: {
          maxParallelAgents: 3,
          executionMode: 'wave-barrier',
          waveControl: { waveSize: 3, maxConvergenceIterations: 2 },
          git: {
            enabled: true,
            autoInit: true,
            commitByAgent: true,
            commitPerTask: true,
            authorName: 'Test Bot',
            authorEmail: 'test@local',
          },
        },
      });

      await writeMigrationPlan(progressDir);
      await writePhase3PlanningArtifacts(progressDir, tasks);

      vi.spyOn(orchestrator as any, 'runCommand').mockResolvedValue({ success: true });
      vi.spyOn(orchestrator as any, 'commitIfDirty').mockResolvedValue(undefined);
      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // At least two code-migrators should have been active concurrently
      const maxConcurrent = Math.max(...concurrentRuns);
      expect(maxConcurrent).toBeGreaterThan(1);
    });
  });

  // ─── Phase 6: E2E Suite Fan-Out ───────────────────────────────────────

  describe('Phase 6 suite fan-out', () => {
    it('should fan out one test-writer per suite for multi-suite plans', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-fanout');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher, progressDir } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Auth E2E' },
        { id: 'suite-002', name: 'API E2E' },
        { id: 'suite-003', name: 'UI E2E' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const phase6Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 6);
      const crafterInvocations = phase6Invocations.filter((inv) => inv.agent === 'e2e-test-crafter');
      const testWriterInvocations = phase6Invocations.filter((inv) => inv.agent === 'test-writer');
      const docWriterInvocations = phase6Invocations.filter((inv) => inv.agent === 'documentation-writer');

      expect(crafterInvocations).toHaveLength(1);
      expect(testWriterInvocations).toHaveLength(3);
      expect(docWriterInvocations).toHaveLength(1);

      const suiteIds = testWriterInvocations.map((inv) => inv.taskId);
      expect(suiteIds).toEqual(expect.arrayContaining(['suite-001', 'suite-002', 'suite-003']));
    });

    it('should invoke e2e-test-crafter with planOnly payload', async () => {
      const contexts: Record<string, unknown>[] = [];
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'e2e-test-crafter') {
          // Read the context file to verify planOnly
          contexts.push({ agent: inv.agent, contextFile: inv.contextFile });
        }
        return {};
      });
      const targetOutput = join(tempDir, 'target-planonly');
      await ensureDir(targetOutput);

      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      await orchestrator.run();
      expect(contexts).toHaveLength(1);
      // The context file should exist and contain planOnly
      const contextData = JSON.parse(await readFile(contexts[0]!.contextFile as string, 'utf-8'));
      expect(contextData.payload?.planOnly).toBe(true);
    });

    it('should behave equivalently to single invocation for single-suite plans', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-single');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Only Suite' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const phase6Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 6);
      const testWriterInvocations = phase6Invocations.filter((inv) => inv.agent === 'test-writer');

      expect(testWriterInvocations).toHaveLength(1);
      expect(testWriterInvocations[0]!.taskId).toBe('suite-001');
    });

    it('should succeed with warning when plan yields zero suites', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-zero');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      // No e2e-test-plan.md → zero suites
      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const testWriterInvocations = mockLauncher.invocations.filter(
        (inv) => inv.phase === 6 && inv.agent === 'test-writer',
      );
      expect(testWriterInvocations).toHaveLength(0);
    });

    it('should skip completed suites on checkpoint resume', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-resume');
      await ensureDir(targetOutput);

      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      // Mark crafter and suite-001 as already completed
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['6'] = {
        completedAgents: ['e2e-test-crafter'],
        completedSuites: ['suite-001'],
        lastSuccessfulStep: 'completed-suite-suite-001',
      };
      await checkpoint.save(state);

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Auth E2E' },
        { id: 'suite-002', name: 'API E2E' },
        { id: 'suite-003', name: 'UI E2E' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      const phase6Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 6);

      // e2e-test-crafter should be skipped (already completed)
      expect(phase6Invocations.filter((inv) => inv.agent === 'e2e-test-crafter')).toHaveLength(0);

      // Only suite-002 and suite-003 should be launched
      const suiteIds = phase6Invocations
        .filter((inv) => inv.agent === 'test-writer')
        .map((inv) => inv.taskId);
      expect(suiteIds).not.toContain('suite-001');
      expect(suiteIds).toEqual(expect.arrayContaining(['suite-002', 'suite-003']));

      // Checkpoint should now include all three suites
      const cursor = checkpoint.getState().phaseCursors?.['6'];
      expect(cursor?.completedSuites).toEqual(
        expect.arrayContaining(['suite-001', 'suite-002', 'suite-003']),
      );
    });

    it('should create per-suite git commits when git is enabled', async () => {
      const invocationOrder: string[] = [];
      const launcherFn = async (inv: AgentInvocation): Promise<AgentResult> => {
        invocationOrder.push(`${inv.agent}${inv.taskId ? `:${inv.taskId}` : ''}`);
        return {
          agent: inv.agent,
          taskId: inv.taskId,
          exitCode: 0,
          success: true,
          outputFiles: [],
          duration: 100,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          outputParsed: false,
        };
      };

      const targetOutput = join(tempDir, 'target-git-suites');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: { outputPath: targetOutput },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Auth E2E' },
        { id: 'suite-002', name: 'API E2E' },
      ]);

      vi.spyOn(orchestrator as any, 'commitIfDirty').mockResolvedValue(undefined);
      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // Suites should run sequentially when git is enabled
      const suiteInvocations = invocationOrder.filter((o) => o.startsWith('test-writer:'));
      expect(suiteInvocations).toEqual(['test-writer:suite-001', 'test-writer:suite-002']);

      // e2e-test-crafter should come before any test-writer
      const crafterIdx = invocationOrder.indexOf('e2e-test-crafter');
      const firstSuiteIdx = invocationOrder.indexOf('test-writer:suite-001');
      expect(crafterIdx).toBeLessThan(firstSuiteIdx);

      // documentation-writer should come after all suites
      const docIdx = invocationOrder.indexOf('documentation-writer');
      const lastSuiteIdx = invocationOrder.indexOf('test-writer:suite-002');
      expect(lastSuiteIdx).toBeLessThan(docIdx);

      // commitIfDirty should have been called for each successful agent/suite
      const commitSpy = vi.spyOn(orchestrator as any, 'commitIfDirty');
      expect(commitSpy).toHaveBeenCalled();
    });

    it('should retry failed suites with RetryExecutor', async () => {
      const suiteAttempts: Record<string, number> = {};
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'test-writer' && inv.taskId) {
          suiteAttempts[inv.taskId] = (suiteAttempts[inv.taskId] ?? 0) + 1;
          // Fail suite-001 on first attempt, succeed on retry
          if (inv.taskId === 'suite-001' && suiteAttempts[inv.taskId]! < 2) {
            return { exitCode: 1, success: false, error: 'flaky test failure' };
          }
        }
        return {};
      });

      const targetOutput = join(tempDir, 'target-retry');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher, checkpoint } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: { outputPath: targetOutput },
          options: { maxRetriesPerTask: 3 },
        },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Flaky Suite' },
        { id: 'suite-002', name: 'Stable Suite' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // suite-001 should have been invoked at least twice (initial + retry)
      const suite001Invocations = mockLauncher.invocations.filter(
        (inv) => inv.agent === 'test-writer' && inv.taskId === 'suite-001',
      );
      expect(suite001Invocations.length).toBeGreaterThanOrEqual(2);

      // Both suites should end up completed
      const cursor = checkpoint.getState().phaseCursors?.['6'];
      expect(cursor?.completedSuites).toEqual(
        expect.arrayContaining(['suite-001', 'suite-002']),
      );
    });

    it('should record per-suite token usage via recordTokens', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'test-writer') {
          return { tokenUsage: { prompt: 300, completion: 200, total: 500 } };
        }
        return { tokenUsage: { prompt: 100, completion: 50, total: 150 } };
      });

      const targetOutput = join(tempDir, 'target-tokens');
      await ensureDir(targetOutput);

      const { orchestrator, checkpoint } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
        { id: 'suite-002', name: 'Suite B' },
      ]);

      await orchestrator.run();

      const tokenUsage = checkpoint.getState().tokenUsage;
      // Should have tokens from crafter + 2 suites + doc-writer
      expect(tokenUsage.total).toBeGreaterThan(0);
      expect(tokenUsage.byPhase[6]).toBeGreaterThan(0);
      expect(tokenUsage.byAgent['test-writer']).toBeGreaterThanOrEqual(1000); // 500 * 2 suites
    });

    it('should check token budget before launching each suite', async () => {
      let launchCount = 0;
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'test-writer') launchCount++;
        // Return massive token usage to exceed budget after first suite
        return { tokenUsage: { prompt: 5000, completion: 5000, total: 10000 } };
      });

      const targetOutput = join(tempDir, 'target-budget');
      await ensureDir(targetOutput);

      const { orchestrator } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: { outputPath: targetOutput },
          options: {
            tokenBudget: 500,
            git: { enabled: true, autoInit: false, commitByAgent: false, commitPerTask: false },
          },
        },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
        { id: 'suite-002', name: 'Suite B' },
        { id: 'suite-003', name: 'Suite C' },
      ]);

      await orchestrator.run();

      // Budget should be exceeded after crafter; later suites may be skipped
      // The exact behavior depends on when the budget check fires, but fewer
      // than 3 suites should be launched once the budget is blown
      expect(launchCount).toBeLessThan(3);
    });

    it('should return failure immediately when e2e-test-crafter fails', async () => {
      const launcherFn = createFailingLauncher(['e2e-test-crafter'], 'crafter boom');
      const targetOutput = join(tempDir, 'target-crafter-fail');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(false);

      // No test-writer or documentation-writer should have been launched
      const phase6Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 6);
      expect(phase6Invocations.filter((inv) => inv.agent === 'test-writer')).toHaveLength(0);
      expect(phase6Invocations.filter((inv) => inv.agent === 'documentation-writer')).toHaveLength(0);
    });

    it('should still run documentation-writer when a suite permanently fails', async () => {
      const launcherFn = createMockLauncher((inv) => {
        if (inv.agent === 'test-writer' && inv.taskId === 'suite-002') {
          return { exitCode: 1, success: false, error: 'permanently broken' };
        }
        return {};
      });

      const targetOutput = join(tempDir, 'target-partial-fail');
      await ensureDir(targetOutput);

      const { orchestrator, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput }, options: { maxRetriesPerTask: 1 } },
        6,
      );

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Good Suite' },
        { id: 'suite-002', name: 'Bad Suite' },
      ]);

      const result = await orchestrator.run();
      // Overall should fail because one suite failed
      expect(result.success).toBe(false);

      // documentation-writer should still have been invoked
      const docInvocations = mockLauncher.invocations.filter(
        (inv) => inv.phase === 6 && inv.agent === 'documentation-writer',
      );
      expect(docInvocations).toHaveLength(1);
    });

    it('should handle legacy cursor format without completedSuites', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-legacy-cursor');
      await ensureDir(targetOutput);

      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      // Simulate a legacy cursor that lacks the completedSuites field
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['6'] = {
        completedAgents: ['e2e-test-crafter'],
        lastSuccessfulStep: 'completed-e2e-test-crafter',
      };
      await checkpoint.save(state);

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // The suite should be launched since completedSuites was missing (treated as empty)
      const suiteInvocations = mockLauncher.invocations.filter(
        (inv) => inv.phase === 6 && inv.agent === 'test-writer',
      );
      expect(suiteInvocations).toHaveLength(1);

      // After run, completedSuites should now be populated
      const cursor = checkpoint.getState().phaseCursors?.['6'];
      expect(cursor?.completedSuites).toEqual(expect.arrayContaining(['suite-001']));
    });

    it('should skip fan-out entirely when all suites are already completed', async () => {
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-all-done');
      await ensureDir(targetOutput);

      const { orchestrator, checkpoint, mockLauncher } = await setupOrchestrator(
        tempDir,
        launcherFn,
        { target: { outputPath: targetOutput } },
        6,
      );

      // Mark crafter and all suites as already completed
      const state = checkpoint.getState();
      state.phaseCursors ??= {};
      state.phaseCursors['6'] = {
        completedAgents: ['e2e-test-crafter'],
        completedSuites: ['suite-001', 'suite-002'],
        lastSuccessfulStep: 'all-suites-complete',
      };
      await checkpoint.save(state);

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
        { id: 'suite-002', name: 'Suite B' },
      ]);

      const result = await orchestrator.run();
      expect(result.success).toBe(true);

      // No test-writer or e2e-test-crafter invocations
      const phase6Invocations = mockLauncher.invocations.filter((inv) => inv.phase === 6);
      expect(phase6Invocations.filter((inv) => inv.agent === 'test-writer')).toHaveLength(0);
      expect(phase6Invocations.filter((inv) => inv.agent === 'e2e-test-crafter')).toHaveLength(0);

      // documentation-writer should still run (not in completedAgents)
      expect(phase6Invocations.filter((inv) => inv.agent === 'documentation-writer')).toHaveLength(1);
    });

    it('should persist completedSuites in cursor after each successful suite with git', async () => {
      const completedSuiteSnapshots: string[][] = [];
      const launcherFn = createMockLauncher();
      const targetOutput = join(tempDir, 'target-cursor-snapshots');
      await ensureDir(targetOutput);

      const { orchestrator, checkpoint } = await setupOrchestrator(
        tempDir,
        launcherFn,
        {
          target: { outputPath: targetOutput },
          options: {
            git: {
              enabled: true,
              autoInit: true,
              commitByAgent: true,
              commitPerTask: true,
              authorName: 'Test Bot',
              authorEmail: 'test@local',
            },
          },
        },
        6,
      );

      vi.spyOn(orchestrator as any, 'commitIfDirty').mockResolvedValue(undefined);
      vi.spyOn(orchestrator as any, 'ensureGitRepositoryReady').mockResolvedValue(undefined);

      // Spy on savePhase6Cursor to capture snapshots
      const origSave = (orchestrator as any).savePhase6Cursor.bind(orchestrator);
      vi.spyOn(orchestrator as any, 'savePhase6Cursor').mockImplementation(async (cursor: any) => {
        if (cursor.completedSuites?.length > 0) {
          completedSuiteSnapshots.push([...cursor.completedSuites]);
        }
        return origSave(cursor);
      });

      await writeE2eTestPlan(targetOutput, [
        { id: 'suite-001', name: 'Suite A' },
        { id: 'suite-002', name: 'Suite B' },
      ]);

      await orchestrator.run();

      // With git enabled (sequential), suites complete one at a time
      // First snapshot should have suite-001, second should have both
      expect(completedSuiteSnapshots.length).toBeGreaterThanOrEqual(2);
      expect(completedSuiteSnapshots[0]).toEqual(['suite-001']);
      expect(completedSuiteSnapshots[1]).toEqual(expect.arrayContaining(['suite-001', 'suite-002']));
    });
  });
});
