import { join } from 'node:path';

export interface RuntimePaths {
  root: string;
  stateDir: string;
  checkpointFile: string;
  checkpointBackupFile: string;
  runManifestFile: string;
  logsRuntimeDir: string;
  migrationLogFile: string;
  logsAgentsDir: string;
  logsCommandsDir: string;
  logsCommandBuildDir: string;
  logsCommandTestDir: string;
  artifactsDir: string;
  artifactsContextsDir: string;
  artifactsResultsDir: string;
  artifactsPlanningDir: string;
  artifactsParityDir: string;
  artifactsAdjudicationDir: string;
  reportsDir: string;
  progressReportFile: string;
  reportsObservabilityDir: string;
  metricsDir: string;
  metricsInvocationsFile: string;
  metricsSummaryFile: string;
  kbDbFile: string;
}

export interface LegacyRuntimePaths {
  checkpointFile: string;
  checkpointBackupFile: string;
  contextsDir: string;
  resultsDir: string;
  planningDir: string;
  parityReportsDir: string;
  adjudicationDir: string;
  progressReportFile: string;
  migrationLogDir: string;
  migrationLogFile: string;
  impactAssessmentFile: string;
  knowledgeBaseDir: string;
  migrationPlanFile: string;
  competingStrategiesFile: string;
  finalParityReportFile: string;
  idiomaticReviewReportFile: string;
}

export function buildRuntimePaths(projectRoot: string, projectName: string): RuntimePaths {
  const root = join(projectRoot, '.aamf', 'migration', projectName);
  const stateDir = join(root, 'state');
  const logsRuntimeDir = join(root, 'logs', 'runtime');
  const logsAgentsDir = join(root, 'logs', 'agents');
  const logsCommandsDir = join(root, 'logs', 'commands');
  const artifactsDir = join(root, 'artifacts');
  const reportsDir = join(root, 'reports');
  const metricsDir = join(root, 'metrics');

  return {
    root,
    stateDir,
    checkpointFile: join(stateDir, 'checkpoint.json'),
    checkpointBackupFile: join(stateDir, 'checkpoint.backup.json'),
    runManifestFile: join(stateDir, 'run-manifest.json'),
    logsRuntimeDir,
    migrationLogFile: join(logsRuntimeDir, 'migration.log'),
    logsAgentsDir,
    logsCommandsDir,
    logsCommandBuildDir: join(logsCommandsDir, 'build'),
    logsCommandTestDir: join(logsCommandsDir, 'test'),
    artifactsDir,
    artifactsContextsDir: join(artifactsDir, 'contexts'),
    artifactsResultsDir: join(artifactsDir, 'results'),
    artifactsPlanningDir: join(artifactsDir, 'planning'),
    artifactsParityDir: join(artifactsDir, 'parity'),
    artifactsAdjudicationDir: join(artifactsDir, 'adjudication'),
    reportsDir,
    progressReportFile: join(reportsDir, 'progress.md'),
    reportsObservabilityDir: join(reportsDir, 'observability'),
    metricsDir,
    metricsInvocationsFile: join(metricsDir, 'invocations.jsonl'),
    metricsSummaryFile: join(metricsDir, 'summary.json'),
    kbDbFile: join(root, 'kb.db'),
  };
}

export function buildLegacyRuntimePaths(progressDir: string): LegacyRuntimePaths {
  return {
    checkpointFile: join(progressDir, 'checkpoint.json'),
    checkpointBackupFile: join(progressDir, 'checkpoint.backup.json'),
    contextsDir: join(progressDir, 'contexts'),
    resultsDir: join(progressDir, 'results'),
    planningDir: join(progressDir, 'planning'),
    parityReportsDir: join(progressDir, 'parity-reports'),
    adjudicationDir: join(progressDir, 'adjudication'),
    progressReportFile: join(progressDir, 'progress.md'),
    migrationLogDir: join(progressDir, 'logs'),
    migrationLogFile: join(progressDir, 'logs', 'migration.log'),
    impactAssessmentFile: join(progressDir, 'impact-assessment.md'),
    knowledgeBaseDir: join(progressDir, 'knowledge-base'),
    migrationPlanFile: join(progressDir, 'migration-plan.md'),
    competingStrategiesFile: join(progressDir, 'competing-strategies.md'),
    finalParityReportFile: join(progressDir, 'final-parity-report.md'),
    idiomaticReviewReportFile: join(progressDir, 'idiomatic-review-report.md'),
  };
}
