import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('MigrationOrchestrator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-orch-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should be importable', async () => {
    const { MigrationOrchestrator, MigrationError } = await import('../src/core/orchestrator.js');
    expect(MigrationOrchestrator).toBeDefined();
    expect(MigrationError).toBeDefined();
  });
});
