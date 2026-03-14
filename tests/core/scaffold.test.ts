import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateScaffold, ScaffoldOptions } from '../../src/core/scaffold.js';
import type { CompilationUnit } from '../../src/agents/types.js';
import { createSilentLogger } from '../helpers/mocks.js';

function makeUnits(): CompilationUnit[] {
  return [
    {
      id: 'core',
      name: 'Core Library',
      targetPath: 'crates/mylib-core',
      sourceFiles: ['src/core.c', 'src/util.c'],
      dependsOn: [],
    },
    {
      id: 'compress',
      name: 'Compression',
      targetPath: 'crates/mylib-compress',
      sourceFiles: ['src/compress.c'],
      dependsOn: ['core'],
    },
  ];
}

function baseOptions(outputPath: string, lang: string): ScaffoldOptions {
  return {
    outputPath,
    targetLanguage: lang,
    projectName: 'test-project',
    compilationUnits: makeUnits(),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe('generateScaffold', () => {
  let tempDir: string;
  let logger: ReturnType<typeof createSilentLogger>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-scaffold-'));
    logger = createSilentLogger(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Rust ──────────────────────────────────────────────────────────

  describe('Rust scaffold', () => {
    it('should create workspace Cargo.toml and per-crate structure', async () => {
      const result = await generateScaffold(baseOptions(tempDir, 'rust'), logger);

      expect(result.filesCreated).toBeGreaterThan(0);

      // Root Cargo.toml
      const rootCargo = await readFile(join(tempDir, 'Cargo.toml'), 'utf-8');
      expect(rootCargo).toContain('[workspace]');
      expect(rootCargo).toContain('crates/mylib-core');
      expect(rootCargo).toContain('crates/mylib-compress');

      // Per-crate Cargo.toml
      const coreCargo = await readFile(join(tempDir, 'crates/mylib-core/Cargo.toml'), 'utf-8');
      expect(coreCargo).toContain('name = "mylib-core"');

      const compressCargo = await readFile(join(tempDir, 'crates/mylib-compress/Cargo.toml'), 'utf-8');
      expect(compressCargo).toContain('name = "mylib-compress"');
      expect(compressCargo).toContain('mylib-core');

      // lib.rs stubs
      expect(await exists(join(tempDir, 'crates/mylib-core/src/lib.rs'))).toBe(true);
      expect(await exists(join(tempDir, 'crates/mylib-compress/src/lib.rs'))).toBe(true);
    });
  });

  // ─── C# ────────────────────────────────────────────────────────────

  describe('C# scaffold', () => {
    it('should create solution file and per-project .csproj', async () => {
      const result = await generateScaffold(baseOptions(tempDir, 'csharp'), logger);

      expect(result.filesCreated).toBeGreaterThan(0);

      // .sln
      const sln = await readFile(join(tempDir, 'test-project.sln'), 'utf-8');
      expect(sln).toContain('Visual Studio Solution');

      // .csproj for core
      const coreCsproj = await readFile(
        join(tempDir, 'crates/mylib-core/mylib-core.csproj'), 'utf-8',
      );
      expect(coreCsproj).toContain('<Project Sdk="Microsoft.NET.Sdk">');
    });

    it('should use custom target framework when specified', async () => {
      const opts: ScaffoldOptions = {
        ...baseOptions(tempDir, 'csharp'),
        targetFramework: 'net9.0',
      };
      await generateScaffold(opts, logger);

      const csproj = await readFile(
        join(tempDir, 'crates/mylib-core/mylib-core.csproj'), 'utf-8',
      );
      expect(csproj).toContain('net9.0');
    });
  });

  // ─── Go ────────────────────────────────────────────────────────────

  describe('Go scaffold', () => {
    it('should create go.mod and per-package doc.go', async () => {
      const result = await generateScaffold(baseOptions(tempDir, 'go'), logger);

      expect(result.filesCreated).toBeGreaterThan(0);

      const goMod = await readFile(join(tempDir, 'go.mod'), 'utf-8');
      expect(goMod).toContain('module test-project');

      expect(await exists(join(tempDir, 'crates/mylib-core/doc.go'))).toBe(true);
      expect(await exists(join(tempDir, 'crates/mylib-compress/doc.go'))).toBe(true);
    });
  });

  // ─── TypeScript ────────────────────────────────────────────────────

  describe('TypeScript scaffold', () => {
    it('should create root package.json/tsconfig and per-package structure', async () => {
      const result = await generateScaffold(baseOptions(tempDir, 'typescript'), logger);

      expect(result.filesCreated).toBeGreaterThan(0);

      const rootPkg = JSON.parse(await readFile(join(tempDir, 'package.json'), 'utf-8'));
      expect(rootPkg.workspaces).toContain('crates/mylib-core');
      expect(rootPkg.workspaces).toContain('crates/mylib-compress');

      const tsconfig = JSON.parse(await readFile(join(tempDir, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.references.length).toBe(2);

      // Per-package
      const corePkg = JSON.parse(
        await readFile(join(tempDir, 'crates/mylib-core/package.json'), 'utf-8'),
      );
      expect(corePkg.name).toBe('@test-project/mylib-core');

      expect(await exists(join(tempDir, 'crates/mylib-core/src/index.ts'))).toBe(true);
    });
  });

  // ─── Generic / unknown ────────────────────────────────────────────

  describe('Generic scaffold', () => {
    it('should create directories and READMEs for unknown languages', async () => {
      const result = await generateScaffold(baseOptions(tempDir, 'haskell'), logger);

      expect(result.filesCreated).toBeGreaterThan(0);
      expect(await exists(join(tempDir, 'crates/mylib-core/README.md'))).toBe(true);
    });
  });

  // ─── Idempotency ──────────────────────────────────────────────────

  describe('idempotency', () => {
    it('should not overwrite existing files on re-run', async () => {
      const opts = baseOptions(tempDir, 'rust');

      const first = await generateScaffold(opts, logger);
      expect(first.filesCreated).toBeGreaterThan(0);
      expect(first.filesSkipped).toBe(0);

      const second = await generateScaffold(opts, logger);
      expect(second.filesCreated).toBe(0);
      expect(second.filesSkipped).toBe(first.filesCreated);
    });
  });

  // ─── Empty units ──────────────────────────────────────────────────

  describe('empty units', () => {
    it('should be a no-op when no compilation units provided', async () => {
      const opts: ScaffoldOptions = {
        ...baseOptions(tempDir, 'rust'),
        compilationUnits: [],
      };
      const result = await generateScaffold(opts, logger);
      expect(result.filesCreated).toBe(0);
      expect(result.dirsCreated).toBe(0);
    });
  });
});
