/**
 * @module indexer/index
 *
 * The `IndexBuilder` class orchestrates the full indexing pipeline:
 *   walk → parse → extract → resolve → persist
 *
 * It also supports incremental updates (`update()`) and a stub for
 * LLM-summary ingestion (`ingestSummary()`).
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { openDb } from './db.js';
import type { Database } from './db.js';
import { walkFiles } from './walker.js';
import type { WalkerConfig } from './walker.js';
import { ParserPool } from './parser.js';
import { ImportResolver } from './resolver.js';
import type { ExtractionResult, RawCallRef, RawImport, RawSymbol } from './extractors/types.js';
import { CExtractor } from './extractors/c.js';
import { RustExtractor } from './extractors/rust.js';
import { PythonExtractor } from './extractors/python.js';
import { CppExtractor } from './extractors/cpp.js';
import { TypeScriptExtractor } from './extractors/typescript.js';
import { JavaScriptExtractor } from './extractors/javascript.js';
import { GoExtractor } from './extractors/go.js';
import { JavaExtractor } from './extractors/java.js';
import { CSharpExtractor } from './extractors/csharp.js';
import type { SymbolExtractor } from './extractors/types.js';

// ─── Extractor registry ───────────────────────────────────────────────────────

const EXTRACTORS: Record<string, SymbolExtractor> = {
  c:          new CExtractor(),
  rust:       new RustExtractor(),
  python:     new PythonExtractor(),
  cpp:        new CppExtractor(),
  typescript: new TypeScriptExtractor(),
  javascript: new JavaScriptExtractor(),
  go:         new GoExtractor(),
  java:       new JavaExtractor(),
  csharp:     new CSharpExtractor(),
};

// ─── Prepared statement types ─────────────────────────────────────────────────

interface FileRow {
  id: number;
  last_hash: string | null;
}

// ─── IndexBuilder ─────────────────────────────────────────────────────────────

/**
 * Orchestrates the full M1 indexing pipeline.
 *
 * @example
 * ```ts
 * const builder = new IndexBuilder('/path/to/kb.db', { rootDir: '/path/to/src' });
 * await builder.build();
 * ```
 */
export class IndexBuilder {
  private readonly dbPath: string;
  private readonly walkerConfig: WalkerConfig;
  private readonly pool: ParserPool;
  private readonly resolver: ImportResolver;

