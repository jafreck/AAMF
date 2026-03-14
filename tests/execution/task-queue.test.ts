import { describe, it, expect } from 'vitest';
import { TaskQueue } from '../../src/execution/task-queue.js';
import { MigrationTask } from '../../src/agents/types.js';

function makeTask(id: string, deps: string[] = []): MigrationTask {
  return {
    id,
    name: `Task ${id}`,
    sourceFiles: [`src/${id}.py`],
    targetFiles: [`src/${id}.ts`],
    knowledgeBaseRef: `kb/${id}.md`,
    dependencies: deps,
    complexity: 'moderate',
    description: `Migrate ${id}`,
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
  };
}

describe('TaskQueue', () => {
  it('should return tasks with no dependencies as ready', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b'), makeTask('c', ['a'])]);
    const ready = queue.getReady();
    expect(ready.map(t => t.id)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(ready.map(t => t.id)).not.toContain('c');
  });

  it('should release dependent tasks after completion', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b', ['a'])]);
    expect(queue.getReady().map(t => t.id)).toEqual(['a']);
    
    queue.complete('a');
    expect(queue.getReady().map(t => t.id)).toEqual(['b']);
  });

  it('should mark queue as complete when all done', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b')]);
    expect(queue.isComplete()).toBe(false);
    queue.complete('a');
    expect(queue.isComplete()).toBe(false);
    queue.complete('b');
    expect(queue.isComplete()).toBe(true);
  });

  it('should not release dependent tasks when an upstream dependency is blocked', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b', ['a'])]);
    queue.markBlocked('a');

    const ready = queue.getReady();
    expect(ready).toEqual([]);
  });

  it('should report correct progress', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b'), makeTask('c')]);
    queue.complete('a');
    queue.markBlocked('b');
    
    const progress = queue.getProgress();
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
    expect(progress.blocked).toBe(1);
    expect(progress.remaining).toBe(1);
  });

  it('should report completion and blocked state for individual tasks', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b')]);
    queue.complete('a');
    queue.markBlocked('b');

    expect(queue.isTaskCompleted('a')).toBe(true);
    expect(queue.isTaskCompleted('b')).toBe(false);
    expect(queue.isTaskBlocked('b')).toBe(true);
    expect(queue.isTaskBlocked('a')).toBe(false);
  });

  it('should skip already completed tasks from checkpoint', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b'), makeTask('c')]);
    queue.markCompleted(['a', 'b']);
    
    expect(queue.getReady().map(t => t.id)).toEqual(['c']);
  });
});

describe('TaskQueue.topologicalSort', () => {
  it('should sort tasks respecting dependencies', () => {
    const tasks = [makeTask('c', ['b']), makeTask('a'), makeTask('b', ['a'])];
    const sorted = TaskQueue.topologicalSort(tasks);
    
    const ids = sorted.map(t => t.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('should detect circular dependencies', () => {
    const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];
    expect(() => TaskQueue.topologicalSort(tasks)).toThrow(/[Cc]ircular/);
  });

  it('should handle tasks with no dependencies', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const sorted = TaskQueue.topologicalSort(tasks);
    expect(sorted).toHaveLength(3);
  });
});

describe('TaskQueue.selectNonOverlappingBatch', () => {
  it('should skip tasks that overlap target files', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/shared.ts'] },
      { ...makeTask('b'), targetFiles: ['src/shared.ts'] },
      { ...makeTask('c'), targetFiles: ['lib/unique.ts'] },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a', 'c']);
  });

  it('should allow tasks in the same directory with different files', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/one.ts'] },
      { ...makeTask('b'), targetFiles: ['src/two.ts'] },
      { ...makeTask('c'), targetFiles: ['lib/three.ts'] },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('TaskQueue.executePipelined', () => {
  it('should execute all tasks respecting concurrency limit', async () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['a.ts'] },
      { ...makeTask('b'), targetFiles: ['b.ts'] },
      { ...makeTask('c'), targetFiles: ['c.ts'] },
      { ...makeTask('d'), targetFiles: ['d.ts'] },
    ];

    let maxConcurrent = 0;
    let current = 0;
    const results = await TaskQueue.executePipelined(tasks, 2, async (task) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return task.id;
    });

    expect(results.map(r => r.result).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should serialize tasks that share a target file', async () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['shared.ts'] },
      { ...makeTask('b'), targetFiles: ['shared.ts'] },
    ];

    let maxConcurrent = 0;
    let current = 0;
    const order: string[] = [];
    await TaskQueue.executePipelined(tasks, 4, async (task) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      order.push(task.id);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return task.id;
    });

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(['a', 'b']);
  });

  it('should pipeline tasks with different files in the same directory', async () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/one.ts'] },
      { ...makeTask('b'), targetFiles: ['src/two.ts'] },
    ];

    let maxConcurrent = 0;
    let current = 0;
    await TaskQueue.executePipelined(tasks, 4, async (task) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, 20));
      current--;
      return task.id;
    });

    expect(maxConcurrent).toBe(2);
  });

  it('should propagate executor errors', async () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['a.ts'] },
      { ...makeTask('b'), targetFiles: ['b.ts'] },
    ];

    await expect(
      TaskQueue.executePipelined(tasks, 2, async (task) => {
        if (task.id === 'a') throw new Error('boom');
        return task.id;
      }),
    ).rejects.toThrow('boom');
  });
});
