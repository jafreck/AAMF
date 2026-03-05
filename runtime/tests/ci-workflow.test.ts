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

  it('should include Node.js 20.x in matrix', async () => {
    const text = await loadContent();
    expect(text).toContain('20.x');
  });

  it('should include Node.js 22.x in matrix', async () => {
    const text = await loadContent();
    expect(text).toContain('22.x');
  });

  it('should cache node_modules under runtime/', async () => {
    const text = await loadContent();
    expect(text).toContain('actions/cache');
    expect(text).toContain('runtime/node_modules');
  });

  it('should cache key based on package-lock.json hash', async () => {
    const text = await loadContent();
    expect(text).toContain('runtime/package-lock.json');
    expect(text).toContain('hashFiles');
  });

  it('should install dependencies with npm ci in runtime/ directory', async () => {
    const text = await loadContent();
    expect(text).toContain('npm ci');
    expect(text).toContain('working-directory: runtime');
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

describe('README.md CI badge', () => {
  let content: string;

  const loadContent = async () => {
    if (!content) {
      content = await readFile(join(repoRoot, 'README.md'), 'utf-8');
    }
    return content;
  };

  it('should contain a CI badge image', async () => {
    const text = await loadContent();
    expect(text).toMatch(/!\[CI\]/);
  });

  it('should reference ci.yml workflow in jafreck/AAMF', async () => {
    const text = await loadContent();
    expect(text).toContain('jafreck/AAMF');
    expect(text).toContain('ci.yml');
  });

  it('should have badge as a clickable link to workflow runs', async () => {
    const text = await loadContent();
    expect(text).toMatch(/\[!\[CI\]\(https:\/\/github\.com\/jafreck\/AAMF\/actions\/workflows\/ci\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/jafreck\/AAMF\/actions\/workflows\/ci\.yml\)/);
  });

  it('should place badge before the first --- separator', async () => {
    const text = await loadContent();
    const badgeIndex = text.indexOf('[![CI]');
    const firstSeparatorIndex = text.indexOf('\n---\n');
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(firstSeparatorIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeLessThan(firstSeparatorIndex);
  });

  it('should not have removed original README content', async () => {
    const text = await loadContent();
    expect(text).toContain('AAMF');
    expect(text).toContain('How It Works');
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

  it('should have a build script that builds runtime', async () => {
    const p = await loadPkg();
    expect(p.scripts.build).toContain('runtime');
    expect(p.scripts.build).not.toContain('lore');
  });

  it('should not chain multiple package builds with &&', async () => {
    const p = await loadPkg();
    expect(p.scripts.build).not.toContain('&&');
  });
});

describe('runtime/package.json devDependencies', () => {
  let pkg: Record<string, any>;

  const loadPkg = async () => {
    if (!pkg) {
      const text = await readFile(join(repoRoot, 'runtime', 'package.json'), 'utf-8');
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
