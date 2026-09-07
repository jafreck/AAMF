import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite } from '../util/fs.js';

interface ChangeSetManifest {
  version: 1;
  scopeId: string;
  createdAt: string;
  mode: 'full' | 'tracked';
  trackedFiles: string[];
}

export interface TargetChangeSetLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Runtime-owned, persisted filesystem transaction for target mutations.
 * Snapshots use ordinary files rather than Git so rejected work can be
 * restored without changing Git HEAD or invoking destructive Git commands.
 */
export class TargetChangeSetManager {
  private readonly storageDir: string;
  private readonly taskScopes = new Map<string, string>();
  private manifestUpdateTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly targetRoot: string,
    stateDir: string,
    private readonly logger: TargetChangeSetLogger,
  ) {
    this.storageDir = join(stateDir, 'target-change-sets');
  }

  bindTask(taskId: string, scopeId: string): void {
    this.taskScopes.set(taskId, scopeId);
  }

  scopeForTask(taskId: string): string {
    return this.taskScopes.get(taskId) ?? taskId;
  }

  isSharedTaskScope(taskId: string): boolean {
    const scopeId = this.scopeForTask(taskId);
    let bindings = 0;
    for (const boundScope of this.taskScopes.values()) {
      if (boundScope === scopeId) bindings++;
      if (bindings > 1) return true;
    }
    return false;
  }

  async has(scopeId: string): Promise<boolean> {
    try {
      await readFile(this.manifestPath(scopeId), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async begin(
    scopeId: string,
    options: { mode?: 'full' | 'tracked'; files?: string[] } = {},
  ): Promise<void> {
    if (await this.has(scopeId)) return;

    const directory = this.scopeDirectory(scopeId);
    const tree = join(directory, 'tree');
    await rm(directory, { recursive: true, force: true });
    await mkdir(tree, { recursive: true });

    try {
      const entries = await readdir(this.targetRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === '.aamf') continue;
        await cp(join(this.targetRoot, entry.name), join(tree, entry.name), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const manifest: ChangeSetManifest = {
      version: 1,
      scopeId,
      createdAt: new Date().toISOString(),
      mode: options.mode ?? 'full',
      trackedFiles: this.normalizeTrackedFiles(options.files ?? []),
    };
    await atomicWrite(this.manifestPath(scopeId), `${JSON.stringify(manifest, null, 2)}\n`);
    this.logger.info(`Captured target change set ${scopeId}`);
  }

  async trackFiles(scopeId: string, files: readonly string[]): Promise<void> {
    const update = this.manifestUpdateTail.then(async () => {
      if (!(await this.has(scopeId))) return;
      const manifest = await this.readManifest(scopeId);
      manifest.trackedFiles = [...new Set([
        ...manifest.trackedFiles,
        ...this.normalizeTrackedFiles(files),
      ])].sort();
      await atomicWrite(this.manifestPath(scopeId), `${JSON.stringify(manifest, null, 2)}\n`);
    });
    this.manifestUpdateTail = update.catch(() => undefined);
    await update;
  }

  async accept(scopeId: string): Promise<void> {
    await rm(this.scopeDirectory(scopeId), { recursive: true, force: true });
    this.deleteBindings(scopeId);
    this.logger.info(`Accepted target change set ${scopeId}`);
  }

  async rollback(scopeId: string): Promise<void> {
    if (!(await this.has(scopeId))) return;
    const tree = join(this.scopeDirectory(scopeId), 'tree');
    const manifest = await this.readManifest(scopeId);
    await mkdir(this.targetRoot, { recursive: true });

    if (manifest.mode === 'full') {
      const currentEntries = await readdir(this.targetRoot, { withFileTypes: true });
      await Promise.all(currentEntries
        .filter(entry => entry.name !== '.git' && entry.name !== '.aamf')
        .map(entry => rm(join(this.targetRoot, entry.name), { recursive: true, force: true })));

      const snapshotEntries = await readdir(tree, { withFileTypes: true });
      for (const entry of snapshotEntries) {
        await cp(join(tree, entry.name), join(this.targetRoot, entry.name), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
      }
    } else {
      for (const trackedFile of manifest.trackedFiles) {
        const currentPath = join(this.targetRoot, trackedFile);
        const snapshotPath = join(tree, trackedFile);
        await rm(currentPath, { recursive: true, force: true });
        try {
          await mkdir(join(currentPath, '..'), { recursive: true });
          await cp(snapshotPath, currentPath, {
            recursive: true,
            force: true,
            preserveTimestamps: true,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }

    await rm(this.scopeDirectory(scopeId), { recursive: true, force: true });
    this.deleteBindings(scopeId);
    this.logger.warn(`Rolled back target change set ${scopeId}`);
  }

  async rollbackTask(taskId: string): Promise<boolean> {
    const scopeId = this.scopeForTask(taskId);
    if (!(await this.has(scopeId))) return false;
    await this.rollback(scopeId);
    return true;
  }

  /** Restore the oldest pending snapshot and discard nested snapshots. */
  async recoverPending(): Promise<string | undefined> {
    let directories: string[];
    try {
      directories = await readdir(this.storageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    const manifests: ChangeSetManifest[] = [];
    for (const directory of directories) {
      try {
        const raw = await readFile(join(this.storageDir, directory, 'manifest.json'), 'utf-8');
        const manifest = JSON.parse(raw) as ChangeSetManifest;
        if (manifest.version === 1 && manifest.scopeId) manifests.push({
          ...manifest,
          mode: manifest.mode ?? 'full',
          trackedFiles: manifest.trackedFiles ?? [],
        });
      } catch {
        // Corrupt/partial snapshots fail closed: remove them only after a valid
        // outer snapshot has restored the target, otherwise surface the error.
      }
    }
    if (manifests.length === 0) {
      if (directories.length > 0) {
        throw new Error(
          `Target change-set recovery failed: no valid manifest in ${this.storageDir}. ` +
          'Inspect the target and remove the corrupt state directory before resuming.',
        );
      }
      return undefined;
    }

    manifests.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const outermost = manifests[0]!;
    const oldestFullSnapshot = manifests.find(manifest => manifest.mode === 'full');
    if (oldestFullSnapshot) {
      await this.rollback(oldestFullSnapshot.scopeId);
    } else {
      for (const manifest of [...manifests].reverse()) {
        await this.rollback(manifest.scopeId);
      }
    }
    await rm(this.storageDir, { recursive: true, force: true });
    this.taskScopes.clear();
    this.logger.warn(`Recovered pending target change set ${outermost.scopeId}`);
    return outermost.scopeId;
  }

  private scopeDirectory(scopeId: string): string {
    const key = createHash('sha256').update(scopeId).digest('hex').slice(0, 24);
    return join(this.storageDir, key);
  }

  private manifestPath(scopeId: string): string {
    return join(this.scopeDirectory(scopeId), 'manifest.json');
  }

  private async readManifest(scopeId: string): Promise<ChangeSetManifest> {
    const raw = await readFile(this.manifestPath(scopeId), 'utf-8');
    const manifest = JSON.parse(raw) as ChangeSetManifest;
    return {
      ...manifest,
      mode: manifest.mode ?? 'full',
      trackedFiles: manifest.trackedFiles ?? [],
    };
  }

  private normalizeTrackedFiles(files: readonly string[]): string[] {
    const targetRoot = resolve(this.targetRoot);
    return [...new Set(files.flatMap(file => {
      const absolute = resolve(isAbsolute(file) ? file : join(targetRoot, file));
      const path = relative(targetRoot, absolute).replaceAll('\\', '/');
      if (!path || path === '..' || path.startsWith('../')) return [];
      if (path === '.git' || path.startsWith('.git/') || path === '.aamf' || path.startsWith('.aamf/')) return [];
      return [path];
    }))].sort();
  }

  private deleteBindings(scopeId: string): void {
    for (const [taskId, boundScope] of this.taskScopes) {
      if (boundScope === scopeId) this.taskScopes.delete(taskId);
    }
  }
}
