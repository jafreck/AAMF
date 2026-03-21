/**
 * @module core/symbol-mapper
 *
 * Maintains a source↔target symbol mapping table inside the target KB
 * SQLite database (`kb-target.db`).
 *
 * After each task commit + incremental target index update, the runtime
 * calls `updateMappingsForTask()` to match the task's source symbols
 * against the freshly-indexed target symbols and record the mapping.
 *
 * Agents query this mapping via `lookupBySource()` or `lookupByTask()`
 * to discover how dependency symbols were ported in earlier tasks.
 */

import type { Logger } from '../logging/logger.js';

export type MappingStatus = 'migrated' | 'parity-failed' | 'pending' | 'elided';

export interface SymbolMappingRow {
  source_symbol_name: string;
  source_symbol_kind: string;
  source_file: string;
  source_start_line: number;
  source_end_line: number;
  target_symbol_id: number | null;
  target_symbol_name: string | null;
  target_file: string | null;
  target_start_line: number | null;
  target_end_line: number | null;
  task_id: string;
  status: MappingStatus;
  mapped_at: string;
}

export interface TaskSymbol {
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
}

export class SymbolMapper {
  private readonly targetDbPath: string;
  private readonly logger: Logger;
  private initialized = false;

  constructor(targetDbPath: string, logger: Logger) {
    this.targetDbPath = targetDbPath;
    this.logger = logger;
  }

