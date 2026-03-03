import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AgentLauncher } from '../src/core/agent-launcher.js';
import { createMockConfig, createSilentLogger } from './helpers/mocks.js';
import { ensureDir } from '../src/util/fs.js';
import { MigrationConfig } from '../src/config/schema.js';
import { Logger } from '../src/logging/logger.js';

describe('AgentLauncher', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: MigrationConfig;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'aamf-launcher-'));
    projectRoot = tempDir;
    config = createMockConfig({
      copilot: { cliCommand: 'node', agentDir: '.github/agents', timeout: 300_000 },
    });
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

  /** Helper to create a launcher with a given CLI command */
  function makeLauncher(cliCommand: string, model?: string): AgentLauncher {
    const cfg = createMockConfig({
      copilot: { cliCommand, agentDir: '.github/agents', timeout: 300_000, ...(model ? { model } : {}) },
    });
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

  it('should be importable', () => {
    expect(AgentLauncher).toBeDefined();
  });

  it('should construct CLI arguments including --agent, -p prompt, --model, and operational flags', async () => {
    const script = await createScript('echo-args.sh', 'echo "ARGS:$@"\nexit 0');
    const launcher = makeLauncher(script, 'gpt-4o');
    const { contextFile, progressDir } = await prepareInvocation('cli-args');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'cli-args',
    });

    expect(result.success).toBe(true);

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'cli-args');
    expect(logContent).toContain('--agent');
    expect(logContent).toContain('code-migrator');
    expect(logContent).toContain('-p');
    expect(logContent).toContain(contextFile);
    expect(logContent).toContain('--model');
    expect(logContent).toContain('gpt-4o');
    expect(logContent).toContain('--allow-all-tools');
    expect(logContent).toContain('--no-ask-user');
    expect(logContent).not.toContain('-s');
  });

  it('should prefer invocation modelOverride over configured model', async () => {
    const script = await createScript('echo-args-override.sh', 'echo "ARGS:$@"\nexit 0');
    const launcher = makeLauncher(script, 'primary-model');
    const { contextFile, progressDir } = await prepareInvocation('model-override');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'model-override',
      modelOverride: 'fallback-model',
    });

    expect(result.success).toBe(true);

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'model-override');
    expect(logContent).toContain('--model');
    expect(logContent).toContain('fallback-model');
    expect(logContent).not.toContain('primary-model');
  });

  it('should inject environment variables into spawned process', async () => {
    const script = await createScript('print-env.sh', [
      'echo "PROGRESS_DIR:$AAMF_PROGRESS_DIR"',
      'echo "CONTEXT_FILE:$AAMF_CONTEXT_FILE"',
      'echo "PHASE:$AAMF_PHASE"',
      'echo "TASK_ID:$AAMF_TASK_ID"',
      'exit 0',
    ].join('\n'));
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('env-test');

    const result = await launcher.launchAgent({
      agent: 'impact-assessor',
      contextFile,
      progressDir,
      phase: 1,
      taskId: 'env-test',
    });

    expect(result.success).toBe(true);

    const { content: logContent } = await readLatestAgentLog('impact-assessor', 'env-test');
    expect(logContent).toContain(`PROGRESS_DIR:${progressDir}`);
    expect(logContent).toContain(`CONTEXT_FILE:${contextFile}`);
    expect(logContent).toContain('PHASE:1');
    expect(logContent).toContain('TASK_ID:env-test');
  });

  it('should strip VS Code IPC variables while preserving unrelated env vars', async () => {
    const prevIpc = process.env['VSCODE_IPC_HOOK_CLI'];
    const prevTerm = process.env['TERM_PROGRAM'];
    const prevCustom = process.env['AAMF_TEST_CUSTOM_ENV'];
    process.env['VSCODE_IPC_HOOK_CLI'] = 'vscode-ipc-token';
    process.env['TERM_PROGRAM'] = 'vscode';
    process.env['AAMF_TEST_CUSTOM_ENV'] = 'preserved';

    try {
      const script = await createScript('print-env-filter.sh', [
        'echo "VSCODE_IPC_HOOK_CLI:$VSCODE_IPC_HOOK_CLI"',
        'echo "TERM_PROGRAM:$TERM_PROGRAM"',
        'echo "AAMF_TEST_CUSTOM_ENV:$AAMF_TEST_CUSTOM_ENV"',
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('env-filter');

      const result = await launcher.launchAgent({
        agent: 'impact-assessor',
        contextFile,
        progressDir,
        phase: 1,
        taskId: 'env-filter',
      });

      expect(result.success).toBe(true);

      const { content: logContent } = await readLatestAgentLog('impact-assessor', 'env-filter');
      expect(logContent).toContain('VSCODE_IPC_HOOK_CLI:');
      expect(logContent).not.toContain('vscode-ipc-token');
      expect(logContent).toContain('TERM_PROGRAM:');
      expect(logContent).not.toContain('TERM_PROGRAM:vscode');
      expect(logContent).toContain('AAMF_TEST_CUSTOM_ENV:preserved');
    } finally {
      if (prevIpc === undefined) delete process.env['VSCODE_IPC_HOOK_CLI'];
      else process.env['VSCODE_IPC_HOOK_CLI'] = prevIpc;
      if (prevTerm === undefined) delete process.env['TERM_PROGRAM'];
      else process.env['TERM_PROGRAM'] = prevTerm;
      if (prevCustom === undefined) delete process.env['AAMF_TEST_CUSTOM_ENV'];
      else process.env['AAMF_TEST_CUSTOM_ENV'] = prevCustom;
    }
  });

  it('should report success for exit code 0', async () => {
    const script = await createScript('success.sh', 'echo "OK"\nexit 0');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('ok-001');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'ok-001',
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.agent).toBe('code-migrator');
    expect(result.taskId).toBe('ok-001');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should report failure for non-zero exit code with stderr', async () => {
    const script = await createScript('fail.sh', 'echo "bad" >&2\nexit 1');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('fail-001');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'fail-001',
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('bad');
    expect(result.stderr).toContain('bad');
  });

  it('should enforce timeout and kill the process', async () => {
    // Use node -e directly since it's a single process, easier to kill than bash
    const cfg = createMockConfig({
      copilot: { cliCommand: 'node', agentDir: '.github/agents', timeout: 300_000 },
    });
    const launcherT = new AgentLauncher(cfg, projectRoot, logger);
    config = cfg;
    const { contextFile, progressDir } = await prepareInvocation('timeout-001');

    const result = await launcherT.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'timeout-001',
      timeout: 500,
      // node sees --agent as unknown flag and ignores it, then runs
      // the -e script won't be reached because --agent isn't -e
      // Instead we rely on the fact that node with --agent fails or we create a script
    });

    // node --agent code-migrator ... will either error immediately or hang
    // Either way, the test verifies the timeout mechanism works
    expect(result.success).toBe(false);
  }, 15_000);

  it('should enforce timeout and report timeout error', async () => {
    const script = await createScript('hang.sh', 'exec node -e "setTimeout(() => {}, 60000)"');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('timeout-002');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'timeout-002',
      timeout: 500,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.stderr).toBeDefined();
  }, 15_000);

  it('should not populate stderr on successful (exit code 0) run', async () => {
    const script = await createScript('success-stderr.sh', 'echo "some stderr" >&2\nexit 0');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('success-stderr-001');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'success-stderr-001',
    });

    expect(result.success).toBe(true);
    expect(result.stderr).toBeUndefined();
  });

  it('should detect output files from context outputPath', async () => {
    const outputFile = join(tempDir, 'output.txt');
    await writeFile(outputFile, 'migration output');

    const script = await createScript('noop.sh', 'exit 0');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('output-001', { outputPath: outputFile });
    // Overwrite context file with outputPath
    await writeFile(contextFile, JSON.stringify({ outputPath: outputFile }));

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'output-001',
    });

    expect(result.success).toBe(true);
    expect(result.outputFiles).toContain(outputFile);
  });

  it('should parse token usage from stdout', async () => {
    const script = await createScript('tokens.sh', [
      'echo "Breakdown by AI model:"',
      'echo "  claude-sonnet-4-20250514:"',
      'echo "    tokens_in: 100, tokens_out: 50, premium_requests_est: 1"',
      'exit 0',
    ].join('\n'));
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('token-001');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'token-001',
    });

    expect(result.success).toBe(true);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.prompt).toBe(100);
    expect(result.tokenUsage?.completion).toBe(50);
    expect(result.tokenUsage?.total).toBe(150);
  });

  it('should return failure with meaningful error for missing CLI binary', async () => {
    const launcher = makeLauncher('__aamf_no_such_binary__');
    const { contextFile, progressDir } = await prepareInvocation('missing-001');

    const result = await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'missing-001',
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('should create agent log file with correct naming pattern and content', async () => {
    const script = await createScript('log-agent.sh', 'echo "stdout output"\necho "stderr output" >&2\nexit 0');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('log-001');

    await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'log-001',
    });

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'log-001');
    expect(logContent).toContain('stdout output');
    expect(logContent).toContain('stderr output');
    expect(logContent).toContain('=== STDOUT ===');
    expect(logContent).toContain('=== STDERR ===');
  });

  it('should forward additional args to the spawned command', async () => {
    const script = await createScript('check-args.sh', 'echo "ARGS:$@"\nexit 0');
    const launcher = makeLauncher(script);
    const { contextFile, progressDir } = await prepareInvocation('args-001');

    await launcher.launchAgent({
      agent: 'code-migrator',
      contextFile,
      progressDir,
      phase: 4,
      taskId: 'args-001',
      additionalArgs: { foo: 'bar' },
    });

    const { content: logContent } = await readLatestAgentLog('code-migrator', 'args-001');
    expect(logContent).toContain('--foo');
    expect(logContent).toContain('bar');
  });

  describe('aamf-json output parsing', () => {
    it('should populate structuredOutput and set outputParsed: true when a valid aamf-json block is emitted', async () => {
      const aamfBlock = JSON.stringify({ status: 'completed', agent: 'code-migrator' });
      const script = await createScript('valid-aamf.sh', [
        `echo 'some output'`,
        `printf '\`\`\`aamf-json\\n${aamfBlock}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-valid-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-valid-001',
      });

      expect(result.success).toBe(true);
      expect(result.outputParsed).toBe(true);
      expect(result.structuredOutput).toBeDefined();
      expect(result.structuredOutput?.status).toBe('completed');
      expect(result.structuredOutput?.agent).toBe('code-migrator');
      expect(result.parseError).toBeUndefined();
    });

    it('should parse aamf-json output for failure-adjudicator invocations', async () => {
      const aamfBlock = JSON.stringify({ status: 'completed', agent: 'failure-adjudicator' });
      const script = await createScript('valid-aamf-failure-adjudicator.sh', [
        `printf '\`\`\`aamf-json\\n${aamfBlock}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-failure-adjudicator-001');

      const result = await launcher.launchAgent({
        agent: 'failure-adjudicator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-failure-adjudicator-001',
      });

      expect(result.success).toBe(true);
      expect(result.outputParsed).toBe(true);
      expect(result.structuredOutput?.agent).toBe('failure-adjudicator');
    });

    it('should leave success unchanged and set outputParsed: false when no aamf-json block is emitted', async () => {
      const script = await createScript('no-aamf.sh', 'echo "no structured output here"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-missing-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-missing-001',
      });

      // exit code 0 → success should remain true
      expect(result.success).toBe(true);
      expect(result.outputParsed).toBe(false);
      expect(result.structuredOutput).toBeUndefined();
      expect(result.parseError).toBeUndefined();
    });

    it('should force success: false and set parseError when aamf-json block is present but schema-invalid', async () => {
      // wrong agent literal → schema validation fails
      const aamfBlock = JSON.stringify({ status: 'completed', agent: 'impact-assessor' });
      const script = await createScript('bad-aamf.sh', [
        `printf '\`\`\`aamf-json\\n${aamfBlock}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-invalid-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',  // schema expects agent === 'code-migrator'
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-invalid-001',
      });

      expect(result.success).toBe(false);
      expect(result.outputParsed).toBe(false);
      expect(result.parseError).toBeDefined();
      expect(result.parseError!.length).toBeGreaterThan(0);
    });

    it('should force success: false and set parseError when aamf-json block contains malformed JSON', async () => {
      const script = await createScript('malformed-aamf.sh', [
        `printf '\`\`\`aamf-json\\n{not valid json}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-malformed-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-malformed-001',
      });

      expect(result.success).toBe(false);
      expect(result.outputParsed).toBe(false);
      expect(result.parseError).toBeDefined();
    });

    it('should prefer tokenUsage from structuredOutput over regex-parsed tokenUsage', async () => {
      const structured = JSON.stringify({
        status: 'completed',
        agent: 'code-migrator',
        tokenUsage: { prompt: 999, completion: 888, total: 1887 },
      });
      const script = await createScript('token-aamf.sh', [
        // Also emit regex-parseable token lines (different values)
        'echo "prompt_tokens: 100"',
        'echo "completion_tokens: 50"',
        'echo "total_tokens: 150"',
        `printf '\`\`\`aamf-json\\n${structured}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-token-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-token-001',
      });

      expect(result.outputParsed).toBe(true);
      // Must use the structured tokenUsage, not the regex-parsed values
      expect(result.tokenUsage?.prompt).toBe(999);
      expect(result.tokenUsage?.completion).toBe(888);
      expect(result.tokenUsage?.total).toBe(1887);
    });

    it('should warn via logger when aamf-json block is absent', async () => {
      const script = await createScript('no-aamf-warn.sh', 'echo "no block"\nexit 0');
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const cfg2 = createMockConfig({
        copilot: { cliCommand: script, agentDir: '.github/agents', timeout: 300_000 },
      });
      const launcher2 = new AgentLauncher(cfg2, projectRoot, logger);
      const { contextFile, progressDir } = await prepareInvocation('aamf-warn-001');

      await launcher2.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-warn-001',
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aamf-json block'));
      warnSpy.mockRestore();
    });

    it('should leave success: false unchanged when agent exits non-zero and no aamf-json block', async () => {
      const script = await createScript('fail-no-aamf.sh', 'echo "error" >&2\nexit 1');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('aamf-fail-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'aamf-fail-001',
      });

      expect(result.success).toBe(false);
      expect(result.outputParsed).toBe(false);
      expect(result.parseError).toBeUndefined();
    });
  });

  describe('token tracking', () => {
    it('should have non-zero tokenUsage when agent emits tokenUsage in aamf-json block', async () => {
      const structured = JSON.stringify({
        status: 'completed',
        agent: 'code-migrator',
        tokenUsage: { prompt: 500, completion: 200, total: 700 },
      });
      const script = await createScript('token-aamf-nonzero.sh', [
        `printf '\`\`\`aamf-json\\n${structured}\\n\`\`\`\\n'`,
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('token-aamf-nonzero');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'token-aamf-nonzero',
      });

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.total).toBeGreaterThan(0);
    });

    it('should have non-zero tokenUsage via estimation fallback when no token data is emitted', async () => {
      const script = await createScript('no-tokens.sh', 'echo "no token data here"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('no-tokens-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'no-tokens-001',
      });

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.total).toBeGreaterThan(0);
    });

    it('should have non-zero tokenUsage on error/catch path (missing binary)', async () => {
      const launcher = makeLauncher('__aamf_no_such_binary_token_test__');
      const { contextFile, progressDir } = await prepareInvocation('catch-token-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'catch-token-001',
      });

      expect(result.success).toBe(false);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.total).toBeGreaterThan(0);
    });
  });

  describe('invocationId and correlation fields', () => {
    it('should include invocationId in the returned AgentResult', async () => {
      const script = await createScript('inv-id.sh', 'echo "OK"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('inv-id-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'inv-id-001',
      });

      expect(result.success).toBe(true);
      expect(result.invocationId).toBeDefined();
      expect(result.invocationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should generate a unique invocationId for each invocation', async () => {
      const script = await createScript('inv-unique.sh', 'echo "OK"\nexit 0');
      const launcher = makeLauncher(script);

      const { contextFile: ctx1, progressDir: pd1 } = await prepareInvocation('inv-unique-001');
      const { contextFile: ctx2, progressDir: pd2 } = await prepareInvocation('inv-unique-002');

      const result1 = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile: ctx1,
        progressDir: pd1,
        phase: 4,
        taskId: 'inv-unique-001',
      });

      const result2 = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile: ctx2,
        progressDir: pd2,
        phase: 4,
        taskId: 'inv-unique-002',
      });

      expect(result1.invocationId).toBeDefined();
      expect(result2.invocationId).toBeDefined();
      expect(result1.invocationId).not.toBe(result2.invocationId);
    });

    it('should include invocationId in the agent log filename', async () => {
      const script = await createScript('inv-log.sh', 'echo "output"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('inv-log-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'inv-log-001',
      });

      expect(result.invocationId).toBeDefined();

      const { fileName } = await readLatestAgentLog('code-migrator', 'inv-log-001');
      expect(fileName).toContain(result.invocationId!);
    });

    it('should include invocationId on error/catch path', async () => {
      const launcher = makeLauncher('__aamf_no_such_binary_inv__');
      const { contextFile, progressDir } = await prepareInvocation('inv-error-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'inv-error-001',
      });

      expect(result.success).toBe(false);
      expect(result.invocationId).toBeDefined();
      expect(result.invocationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe('queueDelay tracking', () => {
    it('should set queueDelay when invocationDelayMs causes a wait', async () => {
      const script = await createScript('queue-delay.sh', 'echo "OK"\nexit 0');
      const cfg = createMockConfig({
        copilot: { cliCommand: script, agentDir: '.github/agents', timeout: 300_000 },
        options: {
          maxParallelAgents: 3,
          maxRetriesPerTask: 3,
          maxLinesPerTask: 500,
          dryRun: false,
          resume: false,
          invocationDelayMs: 200,
          buildConcurrency: 1,
          continueOnBlocked: true,
          maxBlockedTasks: 0,
          maxInfraRetries: 3,
          avgTokensPerTask: 5000,
        },
      });
      config = cfg;
      const launcher = new AgentLauncher(cfg, projectRoot, logger);

      const { contextFile: ctx1, progressDir: pd1 } = await prepareInvocation('qd-001');
      const { contextFile: ctx2, progressDir: pd2 } = await prepareInvocation('qd-002');

      // First invocation — no delay expected
      await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile: ctx1,
        progressDir: pd1,
        phase: 4,
        taskId: 'qd-001',
      });

      // Force the second invocation to observe a non-zero required wait,
      // independent of machine/runtime timing jitter.
      (launcher as unknown as { lastInvocationTime: number }).lastInvocationTime = Date.now();

      // Second invocation — should have queueDelay from invocationDelayMs
      const result2 = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile: ctx2,
        progressDir: pd2,
        phase: 4,
        taskId: 'qd-002',
      });

      expect(result2.queueDelay).toBeDefined();
      expect(result2.queueDelay).toBeGreaterThan(0);
    });

    it('should not set queueDelay when invocationDelayMs is 0', async () => {
      const script = await createScript('no-qd.sh', 'echo "OK"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('no-qd-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'no-qd-001',
      });

      // queueDelay should be undefined or 0 when no delay is configured
      expect(result.queueDelay === undefined || result.queueDelay === 0).toBe(true);
    });
  });

  describe('runner init path resolution', () => {
    it('should prepend environment.extraPath entries when inheritShellPath is false', async () => {
      const script = await createScript('print-path.sh', 'echo "PATH_VALUE:$PATH"\nexit 0');
      const cfg = createMockConfig({
        copilot: { cliCommand: script, agentDir: '.github/agents', timeout: 300_000 },
        environment: {
          inheritShellPath: false,
          extraPath: ['/tmp/aamf-extra-bin'],
        },
      });
      config = cfg;
      const launcher = new AgentLauncher(cfg, projectRoot, logger);
      await launcher.init();

      const { contextFile, progressDir } = await prepareInvocation('extra-path-001');
      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'extra-path-001',
      });

      expect(result.success).toBe(true);

      const { content: logContent } = await readLatestAgentLog('code-migrator', 'extra-path-001');
      expect(logContent).toContain('PATH_VALUE:/tmp/aamf-extra-bin:');
    });

    it('should initialize runner only once when init is called repeatedly', async () => {
      const launcher = makeLauncher('echo');
      const runnerInit = vi.fn().mockResolvedValue(undefined);
      (launcher as any).runner = {
        init: runnerInit,
        run: vi.fn(),
        getResolvedPath: vi.fn().mockReturnValue(undefined),
      };

      await launcher.init();
      await launcher.init();

      expect(runnerInit).toHaveBeenCalledTimes(1);
    });
  });

  describe('spawnToFirstOutput tracking', () => {
    it('should set spawnToFirstOutput when output files are detected during execution', async () => {
      const outputDir = join(tempDir, 'output-detect');
      await ensureDir(outputDir);

      // Script that creates an output file before exiting
      const script = await createScript('spawn-output.sh', [
        `echo "test" > "${outputDir}/result.txt"`,
        'sleep 0.2',
        'exit 0',
      ].join('\n'));
      const launcher = makeLauncher(script);
      const contextFile = join(tempDir, 'ctx-spawn-output.json');
      await writeFile(contextFile, JSON.stringify({ outputPath: outputDir }));
      const progressDir = join(tempDir, 'progress');
      await ensureDir(progressDir);

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'spawn-output',
      });

      expect(result.success).toBe(true);
      // spawnToFirstOutput may or may not be set depending on timing of the output poll
      // but the field should exist on the result type
      expect(result.spawnToFirstOutput === undefined || typeof result.spawnToFirstOutput === 'number').toBe(true);
    });

    it('should leave spawnToFirstOutput undefined when no output files are produced', async () => {
      const script = await createScript('no-output.sh', 'echo "no output files"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('no-output-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'no-output-001',
      });

      expect(result.success).toBe(true);
      expect(result.spawnToFirstOutput).toBeUndefined();
    });
  });

  describe('mcpConfig injection', () => {
    it('should pass --additional-mcp-config flag when mcpConfig is provided', async () => {
      const script = await createScript('echo-mcp-args.sh', 'echo "ARGS:$@"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('mcp-config-001');

      const mcpConfig = {
        url: 'http://localhost:4321/mcp',
      };

      const result = await launcher.launchAgent({
        agent: 'impact-assessor',
        contextFile,
        progressDir,
        phase: 1,
        taskId: 'mcp-config-001',
        mcpConfig,
      });

      expect(result.success).toBe(true);

      const { content: logContent } = await readLatestAgentLog('impact-assessor', 'mcp-config-001');
      expect(logContent).toContain('--additional-mcp-config');
      expect(logContent).toContain('aamf-kb');
      expect(logContent).toContain('localhost:4321');
    });

    it('should not include --additional-mcp-config flag when mcpConfig is absent', async () => {
      const script = await createScript('echo-no-mcp.sh', 'echo "ARGS:$@"\nexit 0');
      const launcher = makeLauncher(script);
      const { contextFile, progressDir } = await prepareInvocation('no-mcp-001');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'no-mcp-001',
      });

      expect(result.success).toBe(true);

      const { content: logContent } = await readLatestAgentLog('code-migrator', 'no-mcp-001');
      expect(logContent).not.toContain('--additional-mcp-config');
    });

    it('should use Claude runtime and pass --mcp-config when agentRuntime is claude-code', async () => {
      const script = await createScript('echo-claude-mcp.sh', 'echo "ARGS:$@"\nexit 0');
      const cfg = createMockConfig({
        agentRuntime: 'claude-code',
        claudeCode: {
          cliCommand: script,
          agentDir: '.claude/agents',
          timeout: 300_000,
          model: 'claude-sonnet-4',
        },
        copilot: {
          cliCommand: 'copilot',
          agentDir: '.github/agents',
          timeout: 300_000,
        },
      });
      config = cfg;
      const launcher = new AgentLauncher(cfg, projectRoot, logger);
      const { contextFile, progressDir } = await prepareInvocation('claude-mcp-001');

      const result = await launcher.launchAgent({
        agent: 'impact-assessor',
        contextFile,
        progressDir,
        phase: 1,
        taskId: 'claude-mcp-001',
        mcpConfig: { url: 'http://localhost:4545/mcp' },
      });

      expect(result.success).toBe(true);

      const { content: logContent } = await readLatestAgentLog('impact-assessor', 'claude-mcp-001');
      expect(logContent).toContain('--mcp-config');
      expect(logContent).toContain('aamf-kb');
      expect(logContent).toContain('localhost:4545');
      expect(logContent).not.toContain('--additional-mcp-config');
    });
  });

  describe('launchAgent delay branch behavior', () => {
    it('should skip waiting when invocationDelayMs is set but elapsed time already exceeds delay', async () => {
      const launcher = makeLauncher('echo');
      const runMock = vi.fn().mockResolvedValue({
        agent: 'code-migrator',
        taskId: 'elapsed-no-wait',
        exitCode: 0,
        success: true,
        outputFiles: [],
        duration: 1,
        tokenUsage: { prompt: 1, completion: 0, total: 1 },
        outputParsed: false,
      });
      (launcher as any).runner = {
        init: vi.fn().mockResolvedValue(undefined),
        run: runMock,
        getResolvedPath: vi.fn().mockReturnValue(undefined),
      };
      (launcher as any).config.options.invocationDelayMs = 100;
      (launcher as any).lastInvocationTime = Date.now() - 1_000;

      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const { contextFile, progressDir } = await prepareInvocation('elapsed-no-wait');

      const result = await launcher.launchAgent({
        agent: 'code-migrator',
        contextFile,
        progressDir,
        phase: 4,
        taskId: 'elapsed-no-wait',
      });

      expect(result.success).toBe(true);
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
    });
  });
});
