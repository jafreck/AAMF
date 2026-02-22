import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  atomicWrite,
  ensureDir,
  fileExists,
  readJson,
  writeJson,
  listFiles,
  copyFile,
} from '../src/util/fs.js';

describe('fs utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-fs-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('atomicWrite', () => {
    it('should create file with correct content', async () => {
      const filePath = join(tempDir, 'test.txt');
      await atomicWrite(filePath, 'hello world');

      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('hello world');
    });

    it('should overwrite existing file', async () => {
      const filePath = join(tempDir, 'test.txt');
      await atomicWrite(filePath, 'first');
      await atomicWrite(filePath, 'second');

      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('second');
    });

    it('should create parent directories', async () => {
      const filePath = join(tempDir, 'a', 'b', 'c', 'file.txt');
      await atomicWrite(filePath, 'nested');

      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('nested');
    });

    it('should not leave temp files behind', async () => {
      const filePath = join(tempDir, 'clean.txt');
      await atomicWrite(filePath, 'content');

      const entries = await readdir(tempDir);
      const tmpFiles = entries.filter(e => e.startsWith('.tmp-'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('ensureDir', () => {
    it('should create nested directories', async () => {
      const dirPath = join(tempDir, 'a', 'b', 'c', 'd');
      await ensureDir(dirPath);

      const s = await stat(dirPath);
      expect(s.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      const dirPath = join(tempDir, 'idem');
      await ensureDir(dirPath);
      await ensureDir(dirPath);

      const s = await stat(dirPath);
      expect(s.isDirectory()).toBe(true);
    });
  });

  describe('fileExists', () => {
    it('should return true for existing file', async () => {
      const filePath = join(tempDir, 'exists.txt');
      await writeFile(filePath, 'data');

      expect(await fileExists(filePath)).toBe(true);
    });

    it('should return false for missing path', async () => {
      expect(await fileExists(join(tempDir, 'nope.txt'))).toBe(false);
    });
  });

  describe('readJson', () => {
    it('should parse JSON correctly', async () => {
      const filePath = join(tempDir, 'data.json');
      await writeFile(filePath, '{"a":1}');

      const result = await readJson<{ a: number }>(filePath);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe('writeJson', () => {
    it('should produce 2-space indented JSON with trailing newline', async () => {
      const filePath = join(tempDir, 'out.json');
      await writeJson(filePath, { b: 2 });

      const raw = await readFile(filePath, 'utf-8');
      expect(raw).toBe('{\n  "b": 2\n}\n');
    });
  });

  describe('listFiles', () => {
    it('should return file names', async () => {
      await writeFile(join(tempDir, 'a.txt'), '');
      await writeFile(join(tempDir, 'b.txt'), '');
      await writeFile(join(tempDir, 'c.txt'), '');

      const files = await listFiles(tempDir);
      expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'c.txt']));
      expect(files).toHaveLength(3);
    });

    it('should filter by extension', async () => {
      await writeFile(join(tempDir, 'a.ts'), '');
      await writeFile(join(tempDir, 'b.json'), '');
      await writeFile(join(tempDir, 'c.ts'), '');

      const tsFiles = await listFiles(tempDir, '.ts');
      expect(tsFiles).toEqual(expect.arrayContaining(['a.ts', 'c.ts']));
      expect(tsFiles).toHaveLength(2);
    });
  });

  describe('copyFile', () => {
    it('should copy content', async () => {
      const src = join(tempDir, 'source.txt');
      const dest = join(tempDir, 'dest.txt');
      await writeFile(src, 'copied content');

      await copyFile(src, dest);
      const content = await readFile(dest, 'utf-8');
      expect(content).toBe('copied content');
    });

    it('should create destination directory if missing', async () => {
      const src = join(tempDir, 'source2.txt');
      const dest = join(tempDir, 'nested', 'dir', 'dest2.txt');
      await writeFile(src, 'deep copy');

      await copyFile(src, dest);
      const content = await readFile(dest, 'utf-8');
      expect(content).toBe('deep copy');
    });
  });
});
