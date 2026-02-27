import { describe, it, expect } from 'vitest';
import {
  MigrationOrchestratorOutput,
  ImpactAssessorOutput,
  KnowledgeBuilderOutput,
  MigrationPlannerOutput,
  AdjudicatorOutput,
  CodeMigratorOutput,
  ParityVerifierOutput,
  TestWriterOutput,
  FailureRecoveryOutput,
  FinalParityCheckerOutput,
  E2eTestCrafterOutput,
  DocumentationWriterOutput,
  MigrationRunnerOutput,
} from '../src/agents/result-parser.js';

const VALID_STATUS = 'completed' as const;

describe('Per-agent output schemas', () => {
  describe('MigrationOrchestratorOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationOrchestratorOutput.parse({ status: VALID_STATUS, agent: 'migration-orchestrator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationOrchestratorOutput.parse({ status: VALID_STATUS, agent: 'impact-assessor' }),
      ).toThrow();
    });
  });

  describe('ImpactAssessorOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        ImpactAssessorOutput.parse({ status: VALID_STATUS, agent: 'impact-assessor' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        ImpactAssessorOutput.parse({ status: VALID_STATUS, agent: 'migration-orchestrator' }),
      ).toThrow();
    });
  });

  describe('KnowledgeBuilderOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        KnowledgeBuilderOutput.parse({ status: VALID_STATUS, agent: 'knowledge-builder' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        KnowledgeBuilderOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('MigrationPlannerOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationPlannerOutput.parse({ status: VALID_STATUS, agent: 'migration-planner' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationPlannerOutput.parse({ status: VALID_STATUS, agent: 'migration-runner' }),
      ).toThrow();
    });
  });

  describe('AdjudicatorOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        AdjudicatorOutput.parse({ status: VALID_STATUS, agent: 'adjudicator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        AdjudicatorOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('CodeMigratorOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        CodeMigratorOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        CodeMigratorOutput.parse({ status: VALID_STATUS, agent: 'adjudicator' }),
      ).toThrow();
    });
  });

  describe('ParityVerifierOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        ParityVerifierOutput.parse({ status: VALID_STATUS, agent: 'parity-verifier' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        ParityVerifierOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('TestWriterOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        TestWriterOutput.parse({ status: VALID_STATUS, agent: 'test-writer' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        TestWriterOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('FailureRecoveryOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        FailureRecoveryOutput.parse({ status: VALID_STATUS, agent: 'failure-recovery' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        FailureRecoveryOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('FinalParityCheckerOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        FinalParityCheckerOutput.parse({ status: VALID_STATUS, agent: 'final-parity-checker' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        FinalParityCheckerOutput.parse({ status: VALID_STATUS, agent: 'parity-verifier' }),
      ).toThrow();
    });
  });

  describe('E2eTestCrafterOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        E2eTestCrafterOutput.parse({ status: VALID_STATUS, agent: 'e2e-test-crafter' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        E2eTestCrafterOutput.parse({ status: VALID_STATUS, agent: 'test-writer' }),
      ).toThrow();
    });
  });

  describe('DocumentationWriterOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        DocumentationWriterOutput.parse({ status: VALID_STATUS, agent: 'documentation-writer' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        DocumentationWriterOutput.parse({ status: VALID_STATUS, agent: 'code-migrator' }),
      ).toThrow();
    });
  });

  describe('MigrationRunnerOutput', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationRunnerOutput.parse({ status: VALID_STATUS, agent: 'migration-runner' }),
      ).not.toThrow();
    });
    it('rejects wrong agent literal', () => {
      expect(() =>
        MigrationRunnerOutput.parse({ status: VALID_STATUS, agent: 'migration-planner' }),
      ).toThrow();
    });
  });
});
