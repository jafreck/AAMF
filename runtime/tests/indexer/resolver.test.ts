import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImportResolver } from '../../src/indexer/resolver.js';

// Helper to create a temporary directory with files for fs-based resolution tests
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
}

function writeFile(dir: string, relPath: string, content = ''): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('ImportResolver', () => {
  let resolver: ImportResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new ImportResolver();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  // ─── JavaScript / TypeScript ─────────────────────────────────────────────

  describe('JavaScript/TypeScript resolution', () => {
    it('should resolve a relative .ts import to an existing file', () => {
      const fromFile = writeFile(tmpDir, 'src/index.ts', '');
      const targetFile = writeFile(tmpDir, 'src/utils.ts', '');

      const result = resolver.resolve({ source: './utils', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(targetFile);
    });

    it('should resolve a relative .js import', () => {
      const fromFile = writeFile(tmpDir, 'src/index.js', '');
      const targetFile = writeFile(tmpDir, 'src/helper.js', '');

      const result = resolver.resolve({ source: './helper', importedNames: [] }, fromFile, tmpDir, 'javascript');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(targetFile);
    });

    it('should mark a bare specifier as external', () => {
      const fromFile = writeFile(tmpDir, 'src/index.ts', '');
      const result = resolver.resolve({ source: 'lodash', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('lodash');
    });

    it('should mark an unresolvable relative import as external', () => {
      const fromFile = writeFile(tmpDir, 'src/index.ts', '');
      const result = resolver.resolve({ source: './nonexistent', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(result.isExternal).toBe(true);
    });

    it('should use package.json to classify known external deps', () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({
        dependencies: { 'express': '^4.0.0' },
      }));
      const fromFile = writeFile(tmpDir, 'src/index.ts', '');
      const result = resolver.resolve({ source: 'express', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(result.isExternal).toBe(true);
    });

    it('should set rawSource on the result', () => {
      const fromFile = writeFile(tmpDir, 'src/index.ts', '');
      const result = resolver.resolve({ source: 'react', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(result.rawSource).toBe('react');
    });
  });

  // ─── Go ─────────────────────────────────────────────────────────────────

  describe('Go resolution', () => {
    it('should resolve an internal package import using go.mod', () => {
      writeFile(tmpDir, 'go.mod', 'module github.com/example/myapp\ngo 1.21\n');
      fs.mkdirSync(path.join(tmpDir, 'pkg/util'), { recursive: true });
      const fromFile = writeFile(tmpDir, 'main.go', '');

      const result = resolver.resolve(
        { source: 'github.com/example/myapp/pkg/util', importedNames: [] },
        fromFile,
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'pkg/util'));
    });

    it('should mark a third-party Go import as external', () => {
      writeFile(tmpDir, 'go.mod', 'module github.com/example/myapp\ngo 1.21\n');
      const fromFile = writeFile(tmpDir, 'main.go', '');

      const result = resolver.resolve(
        { source: 'github.com/gin-gonic/gin', importedNames: [] },
        fromFile,
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark stdlib imports as external when no go.mod match', () => {
      const fromFile = writeFile(tmpDir, 'main.go', '');
      const result = resolver.resolve(
        { source: 'fmt', importedNames: [] },
        fromFile,
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Python ─────────────────────────────────────────────────────────────

  describe('Python resolution', () => {
    it('should resolve an absolute module import to a .py file in rootDir', () => {
      writeFile(tmpDir, 'utils.py', '');
      const fromFile = writeFile(tmpDir, 'main.py', '');
      const result = resolver.resolve({ source: 'utils', importedNames: [] }, fromFile, tmpDir, 'python');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'utils.py'));
    });

    it('should resolve a relative import (.utils) to a sibling file', () => {
      writeFile(tmpDir, 'pkg/utils.py', '');
      const fromFile = writeFile(tmpDir, 'pkg/main.py', '');
      const result = resolver.resolve({ source: '.utils', importedNames: [] }, fromFile, tmpDir, 'python');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'pkg/utils.py'));
    });

    it('should mark an unresolvable python import as external', () => {
      const fromFile = writeFile(tmpDir, 'main.py', '');
      const result = resolver.resolve({ source: 'numpy', importedNames: [] }, fromFile, tmpDir, 'python');
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Rust ────────────────────────────────────────────────────────────────

  describe('Rust resolution', () => {
    it('should mark crate:: imports as internal (non-external) without a resolvedPath', () => {
      const fromFile = writeFile(tmpDir, 'src/main.rs', '');
      const result = resolver.resolve({ source: 'crate::utils', importedNames: [] }, fromFile, tmpDir, 'rust');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBeUndefined();
    });

    it('should mark self:: imports as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/main.rs', '');
      const result = resolver.resolve({ source: 'self::helper', importedNames: [] }, fromFile, tmpDir, 'rust');
      expect(result.isExternal).toBe(false);
    });

    it('should mark super:: imports as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/sub/mod.rs', '');
      const result = resolver.resolve({ source: 'super::config', importedNames: [] }, fromFile, tmpDir, 'rust');
      expect(result.isExternal).toBe(false);
    });

    it('should mark external crate imports as external', () => {
      const fromFile = writeFile(tmpDir, 'src/main.rs', '');
      const result = resolver.resolve({ source: 'serde', importedNames: [] }, fromFile, tmpDir, 'rust');
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Java ────────────────────────────────────────────────────────────────

  describe('Java resolution', () => {
    it('should resolve a Java import to a .java file under src/main/java', () => {
      const javaFile = writeFile(tmpDir, 'src/main/java/com/example/Foo.java', '');
      const fromFile = writeFile(tmpDir, 'src/main/java/com/example/Main.java', '');
      const result = resolver.resolve(
        { source: 'com.example.Foo', importedNames: ['Foo'] },
        fromFile,
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(javaFile);
    });

    it('should mark a Java import as external when no file found', () => {
      const fromFile = writeFile(tmpDir, 'src/Main.java', '');
      const result = resolver.resolve(
        { source: 'java.util.List', importedNames: ['List'] },
        fromFile,
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C# ─────────────────────────────────────────────────────────────────

  describe('C# resolution', () => {
    it('should mark all C# using directives as external (namespace, no file mapping)', () => {
      const fromFile = writeFile(tmpDir, 'Program.cs', '');
      const result = resolver.resolve(
        { source: 'System.Collections.Generic', importedNames: ['Generic'] },
        fromFile,
        tmpDir,
        'csharp',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C/C++ ───────────────────────────────────────────────────────────────

  describe('C/C++ resolution', () => {
    it('should resolve a quoted include to a file relative to fromFile', () => {
      const fromFile = writeFile(tmpDir, 'src/main.c', '');
      const headerFile = writeFile(tmpDir, 'src/utils.h', '');
      const result = resolver.resolve({ source: 'utils.h', importedNames: [] }, fromFile, tmpDir, 'c');
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(headerFile);
    });

    it('should mark angle-bracket includes as external', () => {
      const fromFile = writeFile(tmpDir, 'src/main.c', '');
      const result = resolver.resolve({ source: '<stdio.h>', importedNames: [] }, fromFile, tmpDir, 'c');
      expect(result.isExternal).toBe(true);
    });

    it('should work for cpp language too', () => {
      const fromFile = writeFile(tmpDir, 'src/main.cpp', '');
      const result = resolver.resolve({ source: '<vector>', importedNames: [] }, fromFile, tmpDir, 'cpp');
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Unknown language ────────────────────────────────────────────────────

  describe('Unknown language fallback', () => {
    it('should mark imports as external for unrecognised languages', () => {
      const fromFile = writeFile(tmpDir, 'file.xyz', '');
      const result = resolver.resolve({ source: 'some/module', importedNames: [] }, fromFile, tmpDir, 'cobol');
      expect(result.isExternal).toBe(true);
      expect(result.rawSource).toBe('some/module');
    });
  });
});
