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
 *
 * Templates may include shared fragments via `{{> partial-name}}` directives.
 * Partials live in `runtime/agents/templates/_partials/<name>.md` and support
 * `{{placeholder}}` interpolation for per-agent customization.
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
  /**
   * Extra variables forwarded to `resolvePartials()` for `{{var}}` interpolation
   * and `{{#if var}}…{{/if}}` conditional blocks.
   *
   * The runtime sets `loreEnabled: 'true'` when the Lore KB index is configured,
   * allowing templates to conditionally include Lore-related guidance.
   */
  vars?: Record<string, string>;
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

// ─── Partial Resolution ──────────────────────────────────────────────────────

/** Cache of loaded partial contents, keyed by partials directory path + partial name. */
const partialsCache = new Map<string, string>();

/**
 * Resolve `{{> partial-name}}` directives and `{{#if var}}…{{/if}}` conditional
 * blocks in a template body.
 *
 * Conditional blocks are evaluated **before** partial expansion so that an
 * entire `{{> partial}}` reference can be gated on a variable.  A block is
 * retained when `vars[var]` is a non-empty string; otherwise the block
 * (including its delimiters) is stripped.
 *
 * After inclusion, simple `{{key}}` placeholders in the resolved text are
 * replaced using the provided `vars` map.
 */
export async function resolvePartials(
  content: string,
  templateDir: string,
  vars: Record<string, string> = {},
): Promise<string> {
  // ── 1. Evaluate {{#if var}} … {{/if}} conditional blocks ──────────────
  // Process innermost blocks first (body must NOT contain another {{#if}}).
  // Iterate until no more blocks remain, peeling nesting from the inside out.
  let resolved = content;
  const INNER_IF = /\{\{#if\s+([\w-]+)\s*\}\}((?:(?!\{\{#if\b)[\s\S])*?)\{\{\/if\}\}/g;
  while (INNER_IF.test(resolved)) {
    INNER_IF.lastIndex = 0;
    resolved = resolved.replace(INNER_IF, (_match, varName: string, body: string) => {
      return vars[varName] ? body : '';
    });
    INNER_IF.lastIndex = 0;
  }

  // Clean up blank lines left by stripped conditional blocks
  resolved = resolved.replace(/\n{3,}/g, '\n\n');

  // ── 2. Expand {{> partial-name}} directives ──────────────────────────
  const partialsDir = join(templateDir, '_partials');
  const partialPattern = /\{\{>\s*([\w-]+)\s*\}\}/g;

  // Collect all partial references first to allow parallel reads
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = partialPattern.exec(resolved)) !== null) {
    if (m[1]) names.add(m[1]);
  }

  if (names.size === 0) return resolved;

  // Load partials (with caching)
  const loaded = new Map<string, string>();
  await Promise.all(
    [...names].map(async (name) => {
      const cacheKey = `${partialsDir}/${name}`;
      if (partialsCache.has(cacheKey)) {
        loaded.set(name, partialsCache.get(cacheKey)!);
        return;
      }
      const filePath = join(partialsDir, `${name}.md`);
      const text = (await readFile(filePath, 'utf-8')).trimEnd();
      partialsCache.set(cacheKey, text);
      loaded.set(name, text);
    }),
  );

  // Replace directives with loaded content
  let result = resolved.replace(
    /\{\{>\s*([\w-]+)\s*\}\}/g,
    (_match, name: string) => loaded.get(name) ?? _match,
  );

  // Interpolate {{key}} placeholders
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  return result;
}

/** Clear the partials cache (useful in tests). */
export function clearPartialsCache(): void {
  partialsCache.clear();
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

  // Discover available templates (skip _-prefixed entries like _partials/)
  const templateFiles = (await readdir(templateDir))
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .sort();

  const generated: string[] = [];

  for (const templateFile of templateFiles) {
    const agentName = basename(templateFile, '.md') as AgentName;

    // Skip templates that don't have a registry entry
    if (!AGENT_REGISTRY[agentName]) continue;

    const rawTemplate = await readFile(join(templateDir, templateFile), 'utf-8');

    // Resolve {{#if}}…{{/if}} conditionals, {{> partial}} directives,
    // and {{var}} placeholders
    const templateContent = await resolvePartials(rawTemplate, templateDir, {
      agentName,
      ...options.vars,
    });

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
