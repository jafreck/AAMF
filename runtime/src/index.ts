import { Command } from 'commander';
import chalk from 'chalk';
import { MigrationRuntime } from './core/runtime.js';
import { IndexBuilder, LogLevel, LOG_LEVEL_NAMES } from '@aamf/lore';
import { KbServerProcess } from './core/kb-server-process.js';

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

// ─── index subcommand ─────────────────────────────────────────────────────────

const indexCmd = program.command('index').description('Knowledge-base indexing commands');

indexCmd
  .command('build')
  .description('Build the knowledge-base index from scratch')
  .requiredOption('--root <path>', 'Root directory of the source tree to index')
  .requiredOption('--db <path>', 'Path to the SQLite knowledge-base file')
  .action(async (opts) => {
    try {
      const builder = new IndexBuilder(opts.db, { rootDir: opts.root });
      await builder.build();
      console.log(chalk.green('Index build complete.'));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

indexCmd
  .command('update')
  .description('Incrementally update the knowledge-base index for changed files')
  .requiredOption('--db <path>', 'Path to the SQLite knowledge-base file')
  .requiredOption('--root <path>', 'Root directory of the source tree')
  .argument('[files...]', 'Changed file paths to re-process')
  .action(async (files: string[], opts) => {
    try {
      const builder = new IndexBuilder(opts.db, { rootDir: opts.root });
      await builder.update(files);
      console.log(chalk.green(`Index updated for ${files.length} file(s).`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// ─── kb-server subcommand ─────────────────────────────────────────────────────

program
  .command('kb-server')
  .description('Start the knowledge-base MCP server')
  .requiredOption('--db <path>', 'Path to the SQLite knowledge-base file')
  .option('--log-level <level>', 'Lore log level (debug|info|warn|error|silent)', 'debug')
  .option('--log-file <path>', 'Path to the Lore log file')
  .action(async (opts) => {
    const loreLoggerOpts = {
      level: LOG_LEVEL_NAMES[opts.logLevel] ?? LogLevel.DEBUG,
      ...(opts.logFile ? { logFile: opts.logFile } : {}),
    };
    const srv = new KbServerProcess(opts.db, undefined, undefined, loreLoggerOpts);
    try {
      await srv.start();
    } catch (err) {
      console.error(`Failed to start KB server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const cfg = srv.mcpConfig;
    console.log(JSON.stringify(cfg, null, 2));

    // Keep the CLI alive until the user sends SIGINT.
    process.on('SIGINT', async () => {
      await srv.stop();
      process.exit(0);
    });
  });

program.parse();

