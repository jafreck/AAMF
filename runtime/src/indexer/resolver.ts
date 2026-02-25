/**
 * @module indexer/resolver
 *
 * Converts raw import strings extracted from source files into resolved file
 * paths (or marks them as external dependencies when resolution fails).
 *
 * Resolution strategies are language-specific.  When a manifest file
 * (package.json, go.mod, Cargo.toml) is present in the root directory its
 * declared dependencies are used as a fast-path to classify an import as
 * external without attempting disk access.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RawImport } from './extractors/types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResolvedImport {
  /** Original raw import string. */
  rawSource: string;
  /** Absolute resolved file path (present when the import maps to a project file). */
  resolvedPath?: string;
  /** True when the import is an external (third-party / stdlib) dependency. */
  isExternal: boolean;
  /** Name of the external package/module (same as rawSource for most languages). */
  externalName?: string;
}

// ─── ImportResolver ───────────────────────────────────────────────────────────

export class ImportResolver {
  /** Cache of parsed manifest dependency sets, keyed by rootDir. */
  private readonly manifestCache = new Map<string, Set<string>>();

  /**
   * Resolve a single raw import extracted from `fromFile`.
   *
   * @param rawImport   The import object produced by a SymbolExtractor.
   * @param fromFile    Absolute path of the file that contains the import.
   * @param rootDir     Absolute path to the project root directory.
   * @param language    Language identifier (e.g. `'typescript'`, `'go'`).
   */
  resolve(
    rawImport: RawImport,
    fromFile: string,
    rootDir: string,
    language: string,
  ): ResolvedImport {
    const source = rawImport.source;

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.resolveJs(source, fromFile, rootDir);

      case 'go':
        return this.resolveGo(source, fromFile, rootDir);

      case 'python':
        return this.resolvePython(source, fromFile, rootDir);

      case 'rust':
        return this.resolveRust(source, fromFile, rootDir);

      case 'java':
        return this.resolveJava(source, fromFile, rootDir);

      case 'csharp':
        return this.resolveCSharp(source, fromFile, rootDir);

      case 'c':
      case 'cpp':
        return this.resolveC(source, fromFile, rootDir);

      default:
        return this.markExternal(source);
    }
  }

  // ─── Language-specific strategies ────────────────────────────────────────

  private resolveJs(
    source: string,
    fromFile: string,
    rootDir: string,
  ): ResolvedImport {
    if (source.startsWith('.')) {
      // Relative import
      const resolved = this.resolveRelative(source, fromFile, [
        '',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '/index.ts',
        '/index.js',
      ]);
      if (resolved) return { rawSource: source, resolvedPath: resolved, isExternal: false };
      return this.markExternal(source);
    }

    // Absolute / bare specifier — check package.json
    const pkgDeps = this.parsePackageJson(rootDir);
    const pkgName = source.split('/')[0] ?? source;
    if (pkgDeps.has(pkgName) || pkgDeps.size === 0) {
      return this.markExternal(source);
    }

    // Could be a path alias or workspace package — fall back to external
    return this.markExternal(source);
  }

  private resolveGo(
    source: string,
    _fromFile: string,
    rootDir: string,
  ): ResolvedImport {
    const moduleName = this.parseGoMod(rootDir);

    if (moduleName && source.startsWith(moduleName)) {
      // Internal package: module/sub/pkg → rootDir/sub/pkg
      const rel = source.slice(moduleName.length).replace(/^\//, '');
      const candidate = path.join(rootDir, rel);
      if (this.dirExists(candidate)) {
        return { rawSource: source, resolvedPath: candidate, isExternal: false };
      }
    }

    return this.markExternal(source);
  }

  private resolvePython(
    source: string,
    fromFile: string,
    rootDir: string,
  ): ResolvedImport {
    if (source.startsWith('.')) {
      // Relative import (e.g. `.utils`, `..models`)
      const dots = source.match(/^\.+/)?.[0].length ?? 1;
      const modPath = source.slice(dots).replace(/\./g, '/');
      let base = path.dirname(fromFile);
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      const candidate = path.join(base, modPath.length ? modPath : '');
      const resolved = this.tryPythonModule(candidate);
      if (resolved) return { rawSource: source, resolvedPath: resolved, isExternal: false };
      return this.markExternal(source);
    }

    // Absolute — try to find in rootDir
    const candidate = path.join(rootDir, source.replace(/\./g, '/'));
    const resolved = this.tryPythonModule(candidate);
    if (resolved) return { rawSource: source, resolvedPath: resolved, isExternal: false };
    return this.markExternal(source);
  }

  private resolveRust(
    source: string,
    _fromFile: string,
    _rootDir: string,
  ): ResolvedImport {
    // `use crate::…` and `use self::…` are always internal but we cannot
    // resolve to a file path without walking the crate graph.
    if (source.startsWith('crate::') || source.startsWith('self::') || source.startsWith('super::')) {
      return { rawSource: source, isExternal: false };
    }
    return this.markExternal(source);
  }

  private resolveJava(
    source: string,
    _fromFile: string,
    rootDir: string,
  ): ResolvedImport {
    // Java imports are fully-qualified class names.
    // Try to find matching .java file under rootDir/src.
    const rel = source.replace(/\./g, '/') + '.java';
    for (const srcRoot of ['src/main/java', 'src', '']) {
      const candidate = path.join(rootDir, srcRoot, rel);
      if (this.fileExists(candidate)) {
        return { rawSource: source, resolvedPath: candidate, isExternal: false };
      }
    }
    return this.markExternal(source);
  }

  private resolveCSharp(
    source: string,
    _fromFile: string,
    _rootDir: string,
  ): ResolvedImport {
    // C# `using` directives are namespace identifiers, not file paths.
    // We cannot reliably map them to files without a project model.
    return this.markExternal(source);
  }

  private resolveC(
    source: string,
    fromFile: string,
    rootDir: string,
  ): ResolvedImport {
    // Quoted includes are relative; angle-bracket includes are system/external.
    if (!source.startsWith('<')) {
      const resolved =
        this.resolveRelative('./' + source, fromFile, ['']) ??
        this.resolveRelative('./' + source, rootDir + '/fake', ['']);
      if (resolved) return { rawSource: source, resolvedPath: resolved, isExternal: false };
    }
    return this.markExternal(source);
  }

  // ─── Manifest parsers ─────────────────────────────────────────────────────

  private parsePackageJson(rootDir: string): Set<string> {
    const cacheKey = `npm:${rootDir}`;
    if (this.manifestCache.has(cacheKey)) return this.manifestCache.get(cacheKey)!;

    const deps = new Set<string>();
    const pkgPath = path.join(rootDir, 'package.json');
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const obj = pkg[section];
        if (obj && typeof obj === 'object') {
          for (const name of Object.keys(obj as Record<string, unknown>)) {
            deps.add(name);
          }
        }
      }
    } catch {
      // No package.json or unreadable — treat all bare specifiers as external
    }

    this.manifestCache.set(cacheKey, deps);
    return deps;
  }

  private parseGoMod(rootDir: string): string | null {
    const cacheKey = `go:${rootDir}`;
    if (this.manifestCache.has(cacheKey)) {
      const cached = this.manifestCache.get(cacheKey)!;
      return cached.size > 0 ? [...cached][0]! : null;
    }

    let moduleName: string | null = null;
    const modPath = path.join(rootDir, 'go.mod');
    try {
      const raw = fs.readFileSync(modPath, 'utf8');
      const match = raw.match(/^module\s+(\S+)/m);
      if (match) moduleName = match[1] ?? null;
    } catch {
      // No go.mod
    }

    const set = new Set<string>();
    if (moduleName) set.add(moduleName);
    this.manifestCache.set(cacheKey, set);
    return moduleName;
  }

  /** Returns the set of crate names declared in Cargo.toml [dependencies]. */
  private parseCargoToml(rootDir: string): Set<string> {
    const cacheKey = `cargo:${rootDir}`;
    if (this.manifestCache.has(cacheKey)) return this.manifestCache.get(cacheKey)!;

    const deps = new Set<string>();
    const cargoPath = path.join(rootDir, 'Cargo.toml');
    try {
      const raw = fs.readFileSync(cargoPath, 'utf8');
      // Minimal TOML parsing: grab names from [dependencies] section lines
      let inDeps = false;
      for (const line of raw.split('\n')) {
        if (/^\[dependencies\]/.test(line)) { inDeps = true; continue; }
        if (/^\[/.test(line)) { inDeps = false; continue; }
        if (inDeps) {
          const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
          if (m) deps.add(m[1]!);
        }
      }
    } catch {
      // No Cargo.toml
    }

    this.manifestCache.set(cacheKey, deps);
    return deps;
  }

  // ─── Low-level helpers ────────────────────────────────────────────────────

  private resolveRelative(
    source: string,
    fromFile: string,
    extensions: string[],
  ): string | null {
    const base = path.resolve(path.dirname(fromFile), source);
    for (const ext of extensions) {
      const candidate = base + ext;
      if (this.fileExists(candidate)) return candidate;
    }
    return null;
  }

  private tryPythonModule(base: string): string | null {
    for (const suffix of ['.py', '/__init__.py']) {
      const candidate = base + suffix;
      if (this.fileExists(candidate)) return candidate;
    }
    return null;
  }

  private fileExists(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  private dirExists(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private markExternal(source: string): ResolvedImport {
    return { rawSource: source, isExternal: true, externalName: source };
  }
}
