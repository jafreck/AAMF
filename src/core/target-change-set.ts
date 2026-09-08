import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite } from '../util/fs.js';

interface ChangeSetManifest {
  version: 1;
  scopeId: string;
  createdAt: string;
  mode: 'full' | 'tracked';
  trackedFiles: string[];
  taskIds: string[];
  git?: {
    head?: string;
    indexExists: boolean;
  };
}

export interface TargetChangeRecovery {
  scopeId: string;
  taskIds: string[];
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
      taskIds: [...this.taskScopes.entries()]
        .filter(([, boundScope]) => boundScope === scopeId)
        .map(([taskId]) => taskId)
        .sort(),
      git: await this.captureGitState(directory),
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
    const directory = this.scopeDirectory(scopeId);
    const tree = join(directory, 'tree');
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

    await this.restoreGitState(directory, manifest.git);

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
  async recoverPending(): Promise<TargetChangeRecovery | undefined> {
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
          taskIds: manifest.taskIds ?? [],
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
    return {
      scopeId: outermost.scopeId,
      taskIds: [...new Set(manifests.flatMap(manifest => manifest.taskIds))].sort(),
    };
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
      taskIds: manifest.taskIds ?? [],
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

  private async captureGitState(
    directory: string,
  ): Promise<ChangeSetManifest['git'] | undefined> {
    const inside = await this.runGit(['rev-parse', '--is-inside-work-tree']).catch(() => '');
    if (inside.trim() !== 'true') return undefined;
    const head = await this.runGit(['rev-parse', '--verify', 'HEAD']).catch(() => undefined);
    const indexPath = await this.gitIndexPath();
    let indexExists = false;
    try {
      await cp(indexPath, join(directory, 'git-index'), { force: true });
      indexExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { head: head?.trim() || undefined, indexExists };
  }

  private async restoreGitState(
    directory: string,
    git: ChangeSetManifest['git'] | undefined,
  ): Promise<void> {
    if (!git) return;
    if (git.head) await this.runGit(['update-ref', 'HEAD', git.head]);
    else await this.runGit(['update-ref', '-d', 'HEAD']);
    const indexPath = await this.gitIndexPath();
    await mkdir(dirname(indexPath), { recursive: true });
    if (git.indexExists) {
      const bytes = await readFile(join(directory, 'git-index'));
      await writeFile(indexPath, bytes);
    } else {
      await rm(indexPath, { force: true });
    }
  }

  private async gitIndexPath(): Promise<string> {
    const path = (await this.runGit(['rev-parse', '--git-path', 'index'])).trim();
    return isAbsolute(path) ? path : resolve(this.targetRoot, path);
  }

  private runGit(args: string[]): Promise<string> {
    return new Promise((resolveCommand, rejectCommand) => {
      execFile('git', args, { cwd: this.targetRoot, encoding: 'utf-8' }, (error, stdout) => {
        if (error) rejectCommand(error);
        else resolveCommand(stdout);
      });
    });
  }

  private deleteBindings(scopeId: string): void {
    for (const [taskId, boundScope] of this.taskScopes) {
      if (boundScope === scopeId) this.taskScopes.delete(taskId);
    }
  }
}
