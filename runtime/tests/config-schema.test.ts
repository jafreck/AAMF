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
    expect(result.options.executionMode).toBe('per-task');
    expect(result.options.waveControl?.waveSize).toBe(3);
    expect(result.options.waveControl?.maxConvergenceIterations).toBe(3);
    expect(result.options.continueOnBlocked).toBe(true);
    expect(result.options.maxBlockedTasks).toBe(1);
    expect(result.options.qualityPolicy).toBe('strict');
    expect(result.options.maxInfraRetries).toBe(3);
    expect(result.options.git?.enabled).toBe(true);
    expect(result.options.git?.autoInit).toBe(true);
    expect(result.options.git?.commitByAgent).toBe(true);
    expect(result.options.git?.commitPerTask).toBe(true);
    expect(result.options.git?.allowEmptyTaskCommits).toBe(true);
    expect(result.agentBackend.cliCommand).toBe('copilot');
    expect(result.agentBackend.timeout).toBe(300000);
    expect(result.agentBackend.failureRecoveryModel).toBeUndefined();
  });

  it('should accept git automation overrides', () => {
    const result = MigrationConfigSchema.parse({
      ...validConfig,
      options: {
        git: {
          enabled: false,
          autoInit: false,
          commitByAgent: false,
          commitPerTask: true,
          authorName: 'Custom Bot',
          authorEmail: 'custom@example.com',
        },
      },
    });

    expect(result.options.git?.enabled).toBe(false);
    expect(result.options.git?.autoInit).toBe(false);
    expect(result.options.git?.commitByAgent).toBe(false);
    expect(result.options.git?.commitPerTask).toBe(true);
    expect(result.options.git?.authorName).toBe('Custom Bot');
    expect(result.options.git?.authorEmail).toBe('custom@example.com');
  });

  it('should default allowEmptyTaskCommits to true', () => {
    const result = MigrationConfigSchema.parse(validConfig);
    expect(result.options.git?.allowEmptyTaskCommits).toBe(true);
  });

  it('should accept allowEmptyTaskCommits set to false', () => {
    const result = MigrationConfigSchema.parse({
      ...validConfig,
      options: {
        git: {
          allowEmptyTaskCommits: false,
        },
      },
    });
    expect(result.options.git?.allowEmptyTaskCommits).toBe(false);
  });

  it('should default git authorName and authorEmail', () => {
    const result = MigrationConfigSchema.parse(validConfig);
    expect(result.options.git?.authorName).toBe('AAMF Migration Bot');
    expect(result.options.git?.authorEmail).toBe('aamf@local.invalid');
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
      agentBackend: { runtime: 'copilot', cliCommand: 'copilot', model: 'gpt-4o', agentDir: '.github/agents', timeout: 300000 },
    };
    const result = MigrationConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  describe('Additional Validation', () => {
    it('should accept agentBackend.failureRecoveryModel override', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        agentBackend: { failureRecoveryModel: 'gpt-4.1' },
      });
      expect(result.agentBackend.failureRecoveryModel).toBe('gpt-4.1');
    });

    it('should accept agentBackend.failureRecoveryModel override for claude-code', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        agentBackend: { runtime: 'claude-code', failureRecoveryModel: 'claude-sonnet-4.5' },
      });
      expect(result.agentBackend.failureRecoveryModel).toBe('claude-sonnet-4.5');
    });

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

    it('should accept valid qualityPolicy values', () => {
      for (const qualityPolicy of ['strict', 'balanced', 'deferred-strict'] as const) {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { qualityPolicy },
        });
        expect(result.options.qualityPolicy).toBe(qualityPolicy);
      }
    });

    it('should reject invalid qualityPolicy values', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { qualityPolicy: 'lenient' },
      });
      expect(result.success).toBe(false);
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
        agentBackend: { phaseTimeouts: { 1: 60000, 3: 120000 } },
      });
      expect(result.agentBackend.phaseTimeouts).toEqual({ 1: 60000, 3: 120000 });
    });

    it('should leave phaseTimeouts undefined when omitted', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.agentBackend.phaseTimeouts).toBeUndefined();
    });

    it('should default keepArtifacts to false when omitted', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.options.keepArtifacts).toBe(false);
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

    it('should default agentBackend.runtime to copilot', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.agentBackend.runtime).toBe('copilot');
    });

    it('should accept agentBackend.runtime of claude-code', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        agentBackend: { runtime: 'claude-code' },
      });
      expect(result.agentBackend.runtime).toBe('claude-code');
    });

    it('should reject invalid agentBackend.runtime value', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        agentBackend: { runtime: 'openai' },
      });
      expect(result.success).toBe(false);
    });

    it('should apply agentBackend defaults for copilot runtime', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.agentBackend.runtime).toBe('copilot');
      expect(result.agentBackend.cliCommand).toBe('copilot');
      expect(result.agentBackend.agentDir).toBe('.github/agents');
      expect(result.agentBackend.timeout).toBe(300000);
      expect(result.agentBackend.model).toBeUndefined();
      expect(result.agentBackend.phaseTimeouts).toBeUndefined();
    });

    it('should apply agentBackend defaults for claude-code runtime', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        agentBackend: { runtime: 'claude-code' },
      });
      expect(result.agentBackend.runtime).toBe('claude-code');
      expect(result.agentBackend.cliCommand).toBe('claude');
      expect(result.agentBackend.agentDir).toBe('.claude/agents');
      expect(result.agentBackend.timeout).toBe(300000);
    });

    it('should accept explicit agentBackend config', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        agentBackend: {
          runtime: 'claude-code',
          cliCommand: 'claude',
          model: 'claude-sonnet-4-5',
          agentDir: '.claude/agents',
          timeout: 600000,
          phaseTimeouts: { 4: 120000 },
        },
      });
      expect(result.agentBackend.model).toBe('claude-sonnet-4-5');
      expect(result.agentBackend.timeout).toBe(600000);
    });

    it('should accept executionMode of wave-barrier', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        options: { executionMode: 'wave-barrier' },
      });
      expect(result.options.executionMode).toBe('wave-barrier');
      expect(result.options.waveControl).toEqual({ waveSize: 3, maxConvergenceIterations: 3 });
    });

    it('should reject invalid executionMode', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { executionMode: 'serial-wave' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject waveControl.waveSize less than 1', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { waveControl: { waveSize: 0 } },
      });
      expect(result.success).toBe(false);
    });

    it('should reject waveControl.maxConvergenceIterations less than 1', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        options: { waveControl: { maxConvergenceIterations: 0 } },
      });
      expect(result.success).toBe(false);
    });

    describe('modelRouting option', () => {
      it('should leave modelRouting undefined when omitted', () => {
        const result = MigrationConfigSchema.parse(validConfig);
        expect(result.options.modelRouting).toBeUndefined();
      });

      it('should default enabled to false when modelRouting is {}', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { modelRouting: {} },
        });
        expect(result.options.modelRouting?.enabled).toBe(false);
      });

      it('should default thresholds and caps correctly', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { modelRouting: {} },
        });
        const mr = result.options.modelRouting;
        expect(mr?.heavyThreshold).toBe(40);
        expect(mr?.criticalThreshold).toBe(70);
        expect(mr?.maxCriticalTasks).toBe(0);
        expect(mr?.maxEscalationCostUsd).toBe(0);
        expect(mr?.escalateOnRetryAttempt).toBe(2);
      });

      it('should accept modelRouting with enabled: true and heavyModel', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { modelRouting: { enabled: true, heavyModel: 'claude-opus-4.5' } },
        });
        expect(result.options.modelRouting?.enabled).toBe(true);
        expect(result.options.modelRouting?.heavyModel).toBe('claude-opus-4.5');
      });

      it('should accept criticalAgents as an array of strings', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { modelRouting: { criticalAgents: ['code-migrator', 'parity-verifier'] } },
        });
        expect(result.options.modelRouting?.criticalAgents).toEqual(['code-migrator', 'parity-verifier']);
      });

      it('should accept criticalTaskPatterns as an array of strings', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { modelRouting: { criticalTaskPatterns: ['task-00*'] } },
        });
        expect(result.options.modelRouting?.criticalTaskPatterns).toEqual(['task-00*']);
      });

    });

    describe('kbIndex option', () => {
      it('should leave kbIndex undefined when omitted', () => {
        const result = MigrationConfigSchema.parse(validConfig);
        expect(result.options.kbIndex).toBeUndefined();
      });

      it('should default kbIndex.enabled to false when kbIndex is {}', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { kbIndex: {} },
        });
        expect(result.options.kbIndex?.enabled).toBe(false);
      });

      it('should accept kbIndex: { enabled: true }', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { kbIndex: { enabled: true } },
        });
        expect(result.options.kbIndex?.enabled).toBe(true);
      });

      it('should accept kbIndex: { enabled: false } explicitly', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { kbIndex: { enabled: false } },
        });
        expect(result.options.kbIndex?.enabled).toBe(false);
      });

      it('should leave embeddings undefined when omitted from kbIndex', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { kbIndex: { enabled: true } },
        });
        expect(result.options.kbIndex?.embeddings).toBeUndefined();
      });

      it('should default embeddings.enabled to false when embeddings is {}', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: { kbIndex: { enabled: true, embeddings: {} } },
        });
        expect(result.options.kbIndex?.embeddings?.enabled).toBe(false);
      });

      it('should accept embeddings with all fields', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: {
            kbIndex: {
              enabled: true,
              embeddings: { enabled: true, model: 'BAAI/bge-small-en-v1.5', pythonBin: '/usr/bin/python3.11' },
            },
          },
        });
        const emb = result.options.kbIndex?.embeddings;
        expect(emb?.enabled).toBe(true);
        expect(emb?.model).toBe('BAAI/bge-small-en-v1.5');
        expect(emb?.pythonBin).toBe('/usr/bin/python3.11');
      });

      it('should default model to Qwen3-Embedding-0.6B and pythonBin to python3', () => {
        const result = MigrationConfigSchema.parse({
          ...validConfig,
          options: {
            kbIndex: { enabled: true, embeddings: { enabled: true } },
          },
        });
        const emb = result.options.kbIndex?.embeddings;
        expect(emb?.model).toBe('Qwen/Qwen3-Embedding-0.6B');
        expect(emb?.pythonBin).toBe('python3');
      });
    });
  });

  describe('Guidance', () => {
    it('should accept guidance as an array of strings', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        guidance: ['Do not use wrapper crates', 'Write native Rust code'],
      });
      expect(result.guidance).toEqual(['Do not use wrapper crates', 'Write native Rust code']);
    });

    it('should default guidance to undefined when omitted', () => {
      const result = MigrationConfigSchema.parse(validConfig);
      expect(result.guidance).toBeUndefined();
    });

    it('should reject guidance with empty strings', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        guidance: ['valid', ''],
      });
      expect(result.success).toBe(false);
    });

    it('should accept an empty guidance array', () => {
      const result = MigrationConfigSchema.parse({
        ...validConfig,
        guidance: [],
      });
      expect(result.guidance).toEqual([]);
    });

    it('should reject guidance when not an array', () => {
      const result = MigrationConfigSchema.safeParse({
        ...validConfig,
        guidance: 'single string',
      });
      expect(result.success).toBe(false);
    });
  });
});
