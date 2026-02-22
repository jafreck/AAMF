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

  it('should handle blocked tasks', () => {
    const queue = new TaskQueue([makeTask('a'), makeTask('b', ['a'])]);
    queue.markBlocked('a');
    
    // b should become ready since blocked deps count as resolved
    const ready = queue.getReady();
    expect(ready.map(t => t.id)).toEqual(['b']);
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
