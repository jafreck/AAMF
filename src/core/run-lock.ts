import { open, readFile, rm } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import type { Logger } from '../logging/logger.js';
import { ensureDir } from '../util/fs.js';

export interface MigrationRunLockMetadata {
  version: 1;
  projectName: string;
  runId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export class ActiveMigrationRunError extends Error {
  constructor(lockPath: string, metadata?: Partial<MigrationRunLockMetadata>) {
    const owner = metadata
      ? `runId=${metadata.runId ?? 'unknown'}, pid=${metadata.pid ?? 'unknown'}, host=${metadata.hostname ?? 'unknown'}, acquiredAt=${metadata.acquiredAt ?? 'unknown'}`
      : 'unknown owner';
    super(`Migration directory is already locked by another active runtime (${owner}). Lock file: ${lockPath}`);
    this.name = 'ActiveMigrationRunError';
  }
}

export class MigrationRunLock {
  private acquired = false;

  constructor(
    private readonly lockPath: string,
    private readonly logger: Logger,
    private readonly projectName: string,
    private readonly runId: string,
    private readonly pid: number = process.pid,
    private readonly host: string = hostname(),
  ) {}

  async acquire(): Promise<void> {
    if (this.acquired) return;

    await ensureDir(dirname(this.lockPath));

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(this.buildMetadata(), null, 2) + '\n', 'utf-8');
        } finally {
          await handle.close();
        }
        this.acquired = true;
        return;
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'EEXIST') throw err;

        const existing = await this.readLockFile();
        if (existing && this.isActiveLock(existing)) {
          throw new ActiveMigrationRunError(this.lockPath, existing);
        }

        if (attempt === 1) {
          throw new Error(`Failed to acquire migration run lock at ${this.lockPath}`);
        }

        if (existing) {
          this.logger.warn(
            `Removing stale migration run lock held by runId=${existing.runId ?? 'unknown'} pid=${existing.pid ?? 'unknown'} at ${this.lockPath}`,
          );
        } else {
          this.logger.warn(`Removing unreadable migration run lock at ${this.lockPath}`);
        }
        await rm(this.lockPath, { force: true });
      }
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;

    const existing = await this.readLockFile();
    if (existing && !this.isOwnedByCurrentRun(existing)) {
      return;
    }

    await rm(this.lockPath, { force: true });
  }

  releaseSync(): void {
    if (!this.acquired) return;
    this.acquired = false;

    const existing = this.readLockFileSync();
    if (existing && !this.isOwnedByCurrentRun(existing)) {
      return;
    }

    rmSync(this.lockPath, { force: true });
  }

  private buildMetadata(): MigrationRunLockMetadata {
    return {
      version: 1,
      projectName: this.projectName,
      runId: this.runId,
      pid: this.pid,
      hostname: this.host,
      acquiredAt: new Date().toISOString(),
    };
  }

  private isActiveLock(metadata: Partial<MigrationRunLockMetadata>): boolean {
    if (metadata.hostname && metadata.hostname !== this.host) {
      return true;
    }
    if (typeof metadata.pid !== 'number' || !Number.isInteger(metadata.pid) || metadata.pid <= 0) {
      return false;
    }

    try {
      process.kill(metadata.pid, 0);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      return error.code === 'EPERM';
    }
  }

  private isOwnedByCurrentRun(metadata: Partial<MigrationRunLockMetadata>): boolean {
    return metadata.runId === this.runId && metadata.pid === this.pid;
  }

  private async readLockFile(): Promise<Partial<MigrationRunLockMetadata> | undefined> {
    try {
      const raw = await readFile(this.lockPath, 'utf-8');
      return JSON.parse(raw) as Partial<MigrationRunLockMetadata>;
    } catch {
      return undefined;
    }
  }

  private readLockFileSync(): Partial<MigrationRunLockMetadata> | undefined {
    try {
      const raw = readFileSync(this.lockPath, 'utf-8');
      return JSON.parse(raw) as Partial<MigrationRunLockMetadata>;
    } catch {
      return undefined;
    }
  }
}