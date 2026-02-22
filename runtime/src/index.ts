import { Command } from 'commander';
import chalk from 'chalk';
import { MigrationRuntime } from './core/runtime.js';

const program = new Command()
  .name('aamf')
  .description('Agent Architecture for Migration Framework — runtime')
  .version('0.1.0');

program
  .command('migrate')
  .description('Run a full migration')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .option('--resume', 'Resume from last checkpoint')
  .option('--dry-run', 'Validate config and produce plan only')
  .option('--phase <number>', 'Run only a specific phase', parseInt)
  .option('--log-level <level>', 'Log level (debug|info|warn|error)', 'info')
  .action(async (opts) => {
    try {
      const runtime = new MigrationRuntime();
      await runtime.initialize({
        configPath: opts.config,
        resume: opts.resume,
        dryRun: opts.dryRun,
        phase: opts.phase,
        logLevel: opts.logLevel,
      });
      const result = await runtime.run();
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
      if (err instanceof Error && err.stack) {
        console.error(chalk.gray(err.stack));
      }
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current migration status')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .action(async (opts) => {
    try {
      const runtime = new MigrationRuntime();
      await runtime.initialize({ configPath: opts.config });
      const status = await runtime.getStatus();
      console.log(status);
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program
  .command('reset')
  .description('Reset migration state (remove checkpoints)')
  .requiredOption('-c, --config <path>', 'Path to migration.config.json')
  .option('--phase <number>', 'Reset from a specific phase onward', parseInt)
  .action(async (opts) => {
    try {
      const runtime = new MigrationRuntime();
      await runtime.initialize({ configPath: opts.config });
      await runtime.reset(opts.phase);
      console.log(chalk.green('Migration state reset successfully.'));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program.parse();
