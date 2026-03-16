import { describe, it, expect } from 'vitest';
import {
  MigrationOrchestratorSchema,
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
} from '../../src/agents/registry.js';

const VALID_STATUS = 'completed' as const;

describe('Per-agent output schemas', () => {
  describe('MigrationOrchestratorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationOrchestratorSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('KnowledgeBuilderSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        KnowledgeBuilderSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('MigrationPlannerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationPlannerSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('AdjudicatorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        AdjudicatorSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('CodeMigratorSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        CodeMigratorSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('ParityVerifierSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        ParityVerifierSchema.parse({ status: VALID_STATUS, parity: 'pass' }),
      ).not.toThrow();
    });
  });

  describe('TestWriterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        TestWriterSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('ParityFailureResolverSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        ParityFailureResolverSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('FinalParityCheckerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        FinalParityCheckerSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('E2eTestCrafterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        E2eTestCrafterSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('DocumentationWriterSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        DocumentationWriterSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });

  describe('MigrationRunnerSchema', () => {
    it('accepts valid output', () => {
      expect(() =>
        MigrationRunnerSchema.parse({ status: VALID_STATUS }),
      ).not.toThrow();
    });
  });
});