  /** Ensure the symbol_mapping table exists in the target DB. */
  async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    const lore = await import('@jafreck/lore');
    // Open read-write to create the table.
    const db = lore.openDb(this.targetDbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_mapping (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_symbol_name TEXT    NOT NULL,
          source_symbol_kind TEXT    NOT NULL,
          source_file        TEXT    NOT NULL,
          source_start_line  INTEGER NOT NULL,
          source_end_line    INTEGER NOT NULL,
          target_symbol_id   INTEGER,
          target_symbol_name TEXT,
          target_file        TEXT,
          target_start_line  INTEGER,
          target_end_line    INTEGER,
          task_id            TEXT    NOT NULL,
          status             TEXT    NOT NULL DEFAULT 'pending',
          mapped_at          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sm_source_name ON symbol_mapping(source_symbol_name);
        CREATE INDEX IF NOT EXISTS idx_sm_target_id   ON symbol_mapping(target_symbol_id);
        CREATE INDEX IF NOT EXISTS idx_sm_task        ON symbol_mapping(task_id);
        CREATE INDEX IF NOT EXISTS idx_sm_status      ON symbol_mapping(status);
      `);
      this.initialized = true;
    } finally {
      db.close();
    }
  }

  /**
   * After a task's code-migrator output has been committed and the target
   * index updated, match the task's source symbols against the target index
   * and record/update mappings.
   *
   * @param taskId       The migration task ID.
   * @param sourceSymbols  Symbols from the task definition.
   * @param targetFiles    Target file paths produced by this task.
   * @param status         Initial mapping status (default: 'migrated').
   */
  async updateMappingsForTask(
    taskId: string,
    sourceSymbols: TaskSymbol[],
    targetFiles: string[],
    status: MappingStatus = 'migrated',
  ): Promise<{ mapped: number; unmapped: number }> {
    if (sourceSymbols.length === 0) return { mapped: 0, unmapped: 0 };

    await this.ensureSchema();

    const lore = await import('@jafreck/lore');
    const db = lore.openDb(this.targetDbPath);
    const now = new Date().toISOString();

    try {
      // Remove previous mappings for this task (idempotent on retry).
      const deleteStmt = db.prepare('DELETE FROM symbol_mapping WHERE task_id = ?');
      deleteStmt.run(taskId);

      const insertStmt = db.prepare(`
        INSERT INTO symbol_mapping (
          source_symbol_name, source_symbol_kind, source_file,
          source_start_line, source_end_line,
          target_symbol_id, target_symbol_name, target_file,
          target_start_line, target_end_line,
          task_id, status, mapped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Build a set of target file paths for lookup scoping.
      const targetFileSet = new Set(targetFiles);

      // Query all target symbols once (cheaper than per-symbol lookups for small tasks).
      const allTargetSymbols = lore.listSymbols(db, { limit: 100_000 });
      const targetFileRows = lore.listFiles(db);
      const fileIdToPath = new Map<number, string>();
      for (const f of targetFileRows) fileIdToPath.set(f.id, f.path);

      // Index target symbols by name for fast matching.
      const targetByName = new Map<string, Array<{ id: number; name: string; kind: string; file: string; startLine: number; endLine: number }>>();
      for (const ts of allTargetSymbols) {
        const filePath = fileIdToPath.get(ts.file_id);
        if (!filePath) continue;
        const entry = { id: ts.id, name: ts.name, kind: ts.kind, file: filePath, startLine: ts.start_line, endLine: ts.end_line };
        const nameLower = ts.name.toLowerCase();
        if (!targetByName.has(nameLower)) targetByName.set(nameLower, []);
        targetByName.get(nameLower)!.push(entry);
      }

      let mapped = 0;
      let unmapped = 0;

      const insertAll = db.transaction(() => {
        for (const src of sourceSymbols) {
          const match = this.findBestMatch(src, targetByName, targetFileSet);
          if (match) {
            insertStmt.run(
              src.name, src.kind, src.file, src.startLine, src.endLine,
              match.id, match.name, match.file, match.startLine, match.endLine,
              taskId, status, now,
            );
            mapped++;
          } else {
            insertStmt.run(
              src.name, src.kind, src.file, src.startLine, src.endLine,
              null, null, null, null, null,
              taskId, status === 'migrated' ? 'pending' : status, now,
            );
            unmapped++;
          }
        }
      });
      insertAll();

      this.logger.debug(`Symbol mapping for ${taskId}: ${mapped} mapped, ${unmapped} unmapped`);
      return { mapped, unmapped };
    } finally {
      db.close();
    }
  }

  /**
   * Update the status of all mappings for a task (e.g. after parity failure).
   */
  async updateTaskStatus(taskId: string, status: MappingStatus): Promise<void> {
    await this.ensureSchema();
    const lore = await import('@jafreck/lore');
    const db = lore.openDb(this.targetDbPath);
    try {
      db.prepare('UPDATE symbol_mapping SET status = ?, mapped_at = ? WHERE task_id = ?')
        .run(status, new Date().toISOString(), taskId);
    } finally {
      db.close();
    }
  }

  /**
   * Look up target mappings for a given source symbol name.
   * Returns all mapping rows matching the source name.
   */
  async lookupBySource(sourceSymbolName: string): Promise<SymbolMappingRow[]> {
    await this.ensureSchema();
    const lore = await import('@jafreck/lore');
    const db = lore.openDb(this.targetDbPath);
    try {
      return db.prepare(
        'SELECT * FROM symbol_mapping WHERE source_symbol_name = ? ORDER BY mapped_at DESC',
      ).all(sourceSymbolName) as SymbolMappingRow[];
    } finally {
      db.close();
    }
  }

  /**
   * Look up all mappings produced by a given task.
   */
  async lookupByTask(taskId: string): Promise<SymbolMappingRow[]> {
    await this.ensureSchema();
    const lore = await import('@jafreck/lore');
    const db = lore.openDb(this.targetDbPath);
    try {
      return db.prepare(
        'SELECT * FROM symbol_mapping WHERE task_id = ? ORDER BY source_symbol_name',
      ).all(taskId) as SymbolMappingRow[];
    } finally {
      db.close();
    }
  }

  /**
   * Return mappings for all dependencies of a task.
   * Useful for telling agents "here's how your dependency symbols were ported."
   */
  async lookupDependencyMappings(dependencyTaskIds: string[]): Promise<SymbolMappingRow[]> {
    if (dependencyTaskIds.length === 0) return [];
    await this.ensureSchema();
    const lore = await import('@jafreck/lore');
    const db = lore.openDb(this.targetDbPath);
    try {
      const placeholders = dependencyTaskIds.map(() => '?').join(',');
      return db.prepare(
        `SELECT * FROM symbol_mapping WHERE task_id IN (${placeholders}) AND status = 'migrated' ORDER BY task_id, source_symbol_name`,
      ).all(...dependencyTaskIds) as SymbolMappingRow[];
    } finally {
      db.close();
    }
  }

  /**
   * Find the best matching target symbol for a source symbol.
   *
   * Matching strategy:
   * 1. Exact name match in the task's target files (strongest).
   * 2. Case-insensitive name match in target files.
   * 3. Case-insensitive name match anywhere in the target index.
   * 4. Common C→Rust naming transforms (UPPER_CASE → snake_case, etc.).
   */
  private findBestMatch(
    source: TaskSymbol,
    targetByName: Map<string, Array<{ id: number; name: string; kind: string; file: string; startLine: number; endLine: number }>>,
    targetFileSet: Set<string>,
  ): { id: number; name: string; file: string; startLine: number; endLine: number } | null {
    const nameLower = source.name.toLowerCase();

    // 1. Exact name match in target files.
    const exactCandidates = targetByName.get(nameLower);
    if (exactCandidates) {
      const inTargetFile = exactCandidates.find(c => targetFileSet.has(c.file));
      if (inTargetFile) return inTargetFile;
      // Exact name match in any target file.
      const first = exactCandidates[0];
      if (first) return first;
    }

    // 2. C→Rust naming transforms: UPPER_SNAKE → lower_snake.
    const snakeName = this.toSnakeCase(source.name).toLowerCase();
    if (snakeName !== nameLower) {
      const snakeCandidates = targetByName.get(snakeName);
      if (snakeCandidates) {
        const inTargetFile = snakeCandidates.find(c => targetFileSet.has(c.file));
        if (inTargetFile) return inTargetFile;
        const first = snakeCandidates[0];
        if (first) return first;
      }
    }

    // 3. Strip common prefixes (e.g., ZSTD_, HUF_, FSE_).
    const stripped = source.name.replace(/^[A-Z]+_/, '');
    if (stripped !== source.name) {
      const strippedLower = stripped.toLowerCase();
      const strippedCandidates = targetByName.get(strippedLower);
      if (strippedCandidates) {
        const inTargetFile = strippedCandidates.find(c => targetFileSet.has(c.file));
        if (inTargetFile) return inTargetFile;
      }
      // Also try snake_case of stripped name.
      const strippedSnake = this.toSnakeCase(stripped).toLowerCase();
      if (strippedSnake !== strippedLower) {
        const strippedSnakeCandidates = targetByName.get(strippedSnake);
        if (strippedSnakeCandidates) {
          const inTargetFile = strippedSnakeCandidates.find(c => targetFileSet.has(c.file));
          if (inTargetFile) return inTargetFile;
        }
      }
    }

    return null;
  }

  /** Convert a C-style name to snake_case. */
  private toSnakeCase(name: string): string {
    // Handle UPPER_SNAKE_CASE → upper_snake_case
    if (name === name.toUpperCase() && name.includes('_')) {
      return name.toLowerCase();
    }
    // Handle PascalCase / camelCase → snake_case
    return name
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
  }
}
