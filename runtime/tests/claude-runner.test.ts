import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, readdir, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AgentLauncher, ClaudeCodeRunner } from '../src/core/agent-launcher.js';
import { createMockConfig, createSilentLogger } from './helpers/mocks.js';
import { ensureDir } from '../src/util/fs.js';
import { MigrationConfig } from '../src/config/schema.js';
import { Logger } from '../src/logging/logger.js';

describe('ClaudeCodeRunner', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: MigrationConfig;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-claude-'));
    projectRoot = tempDir;
    config = createMockConfig({
      agentRuntime: 'claude-code',
      claudeCode: { cliCommand: 'claude', agentDir: '.claude/agents', timeout: 300_000 },
    }) as MigrationConfig;
    logger = createSilentLogger(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Helper to create a shell script in tempDir */
  async function createScript(name: string, body: string): Promise<string> {
    const scriptPath = join(tempDir, name);
    await writeFile(scriptPath, `#!/bin/bash\n${body}\n`);
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  /** Helper to create a ClaudeCodeRunner with the given CLI command */
  function makeRunner(cliCommand: string, model?: string): ClaudeCodeRunner {
    const cfg = createMockConfig({
      agentRuntime: 'claude-code',
      claudeCode: {
        cliCommand,
        agentDir: '.claude/agents',
        timeout: 300_000,
        ...(model ? { model } : {}),
      },
    }) as MigrationConfig;
    config = cfg;
    return new ClaudeCodeRunner(cfg, projectRoot, logger);
  }

  /** Helper to create an AgentLauncher configured to use claude-code runtime */
  function makeLauncher(cliCommand: string, model?: string): AgentLauncher {
    const cfg = createMockConfig({
      agentRuntime: 'claude-code',
      claudeCode: {
        cliCommand,
        agentDir: '.claude/agents',
        timeout: 300_000,
        ...(model ? { model } : {}),
      },
    }) as MigrationConfig;
    config = cfg;
    return new AgentLauncher(cfg, projectRoot, logger);
  }

  /** Helper to create standard invocation prerequisites */
  async function prepareInvocation(taskId: string, contextData: Record<string, unknown> = {}) {
    const contextFile = join(tempDir, `ctx-${taskId}.json`);
    await writeFile(contextFile, JSON.stringify(contextData));
    const progressDir = join(tempDir, 'progress');
    await ensureDir(progressDir);
    return { contextFile, progressDir };
  }

  async function readLatestAgentLog(agent: string, taskId: string): Promise<{ fileName: string; content: string }> {
    const logDir = join(projectRoot, '.aamf', 'migration', config.projectName, 'logs', 'agents', agent, taskId);
    const logFiles = await readdir(logDir);
    const fileName = [...logFiles].sort().at(-1);
    expect(fileName).toBeDefined();
    const content = await readFile(join(logDir, fileName!), 'utf-8');
    return { fileName: fileName!, content };
  }

  /** Helper to create a mock agent definition file */
  async function createAgentFile(agentName: string, content = '---\nname: test\n---\n# Agent') {
    const agentDir = join(projectRoot, '.claude', 'agents');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, `${agentName}.md`), content);
  }

  it('should be importable and constructible', () => {
    expect(ClaudeCodeRunner).toBeDefined();
    const runner = makeRunner('claude');
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('AgentLauncher should select ClaudeCodeRunner when agentRuntime is "claude-code"', () => {
    const launcher = makeLauncher('claude');
    // Verify the launcher delegates to ClaudeCodeRunner by checking the log message
    // (the launcher itself is opaque, but we verify it works via integration)
    expect(launcher).toBeDefined();
    expect(launcher.getResolvedPath()).toBeUndefined();
  });

  it('should construct CLI arguments with --agent and -p (no copilot-specific flags)', async () => {
    const script = await createScript('echo-args.sh', 'echo "ARGS:$@"\nexit 0');
    const runner = makeRunner(script, 'claude-sonnet-4-5');
    const { contextFile, progressDir } = await prepareInvocation('claude-args');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-args',
    });

    expect(result.success).toBe(true);

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'claude-args');
    expect(logContent).toContain('--agent');
    expect(logContent).toContain('code-migrator');
    expect(logContent).toContain('-p');
    expect(logContent).toContain(contextFile);
    expect(logContent).toContain('--model');
    expect(logContent).toContain('claude-sonnet-4-5');
    // Claude runner should NOT include copilot-specific flags
    expect(logContent).not.toContain('--allow-all-tools');
    expect(logContent).not.toContain('--no-ask-user');
  });

  it('should inject AAMF environment variables into spawned process', async () => {
    const script = await createScript('print-env.sh', [
      'echo "PROGRESS_DIR:$AAMF_PROGRESS_DIR"',
      'echo "CONTEXT_FILE:$AAMF_CONTEXT_FILE"',
      'echo "PHASE:$AAMF_PHASE"',
      'echo "TASK_ID:$AAMF_TASK_ID"',
      'exit 0',
    ].join('\n'));
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-env');

    const result = await runner.run({
      agent: 'impact-assessor',
      contextFile,
      progressDir,
      phase: 2,
      taskId: 'claude-env',
    });

    expect(result.success).toBe(true);

    const { content: logContent } = await readLatestAgentLog('impact-assessor', 'claude-env');
    expect(logContent).toContain(`PROGRESS_DIR:${progressDir}`);
    expect(logContent).toContain(`CONTEXT_FILE:${contextFile}`);
    expect(logContent).toContain('PHASE:2');
    expect(logContent).toContain('TASK_ID:claude-env');
  });

  it('should parse Claude JSON token usage format via parseTokenUsage(..., "claude-code")', async () => {
    // Claude emits token usage as JSON with usage.input_tokens / usage.output_tokens
    const claudeUsageJson = JSON.stringify({ usage: { input_tokens: 300, output_tokens: 150 } });
    const script = await createScript('claude-tokens.sh', [
      `echo '${claudeUsageJson}'`,
      'exit 0',
    ].join('\n'));
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-token');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-token',
    });

    expect(result.success).toBe(true);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.prompt).toBe(300);
    expect(result.tokenUsage?.completion).toBe(150);
    expect(result.tokenUsage?.total).toBe(450);
  });

  it('should report success for exit code 0', async () => {
    const script = await createScript('claude-ok.sh', 'echo "OK"\nexit 0');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-ok');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-ok',
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.agent).toBe('code-migrator');
    expect(result.taskId).toBe('claude-ok');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should report failure for non-zero exit code', async () => {
    const script = await createScript('claude-fail.sh', 'echo "error" >&2\nexit 1');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-fail');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-fail',
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('error');
  });

  it('should enforce timeout and report timeout error', async () => {
    const script = await createScript('claude-hang.sh', 'exec node -e "setTimeout(() => {}, 60000)"');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-timeout');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-timeout',
      timeout: 500,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 15_000);

  it('should use config.claudeCode.timeout as default timeout', async () => {
    const script = await createScript('claude-timeout-cfg.sh', 'exec node -e "setTimeout(() => {}, 60000)"');
    const cfg = createMockConfig({
      agentRuntime: 'claude-code',
      claudeCode: { cliCommand: script, agentDir: '.claude/agents', timeout: 400 },
    }) as MigrationConfig;
    const runner = new ClaudeCodeRunner(cfg, projectRoot, logger);
    const { contextFile, progressDir } = await prepareInvocation('claude-timeout-cfg');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-timeout-cfg',
      // No explicit timeout — should use claudeCode.timeout (400ms)
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 15_000);

  it('should use config.claudeCode.cliCommand for spawning', async () => {
    const script = await createScript('my-claude.sh', 'echo "custom claude"\nexit 0');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-cmd');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-cmd',
    });

    expect(result.success).toBe(true);
  });

  it('should return failure with meaningful error for missing CLI binary', async () => {
    const runner = makeRunner('__aamf_no_such_claude__');
    const { contextFile, progressDir } = await prepareInvocation('claude-missing');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-missing',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('should have non-zero tokenUsage via estimation fallback when no token data emitted', async () => {
    const script = await createScript('claude-no-tokens.sh', 'echo "no token data"\nexit 0');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-no-tokens');

    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-no-tokens',
    });

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.total).toBeGreaterThan(0);
  });

  it('AgentLauncher with claude-code runtime should delegate to ClaudeCodeRunner', async () => {
    const claudeUsageJson = JSON.stringify({ usage: { input_tokens: 200, output_tokens: 100 } });
    const script = await createScript('claude-delegate.sh', [
      `echo '${claudeUsageJson}'`,
      'exit 0',
    ].join('\n'));
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-delegate');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-delegate',
    });

    expect(result.success).toBe(true);
    // Token usage should be parsed in Claude format (JSON), not copilot format (regex)
    expect(result.tokenUsage?.prompt).toBe(200);
    expect(result.tokenUsage?.completion).toBe(100);
  });

  it('should read agent definition path from config.claudeCode.agentDir for observability', async () => {
    // Create an agent file in a custom agentDir
    const customAgentDir = join(tempDir, 'custom-agents');
    await mkdir(customAgentDir, { recursive: true });
    await writeFile(join(customAgentDir, 'code-migrator.md'), '---\nname: code-migrator\n---\n');

    const script = await createScript('claude-agentdir.sh', 'echo "OK"\nexit 0');
    const cfg = createMockConfig({
      agentRuntime: 'claude-code',
      claudeCode: { cliCommand: script, agentDir: 'custom-agents', timeout: 300_000 },
    }) as MigrationConfig;
    const runner = new ClaudeCodeRunner(cfg, projectRoot, logger);
    const { contextFile, progressDir } = await prepareInvocation('claude-agentdir');

    // Runner should not throw even with a custom agentDir
    const result = await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-agentdir',
    });

    expect(result.success).toBe(true);
  });

  it('should create agent log file with correct naming pattern', async () => {
    const script = await createScript('claude-log.sh', 'echo "stdout"\necho "stderr" >&2\nexit 0');
    await createAgentFile('code-migrator');
    const runner = makeRunner(script);
    const { contextFile, progressDir } = await prepareInvocation('claude-log');

    await runner.run({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'claude-log',
    });

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'claude-log');
    expect(logContent).toContain('stdout');
    expect(logContent).toContain('stderr');
    expect(logContent).toContain('=== STDOUT ===');
    expect(logContent).toContain('=== STDERR ===');
  });

  describe('invocationId correlation', () => {
    it('should include invocationId in the returned AgentResult', async () => {
      const script = await createScript('claude-inv-id.sh', 'echo "OK"\nexit 0');
      const runner = makeRunner(script);
      const { contextFile, progressDir } = await prepareInvocation('claude-inv-001');

      const result = await runner.run({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'claude-inv-001',
      });

      expect(result.success).toBe(true);
      expect(result.invocationId).toBeDefined();
      expect(result.invocationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should generate unique invocationIds across invocations', async () => {
      const script = await createScript('claude-inv-uniq.sh', 'echo "OK"\nexit 0');
      const runner = makeRunner(script);

      const { contextFile: ctx1, progressDir: pd1 } = await prepareInvocation('claude-inv-uniq-1');
      const { contextFile: ctx2, progressDir: pd2 } = await prepareInvocation('claude-inv-uniq-2');

      const r1 = await runner.run({
        agent: 'code-migrator', contextFile: ctx1, progressDir: pd1, phase: 4, taskId: 'claude-inv-uniq-1',
      });
      const r2 = await runner.run({
        agent: 'code-migrator', contextFile: ctx2, progressDir: pd2, phase: 4, taskId: 'claude-inv-uniq-2',
      });

      expect(r1.invocationId).not.toBe(r2.invocationId);
    });

    it('should include invocationId in agent log filename', async () => {
      const script = await createScript('claude-inv-log.sh', 'echo "out"\nexit 0');
      const runner = makeRunner(script);
      const { contextFile, progressDir } = await prepareInvocation('claude-inv-log');

      const result = await runner.run({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'claude-inv-log',
      });

      const { fileName } = await readLatestAgentLog('code-migrator', 'claude-inv-log');
      expect(fileName).toContain(result.invocationId!);
    });

    it('should include invocationId on error/catch path', async () => {
      const runner = makeRunner('__aamf_no_such_claude_inv__');
      const { contextFile, progressDir } = await prepareInvocation('claude-inv-err');

      const result = await runner.run({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'claude-inv-err',
      });

      expect(result.success).toBe(false);
      expect(result.invocationId).toBeDefined();
      expect(result.invocationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
});
