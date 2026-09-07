import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TargetChangeSetManager } from '../../src/core/target-change-set.js';
import { fileExists } from '../../src/util/fs.js';

let root: string;
let target: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aamf-target-change-set-'));
  target = join(root, 'target');
  state = join(root, 'state');
  await mkdir(join(target, '.git'), { recursive: true });
  await writeFile(join(target, '.git', 'HEAD'), 'unchanged-head\n');
  await writeFile(join(target, 'existing.ts'), 'export const value = 1;\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(): TargetChangeSetManager {
  return new TargetChangeSetManager(target, state, {
    info: vi.fn(),
    warn: vi.fn(),
  });
}

describe('TargetChangeSetManager', () => {
  it('restores modified, deleted, and newly created files without changing Git HEAD', async () => {
    const changes = manager();
    await changes.begin('task-1');
    await writeFile(join(target, 'existing.ts'), 'export const value = 2;\n');
    await writeFile(join(target, 'created.ts'), 'created\n');

    await changes.rollback('task-1');

    expect(await readFile(join(target, 'existing.ts'), 'utf-8')).toBe('export const value = 1;\n');
    expect(await fileExists(join(target, 'created.ts'))).toBe(false);
    expect(await readFile(join(target, '.git', 'HEAD'), 'utf-8')).toBe('unchanged-head\n');
  });

  it('accepts successful changes and removes rollback state', async () => {
    const changes = manager();
    await changes.begin('task-1');
    await writeFile(join(target, 'existing.ts'), 'accepted\n');

    await changes.accept('task-1');
    await changes.rollback('task-1');

    expect(await readFile(join(target, 'existing.ts'), 'utf-8')).toBe('accepted\n');
    expect(await changes.has('task-1')).toBe(false);
  });

  it('recovers the outermost persisted snapshot after a crash', async () => {
    const beforeCrash = manager();
    await beforeCrash.begin('task-1');
    await writeFile(join(target, 'existing.ts'), 'partial attempt\n');
    await beforeCrash.begin('task-1/minor-repass');
    await writeFile(join(target, 'existing.ts'), 'regression\n');

    const afterCrash = manager();
    await expect(afterCrash.recoverPending()).resolves.toBe('task-1');

    expect(await readFile(join(target, 'existing.ts'), 'utf-8')).toBe('export const value = 1;\n');
    expect(await afterCrash.has('task-1')).toBe(false);
    expect(await afterCrash.has('task-1/minor-repass')).toBe(false);
  });

  it('rolls back concurrent tracked scopes without restoring sibling files', async () => {
    const changes = manager();
    await changes.begin('task-a', { mode: 'tracked', files: ['a.ts'] });
    await writeFile(join(target, 'a.ts'), 'candidate a\n');
    await changes.begin('task-b', { mode: 'tracked', files: ['b.ts'] });
    await writeFile(join(target, 'b.ts'), 'candidate b\n');

    await changes.rollback('task-a');
    expect(await fileExists(join(target, 'a.ts'))).toBe(false);
    expect(await readFile(join(target, 'b.ts'), 'utf-8')).toBe('candidate b\n');

    await changes.rollback('task-b');
    expect(await fileExists(join(target, 'b.ts'))).toBe(false);
  });

  it('fails closed for corrupt persisted state', async () => {
    await mkdir(join(state, 'target-change-sets', 'broken'), { recursive: true });
    await writeFile(join(state, 'target-change-sets', 'broken', 'manifest.json'), '{broken');

    await expect(manager().recoverPending()).rejects.toThrow('no valid manifest');
    expect(await readFile(join(target, 'existing.ts'), 'utf-8')).toContain('value = 1');
  });
});
