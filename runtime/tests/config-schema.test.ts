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
    expect(result.options.buildConcurrency).toBe(1);
    expect(result.options.continueOnBlocked).toBe(true);
    expect(result.options.maxBlockedTasks).toBe(0);
    expect(result.options.maxInfraRetries).toBe(3);
    expect(result.options.avgTokensPerTask).toBe(5000);
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

  describe('Additional Validation', () => {
    it('should reject maxRetriesPerTask above 5', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { maxRetriesPerTask: 6 },
      });
      expect(result.success).toBe(false);
    });

    it('should reject maxRetriesPerTask of 0', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { maxRetriesPerTask: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('should reject maxParallelAgents of 0', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { maxParallelAgents: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('should accept empty source.path (string validation only)', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        source: { path: '', language: 'python' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject projectName with spaces', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        projectName: 'has space',
      });
      expect(result.success).toBe(false);
    });

    it('should reject projectName with uppercase', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        projectName: 'HasUppercase',
      });
      expect(result.success).toBe(false);
    });

    it('should reject projectName with underscores', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        projectName: 'has_underscore',
      });
      expect(result.success).toBe(false);
    });

    it('should strip unknown fields from parsed result', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        foo: 'bar',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>)['foo']).toBeUndefined();
      }
    });

    it('should reject buildConcurrency above 10', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { buildConcurrency: 11 },
      });
      expect(result.success).toBe(false);
    });

    it('should accept buildConcurrency of 0 (unlimited)', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { buildConcurrency: 0 },
      });
      expect(result.success).toBe(true);
    });

    it('should reject negative buildConcurrency', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { buildConcurrency: -1 },
      });
      expect(result.success).toBe(false);
    });

    it('should accept continueOnBlocked as false', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        options: { continueOnBlocked: false },
      });
      expect(result.options.continueOnBlocked).toBe(false);
    });

    it('should accept maxBlockedTasks', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        options: { maxBlockedTasks: 5 },
      });
      expect(result.options.maxBlockedTasks).toBe(5);
    });

    it('should reject maxInfraRetries above 10', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { maxInfraRetries: 11 },
      });
      expect(result.success).toBe(false);
    });

    it('should accept phaseTimeouts mapping phase numbers to ms values', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        copilot: { phaseTimeouts: { 1: 60000, 3: 120000 } },
      });
      expect(result.copilot.phaseTimeouts).toEqual({ 1: 60000, 3: 120000 });
    });

    it('should leave phaseTimeouts undefined when omitted', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.copilot.phaseTimeouts).toBeUndefined();
    });

    it('should default avgTokensPerTask to 5000 when omitted', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.options.avgTokensPerTask).toBe(5000);
    });

    it('should accept a custom avgTokensPerTask value', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        options: { avgTokensPerTask: 8000 },
      });
      expect(result.options.avgTokensPerTask).toBe(8000);
    });

    describe('idiomaticRefactor option', () => {
      it('should leave idiomaticRefactor undefined when omitted', () => {
        const result = MigrationConfigSchema.parse(validConfig);
        expect(result.options.idiomaticRefactor).toBeUndefined();
      });

      it('should default enabled to false and maxIterations to 2 when idiomaticRefactor is {}', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { idiomaticRefactor: {} },
        });
        expect(result.options.idiomaticRefactor?.enabled).toBe(false);
        expect(result.options.idiomaticRefactor?.maxIterations).toBe(2);
      });

      it('should accept idiomaticRefactor: { enabled: true, maxIterations: 3 }', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { idiomaticRefactor: { enabled: true, maxIterations: 3 } },
        });
        expect(result.options.idiomaticRefactor?.enabled).toBe(true);
        expect(result.options.idiomaticRefactor?.maxIterations).toBe(3);
      });
    });
  });
});
