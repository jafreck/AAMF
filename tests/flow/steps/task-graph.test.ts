import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { buildTaskGraphStep } from '../../../src/flow/steps/task-graph.js';
import { setupFlowTest, createMockLauncher, makeTask, type FlowTestEnv } from '../../helpers/flow-mocks.js';

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
});
