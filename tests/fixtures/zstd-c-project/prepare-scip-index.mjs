import { readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCompilationDatabase, loadCompilationDatabase } from '@jafreck/lore';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: sourceRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: sourceRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`)
  );
}

const fixtureRoot = realpathSync(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = realpathSync(resolve(fixtureRoot, 'zstd-src', 'zstd-1.5.7'));
if (sourceRoot === fixtureRoot || !isWithin(fixtureRoot, sourceRoot)) {
  throw new Error(`Refusing to prepare a zstd checkout outside the fixture: ${sourceRoot}`);
}
const buildDir = resolve(sourceRoot, '.lore-compdb');
const compdbPath = join(buildDir, 'compile_commands.json');
const rootCompdbPath = join(sourceRoot, 'compile_commands.json');

await rm(rootCompdbPath, { force: true });
await rm(join(sourceRoot, 'build', 'compile_commands.json'), { force: true });
await rm(buildDir, { recursive: true, force: true });

const sdkArguments = process.platform === 'darwin'
  ? [`-DCMAKE_OSX_SYSROOT=${output('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])}`]
  : [];

run('cmake', [
  '-S', join(sourceRoot, 'build', 'cmake'),
  '-B', buildDir,
  '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Debug',
  '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  '-DZSTD_BUILD_COMPRESSION=ON',
  '-DZSTD_BUILD_DECOMPRESSION=ON',
  '-DZSTD_BUILD_DICTBUILDER=ON',
  '-DZSTD_BUILD_DEPRECATED=ON',
  '-DZSTD_BUILD_PROGRAMS=ON',
  '-DZSTD_BUILD_TESTS=ON',
  '-DZSTD_BUILD_CONTRIB=ON',
  '-DZSTD_BUILD_SHARED=ON',
  '-DZSTD_BUILD_STATIC=ON',
  '-DZSTD_LEGACY_SUPPORT=ON',
  '-DZSTD_MULTITHREAD_SUPPORT=ON',
  ...sdkArguments,
]);

const canonicalRoot = sourceRoot;
const entries = JSON.parse(await readFile(compdbPath, 'utf8'));
if (!Array.isArray(entries) || entries.length === 0) {
  throw new Error(`No compilation commands were generated at ${compdbPath}`);
}

const indexedFiles = new Set();
for (const [index, entry] of entries.entries()) {
  if (typeof entry?.directory !== 'string' || typeof entry?.file !== 'string') {
    throw new Error(`Compilation command ${index} is missing directory or file`);
  }
  const directory = realpathSync(entry.directory);
  const sourceFile = realpathSync(resolve(directory, entry.file));
  if (!isWithin(canonicalRoot, directory) || !isWithin(canonicalRoot, sourceFile)) {
    throw new Error(`Compilation command ${index} escapes the source root: ${sourceFile}`);
  }
  indexedFiles.add(sourceFile);
}

const loadedCompdb = loadCompilationDatabase(compdbPath, undefined, sourceRoot).database;
if (!loadedCompdb?.validation.valid) {
  throw new Error(`Lore rejected CMake's compilation database: ${JSON.stringify(loadedCompdb?.validation)}`);
}
const loremEntry = loadedCompdb.entries.find(entry =>
  entry.filePath === join(sourceRoot, 'programs', 'lorem.c'));
if (!loremEntry) {
  throw new Error('CMake compilation database does not contain programs/lorem.c');
}
entries.push({
  directory: loremEntry.workingDirectory,
  file: loremEntry.filePath,
  arguments: [
    ...loremEntry.arguments,
    '-include',
    join(sourceRoot, 'programs', 'windres', 'verrsrc.h'),
  ],
});
await writeFile(rootCompdbPath, `${JSON.stringify(entries, null, 2)}\n`);

for (const requiredPath of [
  'lib/compress/zstd_compress.c',
  'programs/zstdcli.c',
]) {
  const requiredFile = realpathSync(join(sourceRoot, requiredPath));
  if (!indexedFiles.has(requiredFile)) {
    throw new Error(`Compilation database does not cover required file ${requiredPath}`);
  }
}

const discovered = discoverCompilationDatabase(sourceRoot);
if (!discovered.database?.validation.valid || discovered.database.path !== rootCompdbPath) {
  throw new Error(`Lore rejected the generated compilation database: ${JSON.stringify(discovered.candidates)}`);
}

console.log(JSON.stringify({
  sourceRoot,
  buildDir,
  compdbPath: rootCompdbPath,
  entries: entries.length,
  macosSdkRoot: sdkArguments[0]?.slice('-DCMAKE_OSX_SYSROOT='.length) ?? null,
  ancillaryHeaderVariant: 'programs/lorem.c -include programs/windres/verrsrc.h',
  validation: discovered.database.validation,
}, null, 2));