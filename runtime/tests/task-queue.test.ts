import { describe, it, expect } from 'vitest';
import { TaskQueue } from '../src/execution/task-queue.js';
import { MigrationTask } from '../src/agents/types.js';

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

  it('should skip tasks that overlap target directories', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/one.ts'] },
      { ...makeTask('b'), targetFiles: ['src/two.ts'] },
      { ...makeTask('c'), targetFiles: ['lib/three.ts'] },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a', 'c']);
  });

  it('should allow concurrent tasks with distinct writeRegions on the same file', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/codec.rs'], writeRegion: 'types' },
      { ...makeTask('b'), targetFiles: ['src/codec.rs'], writeRegion: 'compress' },
      { ...makeTask('c'), targetFiles: ['src/codec.rs'], writeRegion: 'decompress' },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('should block tasks with duplicate writeRegions on the same file', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/codec.rs'], writeRegion: 'types' },
      { ...makeTask('b'), targetFiles: ['src/codec.rs'], writeRegion: 'types' },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a']);
  });

  it('should block when mixing region and non-region tasks on the same file', () => {
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/codec.rs'], writeRegion: 'types' },
      { ...makeTask('b'), targetFiles: ['src/codec.rs'] }, // no writeRegion
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a']);
  });

  it('should not apply directory overlap check for writeRegion tasks', () => {
    // Both target files in src/ dir, but with distinct regions — should be allowed
    const tasks = [
      { ...makeTask('a'), targetFiles: ['src/codec.rs'], writeRegion: 'types' },
      { ...makeTask('b'), targetFiles: ['src/codec.rs'], writeRegion: 'impl' },
    ];

    const batch = TaskQueue.selectNonOverlappingBatch(tasks, 3);
    expect(batch.map(t => t.id)).toEqual(['a', 'b']);
  });
});

describe('TaskQueue group barrier', () => {
  it('should hold back tasks from later groups until earlier groups settle', () => {
    // Three tasks, no intra-task dependencies, across two groups
    const tasks = [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')];
    const queue = new TaskQueue(tasks);
    queue.setGroupBarrier({
      taskToGroupIndex: new Map([['task-1', 0], ['task-2', 0], ['task-3', 1]]),
      groupCount: 2,
    });

    // Only group 0 tasks should be ready
    expect(queue.getReady().map(t => t.id).sort()).toEqual(['task-1', 'task-2']);

    // After completing group 0, group 1 becomes ready
    queue.complete('task-1');
    queue.complete('task-2');
    expect(queue.getReady().map(t => t.id)).toEqual(['task-3']);
  });

  it('should allow later group tasks when earlier group tasks are blocked', () => {
    const tasks = [makeTask('task-1'), makeTask('task-2')];
    const queue = new TaskQueue(tasks);
    queue.setGroupBarrier({
      taskToGroupIndex: new Map([['task-1', 0], ['task-2', 1]]),
      groupCount: 2,
    });

    // Block the only group-0 task — group 1 should become unblocked
    queue.markBlocked('task-1');
    expect(queue.getReady().map(t => t.id)).toEqual(['task-2']);
  });

  it('should respect both dependencies and group barriers', () => {
    // task-2 depends on task-1, both in group 0; task-3 in group 1
    const tasks = [makeTask('task-1'), makeTask('task-2', ['task-1']), makeTask('task-3')];
    const queue = new TaskQueue(tasks);
    queue.setGroupBarrier({
      taskToGroupIndex: new Map([['task-1', 0], ['task-2', 0], ['task-3', 1]]),
      groupCount: 2,
    });

    // Only task-1 ready (task-2 blocked by dep, task-3 blocked by group)
    expect(queue.getReady().map(t => t.id)).toEqual(['task-1']);

    queue.complete('task-1');
    // Now task-2 ready (dep satisfied); task-3 still blocked by group
    expect(queue.getReady().map(t => t.id)).toEqual(['task-2']);

    queue.complete('task-2');
    // Group 0 complete — task-3 now ready
    expect(queue.getReady().map(t => t.id)).toEqual(['task-3']);
  });

  it('should handle three groups sequentially', () => {
    const tasks = [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')];
    const queue = new TaskQueue(tasks);
    queue.setGroupBarrier({
      taskToGroupIndex: new Map([['task-1', 0], ['task-2', 1], ['task-3', 2]]),
      groupCount: 3,
    });

    expect(queue.getReady().map(t => t.id)).toEqual(['task-1']);
    queue.complete('task-1');
    expect(queue.getReady().map(t => t.id)).toEqual(['task-2']);
    queue.complete('task-2');
    expect(queue.getReady().map(t => t.id)).toEqual(['task-3']);
  });

  it('should release all tasks when no group barrier is set', () => {
    const tasks = [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')];
    const queue = new TaskQueue(tasks);
    // No setGroupBarrier call — all independent tasks should be ready
    expect(queue.getReady().map(t => t.id).sort()).toEqual(['task-1', 'task-2', 'task-3']);
  });
});
