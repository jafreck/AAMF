import { describe, it, expect } from 'vitest';
import {
  MigrationOrchestratorSchema,
  ImpactAssessorSchema,
  KnowledgeBuilderSchema,
  MigrationPlannerSchema,
  AdjudicatorSchema,
  CodeMigratorSchema,
  ParityVerifierSchema,
  TestWriterSchema,
  ParityFailureResolverSchema,
  FinalParityCheckerSchema,
  E2eTestCrafterSchema,
  DocumentationWriterSchema,
  MigrationRunnerSchema,
} from '../src/agents/registry.js';

const VALID_STATUS = 'completed' as const;

describe('Per-agent output schemas', () => {
  describe('MigrationOrchestratorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationOrchestratorSchema.parse({ status: VALID_STATUS, agent: 'migration-orchestrator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationOrchestratorSchema.parse({ status: VALID_STATUS, agent: 'impact-assessor' }),
      ).toThrow();
    });
  });

  describe('ImpactAssessorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        ImpactAssessorSchema.parse({ status: VALID_STATUS, agent: 'impact-assessor' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        ImpactAssessorSchema.parse({ status: VALID_STATUS, agent: 'migration-orchestrator' }),
      ).toThrow();
    });
  });

  describe('KnowledgeBuilderSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        KnowledgeBuilderSchema.parse({ status: VALID_STATUS, agent: 'knowledge-builder' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        KnowledgeBuilderSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('MigrationPlannerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationPlannerSchema.parse({ status: VALID_STATUS, agent: 'migration-planner' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationPlannerSchema.parse({ status: VALID_STATUS, agent: 'migration-runner' }),
      ).toThrow();
    });
  });

  describe('AdjudicatorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        AdjudicatorSchema.parse({ status: VALID_STATUS, agent: 'adjudicator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        AdjudicatorSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('CodeMigratorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        CodeMigratorSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        CodeMigratorSchema.parse({ status: VALID_STATUS, agent: 'adjudicator' }),
      ).toThrow();
    });
  });

  describe('ParityVerifierSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        ParityVerifierSchema.parse({ status: VALID_STATUS, agent: 'parity-verifier', parity: 'pass' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        ParityVerifierSchema.parse({ status: VALID_STATUS, agent: 'code-migrator', parity: 'pass' }),
      ).toThrow();
    });
  });

  describe('TestWriterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        TestWriterSchema.parse({ status: VALID_STATUS, agent: 'test-writer' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        TestWriterSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('ParityFailureResolverSchema', () => {
    it('accepts canonical parity-failure-resolver output', () => {
      expect(() =>
        ParityFailureResolverSchema.parse({ status: VALID_STATUS, agent: 'parity-failure-resolver' }),
      ).not.toThrow();
    });

    it('accepts legacy failure-recovery output for compatibility', () => {
      expect(() =>
        ParityFailureResolverSchema.parse({ status: VALID_STATUS, agent: 'failure-recovery' }),
      ).not.toThrow();
    });

    it('rejects wrong agent literal', () => {
      expect(() =>
        ParityFailureResolverSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('FinalParityCheckerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        FinalParityCheckerSchema.parse({ status: VALID_STATUS, agent: 'final-parity-checker' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        FinalParityCheckerSchema.parse({ status: VALID_STATUS, agent: 'parity-verifier' }),
      ).toThrow();
    });
  });

  describe('E2eTestCrafterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        E2eTestCrafterSchema.parse({ status: VALID_STATUS, agent: 'e2e-test-crafter' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        E2eTestCrafterSchema.parse({ status: VALID_STATUS, agent: 'test-writer' }),
      ).toThrow();
    });
  });

  describe('DocumentationWriterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        DocumentationWriterSchema.parse({ status: VALID_STATUS, agent: 'documentation-writer' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        DocumentationWriterSchema.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('MigrationRunnerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationRunnerSchema.parse({ status: VALID_STATUS, agent: 'migration-runner' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationRunnerSchema.parse({ status: VALID_STATUS, agent: 'migration-planner' }),
      ).toThrow();
    });
  });
});
