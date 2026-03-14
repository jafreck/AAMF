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
  logsCommandFormatDir: string;
  logsCommandLintDir: string;
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
  knowledgeBaseDir: string;
  dependencySummaryFile: string;
  migrationPlanFile: string;
  competingStrategiesFile: string;
  finalParityReportFile: string;
  idiomaticReviewReportFile: string;
  loreLogFile: string;
}

export function buildRuntimePaths(projectRoot: string, projectName: string): RuntimePaths {
  const root = join(projectRoot, '.aamf', 'migration', projectName);
  const stateDir = join(root, 'state');
  const logsRuntimeDir = join(root, 'logs', 'runtime');
  const logsAgentsDir = join(root, 'logs', 'agents');
  const logsCommandsDir = join(root, 'logs', 'commands');
  const artifactsDir = join(root, 'artifacts');
  const artifactsPlanningDir = join(artifactsDir, 'planning');
  const artifactsParityDir = join(artifactsDir, 'parity');
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
    logsCommandFormatDir: join(logsCommandsDir, 'format'),
    logsCommandLintDir: join(logsCommandsDir, 'lint'),
    artifactsDir,
    artifactsContextsDir: join(artifactsDir, 'contexts'),
    artifactsResultsDir: join(artifactsDir, 'results'),
    artifactsPlanningDir,
    artifactsParityDir,
    artifactsAdjudicationDir: join(artifactsDir, 'adjudication'),
    reportsDir,
    progressReportFile: join(reportsDir, 'progress.md'),
    reportsObservabilityDir: join(reportsDir, 'observability'),
    metricsDir,
    metricsInvocationsFile: join(metricsDir, 'invocations.jsonl'),
    metricsSummaryFile: join(metricsDir, 'summary.json'),
    kbDbFile: join(root, 'kb.db'),
    knowledgeBaseDir: join(root, 'knowledge-base'),
    dependencySummaryFile: join(artifactsPlanningDir, 'dependency-summary.json'),
    migrationPlanFile: join(artifactsPlanningDir, 'migration-plan.md'),
    competingStrategiesFile: join(artifactsPlanningDir, 'competing-strategies.md'),
    finalParityReportFile: join(artifactsParityDir, 'final-parity-report.md'),
    idiomaticReviewReportFile: join(artifactsParityDir, 'idiomatic-review-report.md'),
    loreLogFile: join(logsRuntimeDir, 'lore.log'),
  };
}
