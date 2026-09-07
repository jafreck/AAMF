import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { e2eRuntimePaths, validateE2ePreflight } from './e2e.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function writeConfig(targetOutputPath = './target', projectName = 'preflight-test'): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'aamf-e2e-preflight-'));
  await mkdir(join(tempDir, 'source'), { recursive: true });
  const configPath = join(tempDir, 'migration.config.json');
  await writeFile(configPath, JSON.stringify({
    projectName,
    source: { path: './source', language: 'python' },
    target: { language: 'typescript', outputPath: targetOutputPath },
    agentBackend: { runtime: 'copilot', cliCommand: 'definitely-not-an-agent-cli' },
  }), 'utf8');
  return configPath;
}

describe('E2E preflight', () => {
  it('uses the production runtime path contract', () => {
    expect(e2eRuntimePaths('/project', 'demo')).toEqual(
      expect.objectContaining({
        checkpointFile: join('/project', '.aamf', 'migration', 'demo', 'state', 'checkpoint.json'),
        progressReportFile: join('/project', '.aamf', 'migration', 'demo', 'reports', 'progress.md'),
      }),
    );
  });

  it('accepts valid local paths before any runtime or agent is constructed', async () => {
    const configPath = await writeConfig();
    await expect(validateE2ePreflight({
      configPath,
      fixtureRoot: tempDir!,
      expectedProjectName: 'preflight-test',
      checkAgentCli: false,
    })).resolves.toEqual(expect.objectContaining({ projectName: 'preflight-test' }));
  });

  it('rejects a target path outside the fixture before checking the agent CLI', async () => {
    const configPath = await writeConfig('../outside');
    await expect(validateE2ePreflight({
      configPath,
      fixtureRoot: tempDir!,
      expectedProjectName: 'preflight-test',
    })).rejects.toThrow('target.outputPath must be inside the fixture root');
  });

  it('rejects a mismatched project identity', async () => {
    const configPath = await writeConfig('./target', 'actual-project');
    await expect(validateE2ePreflight({
      configPath,
      fixtureRoot: tempDir!,
      expectedProjectName: 'expected-project',
      checkAgentCli: false,
    })).rejects.toThrow('E2E project mismatch');
  });
});