  constructor(dbPath: string, walkerConfig: WalkerConfig) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.pool = new ParserPool();
    this.resolver = new ImportResolver();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Performs a full build: walks all files, parses them, extracts
   * symbols/imports/callRefs, resolves imports, and persists everything to
   * the database.
   */
  async build(): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      const files = await walkFiles(this.walkerConfig);
      for (const file of files) {
        this.processFile(db, file.path, file.language);
      }
      this.resolveImports(db);
    } finally {
      db.close();
    }
  }

  /**
   * Incrementally re-processes only the listed files and updates the DB.
   * Symbols and imports for changed files are deleted then re-inserted.
   *
   * @param changedFiles  Absolute paths of files that have changed.
   */
  async update(changedFiles: string[]): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      // Determine languages for changed files using the walker config
      const allFiles = await walkFiles(this.walkerConfig);
      const languageMap = new Map(allFiles.map(f => [f.path, f.language]));

      for (const filePath of changedFiles) {
        // If the file no longer exists, remove it from the DB
        if (!fs.existsSync(filePath)) {
          const row = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as
            | { id: number }
            | undefined;
          if (row) {
            // Null out any resolved_id references pointing to this file
            db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(row.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
          }
          continue;
        }

        const language = languageMap.get(filePath);
        if (!language) continue;

        // Null out resolved_id references pointing to this file before deletion
        const existingRow = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as
          | { id: number }
          | undefined;
        if (existingRow) {
          db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(existingRow.id);
        }

        // Delete existing rows for this file (cascade handles symbols/imports)
        db.prepare('DELETE FROM files WHERE path = ?').run(filePath);

        this.processFile(db, filePath, language);
      }

      this.resolveImports(db);
    } finally {
      db.close();
    }
  }

  /**
   * Stub: writes an LLM-generated summary for a symbol to `symbol_summaries`.
   * Full implementation will be completed in M2.
   *
   * @param symbolId  Row ID of the symbol in the `symbols` table.
   * @param summary   Natural-language summary text.
   * @param model     Name of the model that produced the summary.
   */
  ingestSummary(symbolId: number, summary: string, model = 'unknown'): void {
    const db = openDb(this.dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model)
         VALUES (?, ?, ?)`,
      ).run(symbolId, summary, model);
    } finally {
      db.close();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Parse one file, extract symbols/imports/callRefs, and insert into the DB. */
  private processFile(db: Database.Database, filePath: string, language: string): void {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // Skip unreadable files
    }

    const hash = crypto.createHash('sha256').update(source).digest('hex');

    // Check if the file is already up-to-date
    const existing = db.prepare('SELECT id, last_hash FROM files WHERE path = ?').get(filePath) as
      | FileRow
      | undefined;
    if (existing?.last_hash === hash) return;

    const sizeBytes = Buffer.byteLength(source, 'utf8');

    // Upsert the file row
    let fileId: number;
    if (existing) {
      db.prepare(
        `UPDATE files SET language = ?, size_bytes = ?, last_hash = ?, indexed_at = unixepoch()
         WHERE id = ?`,
      ).run(language, sizeBytes, hash, existing.id);
      fileId = existing.id;
      // Remove stale symbols / imports
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(fileId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO files (path, language, size_bytes, last_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .run(filePath, language, sizeBytes, hash) as { lastInsertRowid: number | bigint };
      fileId = Number(info.lastInsertRowid);
    }

    // Parse the source
    const tree = this.pool.parse(language, source);
    if (!tree) return;

    const extractor = EXTRACTORS[language];
    if (!extractor) return;

    const result: ExtractionResult = extractor.extract(tree, source, filePath);

    // Insert symbols
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Map from callerSymbol name → symbol row ID (for call refs)
    const symbolIdMap = new Map<string, number>();

    for (const sym of result.symbols) {
      const info = insertSymbol.run(
        fileId,
        sym.name,
        sym.kind,
        sym.startLine,
        sym.endLine,
        sym.signature ?? null,
        null, // doc_comment extraction in future milestone
      ) as { lastInsertRowid: number | bigint };
      symbolIdMap.set(sym.name, Number(info.lastInsertRowid));
    }

    // Insert raw imports (resolved_id will be filled in resolveImports())
    const insertImport = db.prepare(
      `INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)`,
    );
    for (const imp of result.imports) {
      insertImport.run(fileId, imp.source);
    }

    // Insert call refs (callee_id resolved in call-graph phase)
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line)
       VALUES (?, ?, ?)`,
    );
    for (const ref of result.callRefs) {
      const callerId = symbolIdMap.get(ref.callerSymbol);
      if (callerId !== undefined) {
        insertCallRef.run(callerId, ref.calleeRaw, ref.line);
      }
    }
  }

  /**
   * Second pass: resolve raw_import strings to file IDs in the
   * `file_imports.resolved_id` column.
   */
  private resolveImports(db: Database.Database): void {
    const rootDir = this.walkerConfig.rootDir;

    // Fetch all unresolved imports with their file's path and language
    const rows = db
      .prepare(
        `SELECT fi.id, fi.raw_import, f.path, f.language
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id IS NULL`,
      )
      .all() as Array<{ id: number; raw_import: string; path: string; language: string }>;

    const updateResolved = db.prepare(
      'UPDATE file_imports SET resolved_id = ? WHERE id = ?',
    );

    for (const row of rows) {
      const resolved = this.resolver.resolve(
        { source: row.raw_import, importedNames: [] },
        row.path,
        rootDir,
        row.language,
      );

      if (resolved.resolvedPath) {
        const targetFile = db
          .prepare('SELECT id FROM files WHERE path = ?')
          .get(resolved.resolvedPath) as { id: number } | undefined;
        if (targetFile) {
          updateResolved.run(targetFile.id, row.id);
        }
      }
    }
  }
}
