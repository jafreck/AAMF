import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('Release workflow (.github/workflows/release.yml)', () => {
  let content: string;

  const loadContent = async () => {
    if (!content) {
      content = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf-8');
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

  it('should trigger only on push events matching v* tags', async () => {
    const text = await loadContent();
    expect(text).toContain('push:');
    expect(text).toMatch(/tags:\s*\n\s+-\s+['"]?v\*/);
    expect(text).not.toContain('pull_request:');
    expect(text).not.toContain('branches:');
  });

  it('should use Node.js 20.x', async () => {
    const text = await loadContent();
    expect(text).toContain('20.x');
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

  it('should run type-check with npx tsc --noEmit before full build', async () => {
    const text = await loadContent();
    expect(text).toContain('npx tsc --noEmit');
    const typeCheckIdx = text.indexOf('npx tsc --noEmit');
    const buildIdx = text.indexOf('npx tsc\n');
    expect(typeCheckIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(typeCheckIdx).toBeLessThan(buildIdx);
  });

  it('should run unit tests with npx vitest run before build', async () => {
    const text = await loadContent();
    expect(text).toContain('npx vitest run');
    const testsIdx = text.indexOf('npx vitest run');
    const buildIdx = text.lastIndexOf('npx tsc');
    expect(testsIdx).toBeLessThan(buildIdx);
  });

  it('should build with npx tsc (emit output)', async () => {
    const text = await loadContent();
    // There must be a bare `npx tsc` (full build, not --noEmit)
    expect(text).toMatch(/npx tsc\n|npx tsc\r/);
  });

  it('should package runtime/dist/ into runtime-dist.tar.gz', async () => {
    const text = await loadContent();
    expect(text).toContain('runtime-dist.tar.gz');
    expect(text).toContain('runtime dist');
  });

  it('should create a GitHub Release using the pushed tag name', async () => {
    const text = await loadContent();
    expect(text).toContain('createRelease');
    expect(text).toContain('ref_name');
  });

  it('should enable generate-release-notes on the GitHub Release', async () => {
    const text = await loadContent();
    expect(text).toContain('generate_release_notes: true');
  });

  it('should upload runtime-dist.tar.gz as a release asset', async () => {
    const text = await loadContent();
    expect(text).toContain('uploadReleaseAsset');
    expect(text).toContain("'runtime-dist.tar.gz'");
  });

  it('should not set continue-on-error on any step', async () => {
    const text = await loadContent();
    expect(text).not.toContain('continue-on-error: true');
  });

  it('should have contents: write permission to create a release', async () => {
    const text = await loadContent();
    expect(text).toContain('contents: write');
  });
});
