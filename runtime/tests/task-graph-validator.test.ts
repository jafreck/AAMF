import { describe, it, expect } from 'vitest';
import { validateTaskGraph, type TaskGraphIssue } from '../src/core/task-graph-validator.js';
import { MigrationTask } from '../src/agents/types.js';

function makeTask(
  id: string,
  overrides: Partial<MigrationTask> = {},
): MigrationTask {
  return {
    id,
    name: `Task ${id}`,
    sourceFiles: [`src/${id}.c`],
    targetFiles: [`src/${id}.rs`],
    knowledgeBaseRef: `kb/${id}.md`,
    dependencies: [],
    complexity: 'moderate',
    description: `Migrate ${id}`,
    acceptanceCriteria: ['works'],
    parityChecks: ['matches'],
    lineRange: { start: 1, end: 100 },
    ...overrides,
  };
}

function errorCodes(issues: TaskGraphIssue[]): string[] {
  return issues.filter(i => i.severity === 'error').map(i => i.code);
}

function warningCodes(issues: TaskGraphIssue[]): string[] {
  return issues.filter(i => i.severity === 'warning').map(i => i.code);
}

describe('validateTaskGraph', () => {
  it('should return no issues for a valid task graph', () => {
    const tasks = [
      makeTask('task-1'),
      makeTask('task-2', { dependencies: ['task-1'] }),
    ];
    const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 0 }, 1);
    expect(issues).toHaveLength(0);
  });

  it('should detect duplicate task IDs', () => {
    const tasks = [makeTask('task-1'), makeTask('task-1')];
    const issues = validateTaskGraph(tasks, { 'task-1': 0 }, 1);
    expect(errorCodes(issues)).toContain('duplicate-task-id');
  });

  it('should detect orphan dependencies', () => {
    const tasks = [makeTask('task-1', { dependencies: ['task-999'] })];
    const issues = validateTaskGraph(tasks, { 'task-1': 0 }, 1);
    expect(errorCodes(issues)).toContain('orphan-dependency');
  });

  it('should detect cross-group forward references', () => {
    // task-1 is in group 0 and reads a file that task-2 in group 1 produces
    const tasks = [
      makeTask('task-1', { sourceFiles: ['src/output.rs'] }),
      makeTask('task-2', { targetFiles: ['src/output.rs'] }),
    ];
    const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 1 }, 2);
    expect(errorCodes(issues)).toContain('cross-group-forward-ref');
  });

  it('should not flag same-group file dependencies as forward references', () => {
    const tasks = [
      makeTask('task-1', { sourceFiles: ['src/output.rs'], dependencies: ['task-2'] }),
      makeTask('task-2', { targetFiles: ['src/output.rs'] }),
    ];
    // Both in group 0 — not a forward ref
    const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 0 }, 1);
    expect(errorCodes(issues)).not.toContain('cross-group-forward-ref');
  });

  it('should warn about missing intra-group dependencies when tasks share files', () => {
    // task-1 reads a file that task-2 writes, same group, no dep declared
    const tasks = [
      makeTask('task-1', { sourceFiles: ['src/shared.rs'] }),
      makeTask('task-2', { targetFiles: ['src/shared.rs'] }),
    ];
    const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 0 }, 1);
    expect(warningCodes(issues)).toContain('missing-intra-group-dep');
  });

  it('should not warn about intra-group deps when dependency path exists', () => {
    const tasks = [
      makeTask('task-1', { sourceFiles: ['src/shared.rs'], dependencies: ['task-2'] }),
      makeTask('task-2', { targetFiles: ['src/shared.rs'] }),
    ];
    const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 0 }, 1);
    expect(warningCodes(issues)).not.toContain('missing-intra-group-dep');
  });
});
