/**
 * @module indexer/call-graph
 *
 * Call-graph utilities operating on the SQLite knowledge-base:
 *
 *  - `buildCallGraph(db)` — resolves raw callee names in `symbol_refs` to
 *    concrete symbol IDs where possible.
 *  - `topoSort(db)` — topological ordering of files based on `file_imports`
 *    using Kahn's algorithm.
 *  - `detectCycles(db)` — cycle detection over the `file_imports` graph using
 *    Tarjan's strongly-connected-components algorithm.
 */

import type { Database } from './db.js';

// ─── buildCallGraph ───────────────────────────────────────────────────────────

/**
 * Resolves unresolved `symbol_refs` rows by looking up `callee_name` in the
 * `symbols` table and writing the matching `callee_id` back.
 *
 * Only exact-name matches within the same DB are performed; cross-file
 * disambiguation is not attempted here.
 */
export function buildCallGraph(db: Database.Database): void {
  // Build a map: symbol name → symbol id (last one wins for duplicates)
  const nameToId = new Map<string, number>();
  const allSymbols = db
    .prepare('SELECT id, name FROM symbols')
    .all() as Array<{ id: number; name: string }>;
  for (const row of allSymbols) {
    nameToId.set(row.name, row.id);
  }

  // Fetch all unresolved refs
  const unresolved = db
    .prepare('SELECT id, callee_name FROM symbol_refs WHERE callee_id IS NULL')
    .all() as Array<{ id: number; callee_name: string }>;

  const update = db.prepare('UPDATE symbol_refs SET callee_id = ? WHERE id = ?');

  const updateMany = db.transaction(() => {
    for (const ref of unresolved) {
      const calleeId = nameToId.get(ref.callee_name);
      if (calleeId !== undefined) {
        update.run(calleeId, ref.id);
      }
    }
  });

  updateMany();
}

// ─── topoSort ─────────────────────────────────────────────────────────────────

/**
 * Returns file IDs in topologically sorted order (dependencies before
 * dependents) using Kahn's algorithm over the `file_imports` graph.
 *
 * Files that are part of a cycle are excluded from the returned list (they
 * have no valid topological position).  Use `detectCycles()` to identify them.
 */
export function topoSort(db: Database.Database): string[] {
  // Build adjacency: importer → set of importees (edges point from user to dep)
  // For topological sort we need: dep comes before user, so reverse edges.
  // adjacency[dep] → [users]
  // in-degree[user] = number of deps it imports

  const allFiles = db
    .prepare('SELECT id FROM files')
    .all() as Array<{ id: number }>;

  const fileIds = allFiles.map(r => String(r.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → users

  for (const id of fileIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  const edges = db
    .prepare(
      `SELECT fi.file_id AS importer, fi.resolved_id AS dep
       FROM file_imports fi
       WHERE fi.resolved_id IS NOT NULL`,
    )
    .all() as Array<{ importer: number; dep: number }>;

  for (const { importer, dep } of edges) {
    const importerStr = String(importer);
    const depStr = String(dep);

    if (!inDegree.has(importerStr) || !inDegree.has(depStr)) continue;

    // importer has one more dependency
    inDegree.set(importerStr, (inDegree.get(importerStr) ?? 0) + 1);
    dependents.get(depStr)!.push(importerStr);
  }

  // Queue all nodes with in-degree 0 (no dependencies)
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    for (const dependent of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        queue.push(dependent);
      }
    }
  }

  return sorted;
}

// ─── detectCycles ─────────────────────────────────────────────────────────────

/**
 * Detects cycles in the `file_imports` graph using Tarjan's
 * strongly-connected-components (SCC) algorithm.
 *
 * Returns an array of SCCs where each SCC has more than one node (or a
 * single node with a self-loop).  Each SCC is represented as an array of
 * file IDs (as strings).
 */
export function detectCycles(db: Database.Database): string[][] {
  const allFiles = db
    .prepare('SELECT id FROM files')
    .all() as Array<{ id: number }>;

  // Build adjacency list: importer → [dep, ...]
  const adjacency = new Map<string, string[]>();
  for (const { id } of allFiles) {
    adjacency.set(String(id), []);
  }

  const edges = db
    .prepare(
      `SELECT fi.file_id AS importer, fi.resolved_id AS dep
       FROM file_imports fi
       WHERE fi.resolved_id IS NOT NULL`,
    )
    .all() as Array<{ importer: number; dep: number }>;

  for (const { importer, dep } of edges) {
    const imp = String(importer);
    const d = String(dep);
    if (adjacency.has(imp)) {
      adjacency.get(imp)!.push(d);
    }
  }

  // Tarjan's SCC
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);

      // Self-loops: check if any node in the scc has an edge to itself
      if (scc.length > 1) {
        sccs.push(scc);
      } else {
        // Single-node SCC — only a cycle if there's a self-loop
        const selfLoop = (adjacency.get(scc[0]!) ?? []).includes(scc[0]!);
        if (selfLoop) sccs.push(scc);
      }
    }
  }

  for (const { id } of allFiles) {
    const v = String(id);
    if (!indices.has(v)) {
      strongConnect(v);
    }
  }

  return sccs;
}
