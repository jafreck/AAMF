import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCompilationDatabase } from '@jafreck/lore';

describe('compilation database provenance', () => {
  let rootDir: string;
  let buildDir: string;
  let sourceFile: string;
  let compdbPath: string;

  beforeEach(async () => {
    rootDir = realpathSync(await mkdtemp(join(tmpdir(), 'aamf-compdb-')));
    buildDir = join(rootDir, '.lore-compdb');
    sourceFile = join(rootDir, 'main.c');
    compdbPath = join(buildDir, 'compile_commands.json');
    await mkdir(buildDir, { recursive: true });
    await writeFile(sourceFile, 'int main(void) { return 0; }\n');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rejects a relocated database and accepts one regenerated for the current root', async () => {
    await writeFile(compdbPath, JSON.stringify([{
      directory: '/obsolete/cache/checkout/build',
      command: '/usr/bin/cc -c /obsolete/cache/checkout/main.c',
      file: '/obsolete/cache/checkout/main.c',
    }]));

    const relocated = discoverCompilationDatabase(rootDir);
    expect(relocated.database).toBeNull();
    expect(relocated.candidates[0]?.validation).toMatchObject({
      valid: false,
      missingFiles: 1,
      missingDirectories: 1,
    });

    await writeFile(compdbPath, JSON.stringify([{
      directory: buildDir,
      command: `/usr/bin/cc -c ${sourceFile}`,
      file: sourceFile,
    }]));

    const regenerated = discoverCompilationDatabase(rootDir);
    expect(regenerated.database).toMatchObject({
      path: compdbPath,
      validation: {
        valid: true,
        status: 'valid',
        existingFiles: 1,
        existingDirectories: 1,
        entriesWithinRoot: 1,
        entriesOutsideApprovedRoots: 0,
      },
    });
  });
});