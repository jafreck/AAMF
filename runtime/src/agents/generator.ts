/**
 * @module agents/generator
 *
 * Generates backend-specific agent definition files from shared templates.
 *
 * Templates live in `runtime/agents/templates/<agent-name>.md` and contain the
 * full markdown body shared across backends. This module prepends the correct
 * YAML front matter for the selected backend (Copilot or Claude Code) and writes
 * the result to the configured agent directory.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, atomicWrite } from '../util/fs.js';
import { AGENT_REGISTRY } from './registry.js';
import type { AgentName } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Which CLI backend to generate for. */
  backend: 'copilot' | 'claude-code';
  /** Absolute path to write generated agent definition files. */
  outputDir: string;
  /** Override template directory (for testing). */
  templateDir?: string;
}

// ─── Front Matter Builders ───────────────────────────────────────────────────

function buildCopilotFrontMatter(name: AgentName): string {
  const entry = AGENT_REGISTRY[name];
  const lines = [
    '---',
    `name: ${entry.displayName}`,
    `description: "${entry.description}"`,
    `tools: ${JSON.stringify(entry.copilotTools as unknown as string[])}`,
    '---',
  ];
  return lines.join('\n');
}

function buildClaudeCodeFrontMatter(name: AgentName): string {
  const entry = AGENT_REGISTRY[name];
  const lines = [
    '---',
    `name: ${name}`,
    `description: "${entry.description}"`,
    'tools:',
    ...entry.claudeTools.map(t => `  - ${t}`),
    '---',
  ];
  return lines.join('\n');
}

// ─── Template Resolution ─────────────────────────────────────────────────────

/** Default template directory: `runtime/agents/templates/` */
function defaultTemplateDir(): string {
  return fileURLToPath(new URL('../../agents/templates/', import.meta.url));
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate agent definition files for the specified backend.
 *
 * Reads each `<agent-name>.md` template, prepends backend-specific YAML front
 * matter, and writes the result to `outputDir` with the correct filename
 * convention (`.agent.md` for Copilot, `.md` for Claude Code).
 *
 * @returns Array of absolute paths to generated files.
 */
export async function generateAgentDefinitions(options: GenerateOptions): Promise<string[]> {
  const { backend, outputDir } = options;
  const templateDir = options.templateDir ?? defaultTemplateDir();

  await ensureDir(outputDir);

  // Discover available templates
  const templateFiles = (await readdir(templateDir))
    .filter(f => f.endsWith('.md'))
    .sort();

  const generated: string[] = [];

  for (const templateFile of templateFiles) {
    const agentName = basename(templateFile, '.md') as AgentName;

    // Skip templates that don't have a registry entry
    if (!AGENT_REGISTRY[agentName]) continue;

    const templateContent = await readFile(join(templateDir, templateFile), 'utf-8');

    const frontMatter = backend === 'claude-code'
      ? buildClaudeCodeFrontMatter(agentName)
      : buildCopilotFrontMatter(agentName);

    const suffix = backend === 'claude-code' ? '.md' : '.agent.md';
    const outputFile = join(outputDir, `${agentName}${suffix}`);

    await atomicWrite(outputFile, `${frontMatter}\n\n${templateContent}`);
    generated.push(outputFile);
  }

  return generated;
}
