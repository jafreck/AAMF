import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { buildTaskGraphStep } from '../../../src/flow/steps/task-graph.js';
import { setupFlowTest, createMockLauncher, makeTask, type FlowTestEnv } from '../../helpers/flow-mocks.js';

let env: FlowTestEnv | undefined;

afterEach(async () => {
  if (env) await env.cleanup();
  env = undefined;
});

describe('buildTaskGraphStep', () => {
  it('loads all persisted graph artifacts on resume without opening a Lore database', async () => {
    env = await setupFlowTest(createMockLauncher());
    const tasks = [makeTask('task-001')];
    const sccs = [['task-001']];
    const compilationUnits = [{
      id: 'unit-1', name: 'Core', targetPath: 'src', sourceFiles: ['src/task-001.py'],
      dependsOn: [], rationale: 'single unit',
    }];
    await writeFile(join(env.ctx.paths.artifactsPlanningDir, 'tasks-merged.json'), JSON.stringify(tasks));
    await writeFile(join(env.ctx.paths.artifactsPlanningDir, 'sccs.json'), JSON.stringify(sccs));
    await writeFile(join(env.ctx.paths.artifactsPlanningDir, 'compilation-units.json'), JSON.stringify(compilationUnits));

    const result = await buildTaskGraphStep(env.flowCtx);

    expect(result.success).toBe(true);
    expect(result.tasks).toEqual(tasks);
    expect(result.sccs).toEqual(sccs);
    expect(result.compilationUnits).toEqual(compilationUnits);
    expect(env.ctx.phase1TaskGraphResult?.extensions.structuredOutput).toEqual({
      tasks, sccs, compilationUnits,
    });
  });

  it('fails before graph construction when the Phase 0 database is absent', async () => {
    env = await setupFlowTest(createMockLauncher());
    await expect(buildTaskGraphStep(env.flowCtx)).rejects.toThrow(
      'Lore KB database (kb.db) not found',
    );
  });
});
