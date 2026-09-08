import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTaskGraphStep } from '../../../src/flow/steps/task-graph.js';
import { setupFlowTest, createMockLauncher, makeTask, type FlowTestEnv } from '../../helpers/flow-mocks.js';

const graphMocks = vi.hoisted(() => ({
  buildTaskGraph: vi.fn(),
  buildDependencySummary: vi.fn(),
}));

vi.mock('../../../src/core/task-graph-builder.js', () => graphMocks);

let env: FlowTestEnv | undefined;

afterEach(async () => {
  if (env) await env.cleanup();
  env = undefined;
});

describe('buildTaskGraphStep', () => {
  it('does not accept a stale task graph when the current Lore database is absent', async () => {
    env = await setupFlowTest(createMockLauncher());
    const tasks = [makeTask('task-001')];
    await writeFile(env.ctx.paths.migrationPlanFile.replace('migration-plan.md', 'tasks-merged.json'), JSON.stringify(tasks));

    await expect(buildTaskGraphStep(env.flowCtx)).rejects.toThrow(
      'Lore KB database (kb.db) not found',
    );
  });

  it('fails before graph construction when the Phase 0 database is absent', async () => {
    env = await setupFlowTest(createMockLauncher());
    await expect(buildTaskGraphStep(env.flowCtx)).rejects.toThrow(
      'Lore KB database (kb.db) not found',
    );
  });

  it('overwrites stale graph sidecars when recomputation has no SCCs or compilation units', async () => {
    env = await setupFlowTest(createMockLauncher());
    await writeFile(env.ctx.paths.kbDbFile, 'current-kb');
    await mkdir(env.ctx.paths.artifactsPlanningDir, { recursive: true });
    const sccsFile = join(env.ctx.paths.artifactsPlanningDir, 'sccs.json');
    const unitsFile = join(env.ctx.paths.artifactsPlanningDir, 'compilation-units.json');
    await writeFile(sccsFile, JSON.stringify([['stale-a', 'stale-b']]));
    await writeFile(unitsFile, JSON.stringify([{ id: 'stale-unit' }]));
    graphMocks.buildDependencySummary.mockResolvedValue({
      fileCount: 0, totalLines: 0, modules: [], connectedComponents: [], sccs: [], fileMetrics: {},
    });
    graphMocks.buildTaskGraph.mockResolvedValue({
      tasks: [makeTask('current-task')], sccs: [], compilationUnits: [],
    });

    await buildTaskGraphStep(env.flowCtx);

    expect(JSON.parse(await readFile(sccsFile, 'utf-8'))).toEqual([]);
    expect(JSON.parse(await readFile(unitsFile, 'utf-8'))).toEqual([]);
  });
});
