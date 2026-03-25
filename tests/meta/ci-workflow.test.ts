import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('CI workflow (.github/workflows/ci.yml)', () => {
  let content: string;

  const loadContent = async () => {
    if (!content) {
      content = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf-8');
    }
    return content;
  };

  it('should exist and be readable', async () => {
    const text = await loadContent();
    expect(text.length).toBeGreaterThan(0);
  });

  it('should be valid YAML (no tabs, proper structure)', async () => {
    const text = await loadContent();
    expect(text).not.toMatch(/\t/);
    expect(text).toContain('name:');
    expect(text).toContain('on:');
    expect(text).toContain('jobs:');
  });

  it('should trigger on push to main only', async () => {
    const text = await loadContent();
    expect(text).toContain("push:");
    // push should only target main, not all branches
    expect(text).not.toMatch(/branches:\s*\[['"]?\*\*['"]?\]/);
    expect(text).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it('should trigger on pull_request targeting main', async () => {
    const text = await loadContent();
    expect(text).toContain('pull_request:');
    expect(text).toMatch(/branches:\s*\[main\]/);
  });

  it('should not include Node.js 20.x in the build matrix (Lore requires >=22)', async () => {
    const text = await loadContent();
    // The build matrix should only contain 22.x.
    // A "Node.js 20.x" compat shim job may exist for branch protection,
    // but node-version: [20.x] must not appear in the matrix.
    expect(text).toMatch(/node-version:\s*\[22\.x\]/);
    expect(text).not.toMatch(/node-version:\s*\[.*20\.x/);
  });

  it('should include Node.js 22.x in matrix', async () => {
    const text = await loadContent();
    expect(text).toContain('22.x');
  });

  it('should cache node_modules', async () => {
    const text = await loadContent();
    expect(text).toContain('actions/cache');
    expect(text).toContain('node_modules');
  });

  it('should cache key based on package-lock.json hash', async () => {
    const text = await loadContent();
    expect(text).toContain('package-lock.json');
    expect(text).toContain('hashFiles');
  });

  it('should install dependencies with npm ci', async () => {
    const text = await loadContent();
    expect(text).toContain('npm ci');
  });

  it('should run type-check with npx tsc --noEmit', async () => {
    const text = await loadContent();
    expect(text).toContain('npx tsc --noEmit');
  });

  it('should run unit tests with npx vitest run', async () => {
    const text = await loadContent();
    expect(text).toContain('npx vitest run');
  });

  it('should run unit tests with coverage enabled', async () => {
    const text = await loadContent();
    expect(text).toContain('npx vitest run --coverage');
  });

  it('should not set AAMF_E2E environment variable in unit test step', async () => {
    const text = await loadContent();
    expect(text).not.toContain('AAMF_E2E');
  });
});



describe('Root package.json build script', () => {
  let pkg: Record<string, any>;

  const loadPkg = async () => {
    if (!pkg) {
      const text = await readFile(join(repoRoot, 'package.json'), 'utf-8');
      pkg = JSON.parse(text);
    }
    return pkg;
  };

  it('should have a build script that runs tsc', async () => {
    const p = await loadPkg();
    expect(p.scripts.build).toContain('tsc');
  });

  it('should not chain multiple package builds with &&', async () => {
    const p = await loadPkg();
    expect(p.scripts.build).not.toContain('&&');
  });
});

describe('package.json devDependencies', () => {
  let pkg: Record<string, any>;

  const loadPkg = async () => {
    if (!pkg) {
      const text = await readFile(join(repoRoot, 'package.json'), 'utf-8');
      pkg = JSON.parse(text);
    }
    return pkg;
  };

  it('should include @vitest/coverage-v8 in devDependencies', async () => {
    const p = await loadPkg();
    expect(p.devDependencies).toHaveProperty('@vitest/coverage-v8');
  });

  it('should include vitest in devDependencies', async () => {
    const p = await loadPkg();
    expect(p.devDependencies).toHaveProperty('vitest');
  });
});
