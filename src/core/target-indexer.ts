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

import type { Logger } from '../logging/logger.js';

export class TargetIndexer {
  private readonly dbPath: string;
  private readonly rootDir: string;
  private readonly logger: Logger;
  private built = false;
  private building = false;
  private onFirstBuild?: () => Promise<void>;

  constructor(dbPath: string, rootDir: string, logger: Logger) {
    this.dbPath = dbPath;
    this.rootDir = rootDir;
    this.logger = logger;
  }

  /** Register a callback that fires once after the first build/update completes. */
  setOnFirstBuild(callback: () => Promise<void>): void {
    this.onFirstBuild = callback;
  }

  /** Full build of the target index from scratch. */
  async build(): Promise<void> {
    const lore = await import('@jafreck/lore');
    const builder = new lore.IndexBuilder(this.dbPath, { rootDir: this.rootDir });
    await builder.build();
    this.built = true;
    this.logger.info('Target index built');
  }

  /**
   * Incrementally update the target index for the given changed files.
   * If the index has never been built, performs a full build instead.
   */
  async updateForFiles(changedFiles: string[]): Promise<void> {
    if (changedFiles.length === 0) return;

    const lore = await import('@jafreck/lore');

    if (!this.built) {
      // Guard against concurrent first-build races.
      if (this.building) return;
      this.building = true;
      // First update — do a full build to establish the schema.
      const builder = new lore.IndexBuilder(this.dbPath, { rootDir: this.rootDir });
      await builder.build();
      this.built = true;
      this.building = false;
      this.logger.info(`Target index initial build (triggered by ${changedFiles.length} file(s))`);
      if (this.onFirstBuild) {
        await this.onFirstBuild();
        this.onFirstBuild = undefined;
      }
    } else {
      const builder = new lore.IndexBuilder(this.dbPath, { rootDir: this.rootDir });
      await builder.update(changedFiles);
      this.logger.debug(`Target index updated for ${changedFiles.length} file(s)`);
    }
  }

  /** Whether the target index DB has been built at least once. */
  get isBuilt(): boolean {
    return this.built;
  }

  /** Mark the index as already built (for resume scenarios). */
  markBuilt(): void {
    this.built = true;
  }
}
