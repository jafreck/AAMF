/**
 * @module agents/generator
 *
 * Generates backend-specific agent definition files from shared templates.
 *
 * Templates live in `runtime/agents/templates/<agent-name>.md` and contain the
 * markdown body shared across backends (without schema sections). This module
 * prepends the correct YAML front matter for the selected backend and appends
 * Input / Output Schema sections derived from the canonical JSON schemas stored
 * in the agent registry. This ensures the schemas agents see in their prompt
 * always reflect the runtime's current contract.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, atomicWrite } from '../util/fs.js';
import { AGENT_REGISTRY } from './registry.js';
import type { AgentName, JsonSchema } from './types.js';

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

// ─── Schema Section Helpers ──────────────────────────────────────────────────

/**
 * Render a JSON Schema object as a markdown section with a fenced JSON block.
 */
function renderSchemaSection(title: string, schema: JsonSchema): string {
  const json = JSON.stringify(schema, null, 2);
  return `## ${title} (Required)\n\n\`\`\`json\n${json}\n\`\`\``;
}

/**
 * Strip any existing `## Input Schema` and `## Output Schema` sections
 * (including their fenced JSON blocks) from the template body.
 * This ensures we never duplicate schemas when the registry provides them.
 */
export function stripSchemaSections(content: string): string {
  // Match ## Input Schema or ## Output Schema headings (with optional "(Required)")
  // through to just before the next `## ` heading or end of string.
  // JS regex does not support \Z; use (?=\n## )|$ with a two-pass approach.
  let result = content;
  for (const kind of ['Input', 'Output']) {
    const pattern = new RegExp(
      `^## ${kind} Schema(?:\\s*\\(Required\\))?\\s*\\n[\\s\\S]*?(?=\\n## |$)`,
      'gm',
    );
    result = result.replace(pattern, '');
  }
  return result.trimEnd();
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate agent definition files for the specified backend.
 *
 * Reads each `<agent-name>.md` template, strips any static schema sections,
 * prepends backend-specific YAML front matter, appends Input/Output Schema
 * sections from the registry, and writes the result to `outputDir`.
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

    // Strip any static schema sections from template body, then append
    // the canonical schemas from the registry.
    const entry = AGENT_REGISTRY[agentName];
    const body = stripSchemaSections(templateContent);
    const inputSection = renderSchemaSection('Input Schema', entry.inputJsonSchema);
    const outputSection = renderSchemaSection('Output Schema', entry.outputJsonSchema);

    const suffix = backend === 'claude-code' ? '.md' : '.agent.md';
    const outputFile = join(outputDir, `${agentName}${suffix}`);

    await atomicWrite(outputFile, `${frontMatter}\n\n${body}\n\n${inputSection}\n\n${outputSection}\n`);
    generated.push(outputFile);
  }

  return generated;
}
