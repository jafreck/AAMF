import { describe, it, expect } from 'vitest';
import { MigrationConfigSchema } from '../src/config/schema.js';

describe('MigrationConfigSchema', () => {
  const validConfig = {
    projectName: 'test-project',
    source: { path: './src', language: 'python' },
    target: { language: 'typescript', outputPath: './out' },
  };

  it('should accept minimal valid config', () => {
    const result = MigrationConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('should apply defaults', () => {
    const result = MigrationConfigSchema.parse(validConfig);
    expect(result.options.maxParallelAgents).toBe(3);
    expect(result.options.maxRetriesPerTask).toBe(3);
    expect(result.options.dryRun).toBe(false);
    expect(result.copilot.cliCommand).toBe('copilot');
    expect(result.copilot.timeout).toBe(300000);
  });

  it('should reject invalid project name', () => {
    const result = MigrationConfigSchema.safeParse({
      ...validConfig,
      projectName: 'Invalid Name!',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty project name', () => {
    const result = MigrationConfigSchema.safeParse({
      ...validConfig,
      projectName: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject parallelAgents > 10', () => {
    const result = MigrationConfigSchema.safeParse({
      ...validConfig,
      options: { maxParallelAgents: 20 },
    });
    expect(result.success).toBe(false);
  });

  it('should accept full config', () => {
    const full = {
      ...validConfig,
      source: { ...validConfig.source, entryPoints: ['main.py'], excludePatterns: ['venv'] },
      target: { ...validConfig.target, framework: 'express', testFramework: 'vitest' },
      options: { maxParallelAgents: 5, tokenBudget: 1000000 },
      copilot: { cliCommand: 'copilot', model: 'gpt-4o', agentDir: '.github/agents', timeout: 300000 },
    };
    const result = MigrationConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
  });
});
