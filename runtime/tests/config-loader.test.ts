import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadConfig, applyOverrides } from '../src/config/loader.js';

describe('Config Loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const validConfig = {
    projectName: 'test-project',
    source: { path: './src', language: 'python' },
    target: { language: 'typescript', outputPath: './out' },
  };

  it('should load and parse a valid JSON config', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig(configPath);
    expect(config.projectName).toBe('test-project');
    expect(config.source.language).toBe('python');
    expect(config.target.language).toBe('typescript');
    expect(typeof config.source.path).toBe('string');
    expect(typeof config.target.outputPath).toBe('string');
  });

  it('should throw for a missing config file with "not found"', async () => {
    const missing = join(tempDir, 'nonexistent.json');
    await expect(loadConfig(missing)).rejects.toThrow(/not found/i);
  });

  it('should throw for invalid JSON syntax with "invalid JSON"', async () => {
    const configPath = join(tempDir, 'bad.json');
    await writeFile(configPath, '{broken json');
    await expect(loadConfig(configPath)).rejects.toThrow(/invalid JSON/i);
  });

  it('should throw with descriptive error for Zod validation failure', async () => {
    const configPath = join(tempDir, 'invalid.json');
    // Missing projectName
    await writeFile(configPath, JSON.stringify({
      source: { path: './src', language: 'python' },
      target: { language: 'typescript', outputPath: './out' },
    }));
    await expect(loadConfig(configPath)).rejects.toThrow(/Invalid configuration/i);
  });

  it('should resolve relative paths relative to config file directory', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig(configPath);
    expect(config.source.path).toBe(join(tempDir, 'src'));
    expect(config.target.outputPath).toBe(join(tempDir, 'out'));
  });

  it('should resolve copilot.agentDir relative to config file directory', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig(configPath);
    expect(config.copilot.agentDir).toBe(join(tempDir, '.github', 'agents'));
  });

  it('should resolve claudeCode.agentDir relative to config file directory', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig(configPath);
    expect(config.claudeCode.agentDir).toBe(join(tempDir, '.claude', 'agents'));
  });

  it('should resolve explicit claudeCode.agentDir relative to config file directory', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify({
      ...validConfig,
      claudeCode: { agentDir: './custom-agents' },
    }));

    const config = await loadConfig(configPath);
    expect(config.claudeCode.agentDir).toBe(join(tempDir, 'custom-agents'));
  });

  it('should merge overrides correctly with applyOverrides', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));
    const config = await loadConfig(configPath);

    const original = { ...config.options };
    const merged = applyOverrides(config, { dryRun: true });

    expect(merged.options.dryRun).toBe(true);
    // Original config should not be mutated
    expect(config.options.dryRun).toBe(original.dryRun);
  });

  it('should preserve original dryRun when override is undefined', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify({
      ...validConfig,
      options: { dryRun: true },
    }));
    const config = await loadConfig(configPath);

    const merged = applyOverrides(config, { dryRun: undefined });
    expect(merged.options.dryRun).toBe(true);
  });

  it('should apply default values for a minimal config', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig(configPath);
    expect(config.options.maxParallelAgents).toBe(3);
    expect(config.options.maxRetriesPerTask).toBe(3);
    expect(config.options.waveControl).toEqual({ waveSize: 3, maxConvergenceIterations: 3 });
    expect(config.copilot.timeout).toBe(300_000);
    expect(config.copilot.cliCommand).toBe('copilot');
  });

  it('should preserve wave execution options while resolving paths', async () => {
    const configPath = join(tempDir, 'migration.config.json');
    await writeFile(configPath, JSON.stringify({
      ...validConfig,
      source: { path: './relative-src', language: 'python' },
      target: { language: 'typescript', outputPath: './relative-out' },
      options: {
        executionMode: 'wave-barrier',
        waveControl: { waveSize: 4, maxConvergenceIterations: 6 },
      },
    }));

    const config = await loadConfig(configPath);
    expect(config.source.path).toBe(join(tempDir, 'relative-src'));
    expect(config.target.outputPath).toBe(join(tempDir, 'relative-out'));
    expect(config.options.executionMode).toBe('wave-barrier');
    expect(config.options.waveControl).toEqual({ waveSize: 4, maxConvergenceIterations: 6 });
  });
});
