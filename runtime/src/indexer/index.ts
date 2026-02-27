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
import { openDb, setKbMeta, createVec0Tables } from './db.js';
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
import type { EmbeddingProvider } from './embedder.js';

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

/** Number of symbols to embed per batch. */
const EMBED_BATCH_SIZE = 64;

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
  private readonly embedder: EmbeddingProvider | null;

  constructor(dbPath: string, walkerConfig: WalkerConfig, embedder?: EmbeddingProvider) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.pool = new ParserPool();
    this.resolver = new ImportResolver();
    this.embedder = embedder ?? null;
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
      if (this.embedder) {
        await this.embedStructural(db);
      }
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
   * Writes an LLM-generated summary for a symbol to `symbol_summaries`.
   * If an `EmbeddingProvider` was configured, also embeds the summary text
   * and persists it to `symbol_semantic_embeddings`.
   *
   * @param symbolId  Row ID of the symbol in the `symbols` table.
   * @param summary   Natural-language summary text.
   * @param model     Name of the model that produced the summary.
   */
  async ingestSummary(symbolId: number, summary: string, model = 'unknown'): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model)
         VALUES (?, ?, ?)`,
      ).run(symbolId, summary, model);

      if (this.embedder) {
        const [[embedding]] = await Promise.all([this.embedder.embed([summary])]);
        db.prepare(
          'INSERT OR REPLACE INTO symbol_semantic_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
        ).run(symbolId, JSON.stringify(embedding));
      }
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
      // Remove stale symbols / imports / external deps (also clean up FTS5 index)
      db.prepare(
        `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)`,
      ).run(fileId);
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM external_deps WHERE file_id = ?').run(fileId);
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

    // Insert symbols and keep FTS5 index in sync
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)`,
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
        sym.docComment ?? null,
      ) as { lastInsertRowid: number | bigint };
      const symId = Number(info.lastInsertRowid);
      symbolIdMap.set(sym.name, symId);
      insertFts.run(symId, sym.name, sym.signature ?? '', sym.kind);
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
   * `file_imports.resolved_id` column.  Also populates `external_deps` for
   * any import that resolves to an external package.
   */
  private resolveImports(db: Database.Database): void {
    const rootDir = this.walkerConfig.rootDir;

    // Fetch all unresolved imports with their file's path, language, and file_id
    const rows = db
      .prepare(
        `SELECT fi.id, fi.file_id, fi.raw_import, f.path, f.language
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id IS NULL`,
      )
      .all() as Array<{ id: number; file_id: number; raw_import: string; path: string; language: string }>;

    const updateResolved = db.prepare(
      'UPDATE file_imports SET resolved_id = ? WHERE id = ?',
    );
    const insertExternalDep = db.prepare(
      'INSERT OR IGNORE INTO external_deps (file_id, package) VALUES (?, ?)',
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
      } else if (resolved.isExternal && resolved.externalName) {
        insertExternalDep.run(row.file_id, resolved.externalName);
      }
    }
  }

  /**
   * Embed structural symbol signatures in batches and persist results to
   * the `symbol_embeddings` vec0 virtual table.
   *
   * Also stores the embedding model name and dims in `kb_meta` and
   * creates the vec0 tables if they don't exist yet.
   */
  private async embedStructural(db: Database.Database): Promise<void> {
    const embedder = this.embedder!;

    setKbMeta(db, 'embedding_model', embedder.modelName);
    setKbMeta(db, 'embedding_dims', String(embedder.dims));
    createVec0Tables(db, embedder.dims);

    // Fetch all symbols that have a signature to embed.
    const symbols = db
      .prepare('SELECT id, name, signature FROM symbols WHERE signature IS NOT NULL')
      .all() as Array<{ id: number; name: string; signature: string }>;

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );

    for (let i = 0; i < symbols.length; i += EMBED_BATCH_SIZE) {
      const batch = symbols.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(s => s.signature || s.name);
      const embeddings = await embedder.embed(texts);

      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          if (sym) insertEmbed.run(sym.id, JSON.stringify(embeddings[j]));
        }
      })();
    }
  }
}
