import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { walkFiles, type WalkerConfig } from '@jafreck/lore';

async function touch(filePath: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, '');
}

describe('walkFiles', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'aamf-walker-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('should return an empty array for an empty directory', async () => {
    const result = await walkFiles({ rootDir });
    expect(result).toEqual([]);
  });

  it('should detect TypeScript files', async () => {
    await touch(join(rootDir, 'main.ts'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.language).toBe('typescript');
    expect(result[0]?.path).toContain('main.ts');
  });

  it('should detect JavaScript files', async () => {
    await touch(join(rootDir, 'app.js'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('javascript');
  });

  it('should detect Rust files', async () => {
    await touch(join(rootDir, 'lib.rs'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('rust');
  });

  it('should detect Python files', async () => {
    await touch(join(rootDir, 'script.py'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('python');
  });

  it('should detect C files (.c and .h)', async () => {
    await touch(join(rootDir, 'main.c'));
    await touch(join(rootDir, 'header.h'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(2);
    expect(result.every(f => f.language === 'c')).toBe(true);
  });

  it('should detect C++ files (.cpp, .cc, .hpp)', async () => {
    await touch(join(rootDir, 'module.cpp'));
    await touch(join(rootDir, 'other.cc'));
    await touch(join(rootDir, 'header.hpp'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(3);
    expect(result.every(f => f.language === 'cpp')).toBe(true);
  });

  it('should detect Go files', async () => {
    await touch(join(rootDir, 'main.go'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('go');
  });

  it('should detect Java files', async () => {
    await touch(join(rootDir, 'Main.java'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('java');
  });

  it('should detect C# files', async () => {
    await touch(join(rootDir, 'Program.cs'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.language).toBe('csharp');
  });

  it('should skip files with unknown extensions', async () => {
    await touch(join(rootDir, 'readme.md'));
    await touch(join(rootDir, 'data.json'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(0);
  });

  it('should exclude node_modules by default', async () => {
    await touch(join(rootDir, 'node_modules', 'lib.ts'));
    await touch(join(rootDir, 'src', 'index.ts'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toContain('src');
  });

  it('should exclude .git by default', async () => {
    await touch(join(rootDir, '.git', 'hooks', 'pre-commit'));
    await touch(join(rootDir, 'main.ts'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(1);
  });

  it('should respect custom excludeGlobs', async () => {
    await touch(join(rootDir, 'vendor', 'third.ts'));
    await touch(join(rootDir, 'src', 'index.ts'));
    const result = await walkFiles({ rootDir, excludeGlobs: ['**/vendor/**'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toContain('src');
  });

  it('should respect includeGlobs to restrict to a subdirectory', async () => {
    await touch(join(rootDir, 'src', 'index.ts'));
    await touch(join(rootDir, 'other', 'util.ts'));
    const result = await walkFiles({ rootDir, includeGlobs: ['src/**'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toContain('src');
  });

  it('should respect the extensions filter', async () => {
    await touch(join(rootDir, 'main.ts'));
    await touch(join(rootDir, 'app.js'));
    const result = await walkFiles({ rootDir, extensions: ['.ts'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.language).toBe('typescript');
  });

  it('should return absolute paths', async () => {
    await touch(join(rootDir, 'index.ts'));
    const result = await walkFiles({ rootDir });
    expect(result[0]?.path.startsWith('/')).toBe(true);
  });

  it('should walk nested directories', async () => {
    await touch(join(rootDir, 'a', 'b', 'deep.ts'));
    const result = await walkFiles({ rootDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toContain('deep.ts');
  });
});
