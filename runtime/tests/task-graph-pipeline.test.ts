/**
 * Integration tests for the complete task-graph pipeline:
 *   validation → SCC detection → group barrier → scheduling
 *
 * These tests simulate realistic multi-group migration scenarios
 * without launching any agents (zero cost, fully deterministic).
 */
import { describe, it, expect } from 'vitest';
import { validateTaskGraph } from '../src/core/task-graph-validator.js';
import { TaskQueue } from '../src/execution/task-queue.js';
import type { MigrationTask } from '../src/agents/types.js';

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

describe('Task graph pipeline integration', () => {
  describe('multi-group sequential execution with group barriers', () => {
    it('should enforce foundation→compression→downstream ordering', () => {
      // Simulate the zstd group structure:
      // Group 0: foundation (types, constants)
      // Group 1: compression (uses foundation types)
      // Group 2: downstream (uses compression APIs)
      const tasks = [
        makeTask('task-1', { name: 'foundation types' }),
        makeTask('task-2', { name: 'foundation constants', dependencies: ['task-1'] }),
        makeTask('task-3', { name: 'compress engine' }),
        makeTask('task-4', { name: 'decompress engine' }),
        makeTask('task-5', { name: 'example binary' }),
        makeTask('task-6', { name: 'contrib tool', dependencies: ['task-5'] }),
      ];
      const taskGroupMap: Record<string, number> = {
        'task-1': 0, 'task-2': 0,  // foundation
        'task-3': 1, 'task-4': 1,  // compression
        'task-5': 2, 'task-6': 2,  // downstream
      };

      // Validation should pass (no cross-group forward refs)
      const issues = validateTaskGraph(tasks, taskGroupMap, 3);
      expect(issues.filter(i => i.severity === 'error')).toHaveLength(0);

      // Sort and build queue
      const { sorted, sccs } = TaskQueue.topologicalSortWithSCCs(tasks);
      expect(sccs).toHaveLength(0); // no cycles

      const queue = new TaskQueue(sorted);
      queue.setGroupBarrier({
        taskToGroupIndex: new Map(Object.entries(taskGroupMap)),
        groupCount: 3,
      });

      // Step 1: only group 0 tasks should be ready
      const ready1 = queue.getReady().map(t => t.id).sort();
      expect(ready1).toEqual(['task-1']); // task-2 depends on task-1

      // Complete task-1, task-2 becomes ready (still group 0)
      queue.complete('task-1');
      expect(queue.getReady().map(t => t.id)).toEqual(['task-2']);

      // Complete task-2, group 0 done → group 1 tasks become ready
      queue.complete('task-2');
      const ready3 = queue.getReady().map(t => t.id).sort();
      expect(ready3).toEqual(['task-3', 'task-4']); // both independent in group 1

      // Complete group 1 → group 2 opens
      queue.complete('task-3');
      queue.complete('task-4');
      expect(queue.getReady().map(t => t.id)).toEqual(['task-5']);

      queue.complete('task-5');
      expect(queue.getReady().map(t => t.id)).toEqual(['task-6']);

      queue.complete('task-6');
      expect(queue.isComplete()).toBe(true);
    });
  });

  describe('SCC two-pass scheduling with realistic cycles', () => {
    it('should handle parser↔lexer↔ast mutual dependency cycle', () => {
      // Classic pattern: parser imports ast types, ast imports lexer types,
      // lexer imports parser types
      const tasks = [
        makeTask('task-1', {
          name: 'parser',
          dependencies: ['task-3'], // depends on ast types
          sourceFiles: ['src/parser.c'],
          targetFiles: ['src/parser.rs'],
        }),
        makeTask('task-2', {
          name: 'lexer',
          dependencies: ['task-1'], // depends on parser types
          sourceFiles: ['src/lexer.c'],
          targetFiles: ['src/lexer.rs'],
        }),
        makeTask('task-3', {
          name: 'ast',
          dependencies: ['task-2'], // depends on lexer types
          sourceFiles: ['src/ast.c'],
          targetFiles: ['src/ast.rs'],
        }),
        makeTask('task-4', {
          name: 'main',
          dependencies: ['task-1', 'task-2', 'task-3'], // depends on all three
          sourceFiles: ['src/main.c'],
          targetFiles: ['src/main.rs'],
        }),
      ];

      // Should NOT throw — uses SCC condensation
      const { sorted, sccs } = TaskQueue.topologicalSortWithSCCs(tasks);
      expect(sorted).toHaveLength(4);

      // One SCC with the three cyclic tasks
      expect(sccs).toHaveLength(1);
      expect(sccs[0].members.sort()).toEqual(['task-1', 'task-2', 'task-3']);

      // Build queue with SCC info
      const queue = new TaskQueue(sorted);
      queue.setSCCs(sccs);

      // All SCC members should be ready (internal deps are waived)
      const ready = queue.getReady().map(t => t.id).sort();
      expect(ready).toEqual(['task-1', 'task-2', 'task-3']);

      // task-4 should NOT be ready (depends on SCC members)
      expect(ready).not.toContain('task-4');

      // Verify SCC phase tracking
      expect(queue.getSCCPhase('task-1')).toBe('scaffold');
      expect(queue.getSCCPhase('task-4')).toBeUndefined(); // not in SCC

      // Simulate scaffold pass completion
      queue.markSCCScaffoldDone(sccs[0].id);
      expect(queue.getSCCPhase('task-1')).toBe('implement');

      // After completing all SCC members, task-4 becomes ready
      queue.complete('task-1');
      queue.complete('task-2');
      queue.complete('task-3');
      expect(queue.getReady().map(t => t.id)).toEqual(['task-4']);

      queue.complete('task-4');
      expect(queue.isComplete()).toBe(true);
    });

    it('should handle two independent SCCs with an ordering edge between them', () => {
      // SCC-A: task-1 ↔ task-2
      // SCC-B: task-3 ↔ task-4
      // SCC-B depends on SCC-A (task-3 depends on task-1)
      const tasks = [
        makeTask('task-1', { dependencies: ['task-2'] }),
        makeTask('task-2', { dependencies: ['task-1'] }),
        makeTask('task-3', { dependencies: ['task-4', 'task-1'] }),
        makeTask('task-4', { dependencies: ['task-3'] }),
      ];

      const { sorted, sccs } = TaskQueue.topologicalSortWithSCCs(tasks);
      expect(sccs).toHaveLength(2);

      const queue = new TaskQueue(sorted);
      queue.setSCCs(sccs);

      // SCC-A should be ready (no external deps), SCC-B should not (depends on task-1)
      const ready = queue.getReady().map(t => t.id).sort();
      expect(ready).toEqual(['task-1', 'task-2']);
      expect(ready).not.toContain('task-3');
      expect(ready).not.toContain('task-4');

      // Complete SCC-A → SCC-B becomes ready
      queue.complete('task-1');
      queue.complete('task-2');
      const ready2 = queue.getReady().map(t => t.id).sort();
      expect(ready2).toEqual(['task-3', 'task-4']);
    });
  });

  describe('SCC + group barriers combined', () => {
    it('should apply both SCC and group barrier constraints', () => {
      // Group 0: task-1 (foundation, no deps)
      // Group 1: task-2 ↔ task-3 (SCC), both depend on task-1 externally
      const tasks = [
        makeTask('task-1'),
        makeTask('task-2', { dependencies: ['task-3', 'task-1'] }),
        makeTask('task-3', { dependencies: ['task-2', 'task-1'] }),
      ];
      const taskGroupMap: Record<string, number> = {
        'task-1': 0,
        'task-2': 1,
        'task-3': 1,
      };

      const { sorted, sccs } = TaskQueue.topologicalSortWithSCCs(tasks);
      expect(sccs).toHaveLength(1);

      const queue = new TaskQueue(sorted);
      queue.setSCCs(sccs);
      queue.setGroupBarrier({
        taskToGroupIndex: new Map(Object.entries(taskGroupMap)),
        groupCount: 2,
      });

      // Only group 0 should be ready (group barrier)
      expect(queue.getReady().map(t => t.id)).toEqual(['task-1']);

      // Complete group 0 → group 1 SCC becomes ready
      queue.complete('task-1');
      const ready = queue.getReady().map(t => t.id).sort();
      expect(ready).toEqual(['task-2', 'task-3']); // SCC members both ready
    });
  });

  describe('validation catches planner errors before execution', () => {
    it('should detect reversed group ordering (downstream before foundation)', () => {
      // group 0 = downstream, group 1 = foundation (wrong order)
      // downstream reads foundation's output file
      const tasks = [
        makeTask('task-1', {
          name: 'downstream example',
          sourceFiles: ['src/types.rs'], // reads what foundation produces
        }),
        makeTask('task-2', {
          name: 'foundation types',
          targetFiles: ['src/types.rs'], // produces this file
        }),
      ];
      const issues = validateTaskGraph(
        tasks,
        { 'task-1': 0, 'task-2': 1 }, // task-1 in group 0, task-2 in group 1
        2,
      );
      expect(issues.filter(i => i.code === 'cross-group-forward-ref')).toHaveLength(1);
    });

    it('should detect orphan dependencies that would cause deadlocks', () => {
      const tasks = [
        makeTask('task-1', { dependencies: ['task-99'] }),
        makeTask('task-2', { dependencies: ['task-1'] }),
      ];
      const issues = validateTaskGraph(tasks, { 'task-1': 0, 'task-2': 0 }, 1);
      expect(issues.filter(i => i.code === 'orphan-dependency')).toHaveLength(1);
      // Verify the orphan reference is identified
      const orphan = issues.find(i => i.code === 'orphan-dependency')!;
      expect(orphan.relatedTaskId).toBe('task-99');
    });

    it('should pass validation for a well-formed multi-group plan', () => {
      const tasks = [
        makeTask('task-1', { targetFiles: ['src/types.rs'] }),
        makeTask('task-2', { dependencies: ['task-1'], sourceFiles: ['src/types.rs'], targetFiles: ['src/codec.rs'] }),
        makeTask('task-3', { sourceFiles: ['src/codec.rs'], targetFiles: ['src/main.rs'] }),
      ];
      const issues = validateTaskGraph(
        tasks,
        { 'task-1': 0, 'task-2': 1, 'task-3': 2 },
        3,
      );
      expect(issues.filter(i => i.severity === 'error')).toHaveLength(0);
    });
  });

  describe('blocked task propagation with group barriers', () => {
    it('should unblock later groups when earlier group tasks are blocked', () => {
      const tasks = [
        makeTask('task-1'),
        makeTask('task-2'),
      ];
      const queue = new TaskQueue(tasks);
      queue.setGroupBarrier({
        taskToGroupIndex: new Map([['task-1', 0], ['task-2', 1]]),
        groupCount: 2,
      });

      expect(queue.getReady().map(t => t.id)).toEqual(['task-1']);

      // Block task-1 (simulates max retries exceeded)
      queue.markBlocked('task-1');

      // Group 0 is settled (all blocked) → group 1 should open
      expect(queue.getReady().map(t => t.id)).toEqual(['task-2']);
    });

    it('should handle mixed completion and blocking within a group', () => {
      const tasks = [
        makeTask('task-1'),
        makeTask('task-2'),
        makeTask('task-3'),
      ];
      const queue = new TaskQueue(tasks);
      queue.setGroupBarrier({
        taskToGroupIndex: new Map([['task-1', 0], ['task-2', 0], ['task-3', 1]]),
        groupCount: 2,
      });

      // Both group 0 tasks ready
      expect(queue.getReady().map(t => t.id).sort()).toEqual(['task-1', 'task-2']);

      // Complete one, block one
      queue.complete('task-1');
      queue.markBlocked('task-2');

      // Group 0 is fully settled → group 1 ready
      expect(queue.getReady().map(t => t.id)).toEqual(['task-3']);
    });
  });

  describe('realistic zstd-like task structure', () => {
    it('should correctly schedule 10 groups with intra-group dependencies', () => {
      // Simulate a simplified zstd plan with 10 groups, 2 tasks each
      const tasks: MigrationTask[] = [];
      const taskGroupMap: Record<string, number> = {};

      for (let g = 0; g < 10; g++) {
        const t1 = `task-${g * 2 + 1}`;
        const t2 = `task-${g * 2 + 2}`;
        tasks.push(makeTask(t1));
        tasks.push(makeTask(t2, { dependencies: [t1] }));
        taskGroupMap[t1] = g;
        taskGroupMap[t2] = g;
      }

      // Validation should pass
      const issues = validateTaskGraph(tasks, taskGroupMap, 10);
      expect(issues.filter(i => i.severity === 'error')).toHaveLength(0);

      // Sort and schedule
      const { sorted, sccs } = TaskQueue.topologicalSortWithSCCs(tasks);
      expect(sccs).toHaveLength(0);

      const queue = new TaskQueue(sorted);
      queue.setGroupBarrier({
        taskToGroupIndex: new Map(Object.entries(taskGroupMap)),
        groupCount: 10,
      });

      // Execute all groups in order
      for (let g = 0; g < 10; g++) {
        const t1 = `task-${g * 2 + 1}`;
        const t2 = `task-${g * 2 + 2}`;

        // First task in group should be ready (no deps except possibly second task's dep)
        const ready = queue.getReady();
        expect(ready.map(t => t.id)).toContain(t1);
        expect(ready.map(t => t.id)).not.toContain(t2); // depends on t1

        queue.complete(t1);
        expect(queue.getReady().map(t => t.id)).toContain(t2);

        queue.complete(t2);
      }

      expect(queue.isComplete()).toBe(true);
    });
  });
});
