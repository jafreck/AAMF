/**
 * @module core/target-indexer
 *
 * Manages incremental Lore indexing of the migrated target codebase.
 *
 * After each task's code-migrator commit, the runtime calls
 * `updateForFiles()` to re-index only the changed target files.
 * The resulting SQLite DB (`kb-target.db`) is served by a second
 * `KbServerProcess` instance so that agents can query the evolving
 * target codebase alongside the source index.
 */

import { rm } from 'node:fs/promises';
import type { Logger } from '../logging/logger.js';

export interface TargetIndexBuilder {
  build(): Promise<void>;
  update(changedFiles: string[]): Promise<void>;
}

export type TargetIndexBuilderFactory = (
  dbPath: string,
  rootDir: string,
) => Promise<TargetIndexBuilder>;

interface PendingIndexRequest {
  files: string[];
  forceBuild: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const createLoreBuilder: TargetIndexBuilderFactory = async (dbPath, rootDir) => {
  const lore = await import('@jafreck/lore');
  return new lore.IndexBuilder(dbPath, { rootDir }, undefined, { lsp: false });
};

export class TargetIndexer {
  private readonly dbPath: string;
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly createBuilder: TargetIndexBuilderFactory;
  private built = false;
  private builder?: TargetIndexBuilder;
  private pending: PendingIndexRequest[] = [];
  private draining?: Promise<void>;
  private onFirstBuild?: () => Promise<void>;

  constructor(
    dbPath: string,
    rootDir: string,
    logger: Logger,
    createBuilder: TargetIndexBuilderFactory = createLoreBuilder,
  ) {
    this.dbPath = dbPath;
    this.rootDir = rootDir;
    this.logger = logger;
    this.createBuilder = createBuilder;
  }

  /** Register a callback that fires once after the first build/update completes. */
  setOnFirstBuild(callback: () => Promise<void>): void {
    this.onFirstBuild = callback;
  }

  /** Full build of the target index from scratch. */
  async build(): Promise<void> {
    return this.enqueue([], true);
  }

  /**
   * Incrementally update the target index for the given changed files.
   * If the index has never been built, performs a full build instead.
   */
  async updateForFiles(changedFiles: string[]): Promise<void> {
    if (changedFiles.length === 0) return;
    return this.enqueue(changedFiles, false);
  }

  /** Whether the target index DB has been built at least once. */
  get isBuilt(): boolean {
    return this.built;
  }

  /** Mark the index as already built (for resume scenarios). */
  markBuilt(): void {
    this.built = true;
  }

  /** Discard index state after a target rollback so stale code is never served. */
  async invalidate(): Promise<void> {
    this.builder = undefined;
    this.built = false;
    await Promise.all([
      rm(this.dbPath, { force: true }),
      rm(`${this.dbPath}-wal`, { force: true }),
      rm(`${this.dbPath}-shm`, { force: true }),
    ]);
  }

  private enqueue(files: string[], forceBuild: boolean): Promise<void> {
    const request = new Promise<void>((resolve, reject) => {
      this.pending.push({ files: [...new Set(files)], forceBuild, resolve, reject });
    });
    this.ensureDrain();
    return request;
  }

  private ensureDrain(): void {
    if (this.draining) return;
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        if (this.pending.length > 0) this.ensureDrain();
      });
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const requests = this.pending.splice(0);
      const files = [...new Set(requests.flatMap(request => request.files))].sort();
      const forceBuild = requests.some(request => request.forceBuild);

      try {
        await this.applyUpdate(files, forceBuild);
        for (const request of requests) request.resolve();
      } catch (error) {
        for (const request of requests) request.reject(error);
      }
    }
  }

  private async applyUpdate(files: string[], forceBuild: boolean): Promise<void> {
    const builder = await this.getBuilder();
    if (!this.built || forceBuild) {
      try {
        await builder.build();
      } catch (error) {
        this.builder = undefined;
        this.built = false;
        throw error;
      }
      const wasInitialBuild = !this.built;
      this.built = true;
      this.logger.info(
        wasInitialBuild
          ? `Target index initial build (triggered by ${files.length} file(s))`
          : 'Target index rebuilt',
      );
      if (wasInitialBuild && this.onFirstBuild) {
        const callback = this.onFirstBuild;
        this.onFirstBuild = undefined;
        await callback();
      }
      return;
    }

    await builder.update(files);
    this.logger.debug(`Target index updated for ${files.length} file(s)`);
  }

  private async getBuilder(): Promise<TargetIndexBuilder> {
    this.builder ??= await this.createBuilder(this.dbPath, this.rootDir);
    return this.builder;
  }
}
