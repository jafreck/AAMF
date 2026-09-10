import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  IndexBuilder,
  killAllTracked,
  listResolvedEdges,
  openReadOnly,
  trackedCount,
  validateIndex,
} from '@jafreck/lore';

function executableOnPath(command: string): boolean {
  const candidates = [
    join(homedir(), '.lore', 'bin', command),
    ...(process.env.PATH ?? '').split(delimiter)
      .filter(pathEntry => pathEntry.length > 0)
      .map(pathEntry => join(pathEntry, command)),
  ];
  return candidates.some(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const scipClangAvailable = executableOnPath('scip-clang');

describe.skipIf(!scipClangAvailable)('SCIP C integration', () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(async () => {
    rootDir = realpathSync(await mkdtemp(join(tmpdir(), 'aamf-scip-c-')));
    dbPath = join(rootDir, 'kb.db');
    const buildDir = join(rootDir, '.lore-compdb');
    const calleeFile = join(rootDir, 'callee.c');
    const callerFile = join(rootDir, 'caller.c');
    await mkdir(buildDir, { recursive: true });
    await writeFile(calleeFile, 'int add_one(int value) { return value + 1; }\n');
    await writeFile(callerFile, [
      'int add_one(int value);',
      'int main(void) { return add_one(41); }',
      '',
    ].join('\n'));
    await writeFile(join(buildDir, 'compile_commands.json'), JSON.stringify([
      {
        directory: buildDir,
        command: `/usr/bin/cc -c ${calleeFile}`,
        file: calleeFile,
      },
      {
        directory: buildDir,
        command: `/usr/bin/cc -c ${callerFile}`,
        file: callerFile,
      },
    ]));
  });

  afterEach(async () => {
    killAllTracked();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('resolves a source-verified caller-to-callee edge without LSP', async () => {
    const walkerConfig = {
      rootDir,
      branch: 'main',
      includeGlobs: ['**/*.c'],
      excludeGlobs: ['.lore-compdb', '.lore-compdb/**'],
    };
    const scipScope = {
      languages: ['c'],
      includeGlobs: ['**/*.c'],
    };
    const validation = {
      profile: 'migration-grade' as const,
      requiredGlobs: ['callee.c', 'caller.c'],
      thresholds: { minCallRefs: 1 },
      requiredSymbols: [
        { name: 'main', path: 'caller.c', kind: 'function' },
        { name: 'add_one', path: 'callee.c', kind: 'function' },
      ],
      requiredCalls: [{
        caller: { name: 'main', path: 'caller.c', kind: 'function' },
        callee: { name: 'add_one', path: 'callee.c', kind: 'function' },
        resolutionMethod: 'scip_definition' as const,
      }],
    };
    const builder = new IndexBuilder(dbPath, walkerConfig, undefined, {
      scip: true,
      scipScope,
      lsp: false,
      embeddings: false,
      execution: { allowSubprocessExecution: true },
      validation,
    });

    const effective = await builder.resolveConfiguration();
    expect(effective).toMatchObject({
      lsp: null,
      execution: {
        allowSubprocessExecution: true,
        allowBuildExecution: false,
        allowCustomIndexerCommands: false,
        allowCustomLspCommands: false,
        allowAutoInstall: false,
      },
    });

    await builder.build();
    const report = validateIndex(dbPath, {
      rootDir,
      branch: walkerConfig.branch,
      walkerConfig,
      scipScope,
      policy: validation,
    });
    expect(report.ok).toBe(true);
    expect(report.provenance.indexers).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexer: 'scip-clang', status: 'succeeded', attempted: true }),
      expect.objectContaining({ indexer: 'lsp', status: 'disabled', attempted: false }),
    ]));
    expect(report.provenance.diagnostics.compiler).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'succeeded',
        details: expect.objectContaining({
          compilerDiagnostics: expect.objectContaining({
            requested: true,
            complete: true,
            summary: expect.objectContaining({
              errors: 0,
              failedTranslationUnits: 0,
              skippedTranslationUnits: 0,
            }),
          }),
        }),
      }),
    ]));

    const db = openReadOnly(dbPath);
    try {
      const edge = listResolvedEdges(db, { resolvedOnly: true }).find(candidate =>
        candidate.caller_name === 'main' &&
        candidate.callee_name === 'add_one' &&
        candidate.caller_file_path === join(rootDir, 'caller.c') &&
        candidate.callee_file_path === join(rootDir, 'callee.c'));
      expect(edge).toMatchObject({
        caller_name: 'main',
        callee_name: 'add_one',
        resolution_method: 'scip_definition',
      });
    } finally {
      db.close();
    }
    expect(trackedCount()).toBe(0);
  }, 120_000);
});