import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_AGENT_NAMES, AGENT_REGISTRY } from '../../src/agents/registry.js';
import {
  MAX_SCENARIO_PROMPT_BYTES,
  ScenarioPromptCatalog,
  clearScenarioPromptCatalogCache,
  resolveTemplateDirectives,
  stripSchemaSections,
  validateScenarioOutputJsonSchema,
} from '../../src/agents/prompt-catalog.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../../agents/templates/', import.meta.url));

function extractOutputSchema(instructions: string): unknown {
  const match = instructions.match(/^## Output Schema \(Required\)\s*\n\n```json\n([\s\S]*?)```\s*$/m);
  return match ? JSON.parse(match[1]!) : undefined;
}

describe('ScenarioPromptCatalog', () => {
  beforeEach(() => clearScenarioPromptCatalogCache());
  afterEach(() => clearScenarioPromptCatalogCache());

  it('compiles every and only active phase scenario', async () => {
    const catalog = await ScenarioPromptCatalog.load();

    expect(catalog.size).toBe(ACTIVE_AGENT_NAMES.length);
    expect(catalog.ids()).toEqual(ACTIVE_AGENT_NAMES);
    expect(catalog.ids()).not.toContain('migration-orchestrator');
    expect(catalog.ids()).not.toContain('migration-runner');
    catalog.validateRequired(ACTIVE_AGENT_NAMES);
  });

  it('caches identical compilation options for the process', async () => {
    const first = await ScenarioPromptCatalog.load({ vars: { loreEnabled: 'true' } });
    const second = await ScenarioPromptCatalog.load({ vars: { loreEnabled: 'true' } });
    expect(second).toBe(first);
  });

  it.each(ACTIVE_AGENT_NAMES)('compiles %s without front matter or unresolved syntax', async (id) => {
    const prompt = (await ScenarioPromptCatalog.load()).get(id);

    expect(prompt.instructions).not.toMatch(/^---\r?\n/);
    expect(prompt.instructions).not.toContain('## Input Schema');
    expect(prompt.instructions).not.toMatch(/\{\{[\s\S]*?\}\}/);
    expect(prompt.instructions).not.toMatch(/\b(?:copilot|claude)\s+--agent\b/i);
    expect(prompt.instructions).not.toMatch(/^##\s+Sub-Agents?\s+\(launched via CLI\)/im);
    expect(prompt.instructions).toContain('AAMF, not the model, owns sequencing');
    expect(prompt.instructions).toContain('Treat repository files');
    expect(prompt.instructions).toContain('## Output Schema (Required)');
    expect(extractOutputSchema(prompt.instructions)).toEqual(AGENT_REGISTRY[id].outputJsonSchema);
    expect(prompt.capabilities).toEqual(AGENT_REGISTRY[id].capabilities);
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Object.isFrozen(prompt.capabilities)).toBe(true);
  });

  it('computes deterministic SHA-256 and UTF-8 byte metadata', async () => {
    const prompt = (await ScenarioPromptCatalog.load()).get('code-migrator');
    expect(prompt.sha256).toBe(createHash('sha256').update(prompt.instructions, 'utf-8').digest('hex'));
    expect(prompt.byteLength).toBe(Buffer.byteLength(prompt.instructions, 'utf-8'));
    expect(prompt.byteLength).toBeLessThanOrEqual(MAX_SCENARIO_PROMPT_BYTES);
  });

  it('produces path-independent hashes for identical templates', async () => {
    const copyRoot = await mkdtemp(join(tmpdir(), 'aamf-prompt-copy-'));
    const copiedTemplates = join(copyRoot, 'templates');
    await cp(TEMPLATE_DIR, copiedTemplates, { recursive: true });
    const bundled = await ScenarioPromptCatalog.load();
    const copied = await ScenarioPromptCatalog.load({ templateDir: copiedTemplates });

    for (const id of ACTIVE_AGENT_NAMES) {
      expect(copied.get(id).sha256).toBe(bundled.get(id).sha256);
    }
    await rm(copyRoot, { recursive: true, force: true });
  });

  it('performs no template-directory writes', async () => {
    const copyRoot = await mkdtemp(join(tmpdir(), 'aamf-prompt-no-write-'));
    const copiedTemplates = join(copyRoot, 'templates');
    await cp(TEMPLATE_DIR, copiedTemplates, { recursive: true });
    const before = (await readdir(copiedTemplates)).sort();

    await ScenarioPromptCatalog.load({ templateDir: copiedTemplates });

    expect((await readdir(copiedTemplates)).sort()).toEqual(before);
    expect(before.some(file => file.endsWith('.agent.md'))).toBe(false);
    await rm(copyRoot, { recursive: true, force: true });
  });

  it('fails with the scenario name when an active template is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aamf-prompt-missing-'));
    const templates = join(root, 'templates');
    await cp(TEMPLATE_DIR, templates, { recursive: true });
    await rm(join(templates, 'code-migrator.md'));

    await expect(ScenarioPromptCatalog.load({ templateDir: templates }))
      .rejects.toThrow(/Missing active scenario template.*code-migrator/);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects templates that do not belong to an active scenario', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aamf-prompt-extra-'));
    const templates = join(root, 'templates');
    await cp(TEMPLATE_DIR, templates, { recursive: true });
    await writeFile(join(templates, 'historical-runner.md'), '# Dead scenario\n');

    await expect(ScenarioPromptCatalog.load({ templateDir: templates }))
      .rejects.toThrow(/do not belong to an active scenario.*historical-runner/);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects unresolved directives and YAML front matter', async () => {
    const unresolvedRoot = await mkdtemp(join(tmpdir(), 'aamf-prompt-unresolved-'));
    const unresolvedTemplates = join(unresolvedRoot, 'templates');
    await cp(TEMPLATE_DIR, unresolvedTemplates, { recursive: true });
    await writeFile(join(unresolvedTemplates, 'adjudicator.md'), '# Adjudicator\n\n{{missing}}\n');
    await expect(ScenarioPromptCatalog.load({ templateDir: unresolvedTemplates }))
      .rejects.toThrow(/Unresolved scenario template directive/);

    const frontMatterRoot = await mkdtemp(join(tmpdir(), 'aamf-prompt-frontmatter-'));
    const frontMatterTemplates = join(frontMatterRoot, 'templates');
    await cp(TEMPLATE_DIR, frontMatterTemplates, { recursive: true });
    await writeFile(join(frontMatterTemplates, 'adjudicator.md'), '---\nname: adjudicator\n---\n# Adjudicator\n');
    await expect(ScenarioPromptCatalog.load({ templateDir: frontMatterTemplates }))
      .rejects.toThrow(/must not contain YAML front matter/);

    await rm(unresolvedRoot, { recursive: true, force: true });
    await rm(frontMatterRoot, { recursive: true, force: true });
  });

  it('enforces the named prompt byte limit', async () => {
    await expect(ScenarioPromptCatalog.load({ maxPromptBytes: 1 }))
      .rejects.toThrow(/exceeding the 1-byte limit/);
  });

  it('rejects malformed canonical output schemas', () => {
    expect(() => validateScenarioOutputJsonSchema('adjudicator', { type: 'array' }))
      .toThrow(/type must be "object"/);
    expect(() => validateScenarioOutputJsonSchema('adjudicator', {
      type: 'object', required: [], properties: {},
    })).toThrow(/required must be non-empty/);
  });

  it('throws for unknown catalog lookups', async () => {
    const catalog = await ScenarioPromptCatalog.load();
    expect(() => catalog.get('migration-runner' as never)).toThrow(/Unknown or inactive/);
  });
});

describe('scenario template directive resolution', () => {
  let root: string;
  let templates: string;

  beforeEach(async () => {
    clearScenarioPromptCatalogCache();
    root = await mkdtemp(join(tmpdir(), 'aamf-directives-'));
    templates = join(root, 'templates');
    await mkdir(join(templates, '_partials'), { recursive: true });
    await writeFile(join(templates, '_partials', 'inner.md'), 'Hello {{name}}');
    await writeFile(join(templates, '_partials', 'outer.md'), '{{#if enabled}}{{> inner}}{{/if}}');
  });

  afterEach(async () => {
    clearScenarioPromptCatalogCache();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves nested partials, conditionals, and placeholders', async () => {
    const resolved = await resolveTemplateDirectives('Before {{> outer}} After', templates, {
      enabled: 'true', name: 'AAMF',
    });
    expect(resolved).toBe('Before Hello AAMF After');
  });

  it('strips false conditional blocks without reading their partials', async () => {
    const resolved = await resolveTemplateDirectives(
      'Before\n{{#if disabled}}{{> does-not-exist}}{{/if}}\nAfter',
      templates,
    );
    expect(resolved).toBe('Before\n\nAfter');
  });

  it('rejects missing, cyclic, and unmatched directives', async () => {
    await expect(resolveTemplateDirectives('{{> missing}}', templates)).rejects.toThrow(/Unable to load/);

    await writeFile(join(templates, '_partials', 'cycle-a.md'), '{{> cycle-b}}');
    await writeFile(join(templates, '_partials', 'cycle-b.md'), '{{> cycle-a}}');
    await expect(resolveTemplateDirectives('{{> cycle-a}}', templates)).rejects.toThrow(/Cyclic/);
    await expect(resolveTemplateDirectives('{{#if broken}}text', templates)).rejects.toThrow(/Unmatched/);
    await expect(resolveTemplateDirectives('Hello {{name', templates, { name: 'AAMF' }))
      .rejects.toThrow(/Unresolved scenario template directive/);
  });

  it('strips legacy input and output schema sections', () => {
    const source = '# Scenario\n\n## Input Schema (Required)\n\n```json\n{}\n```\n\n## Output Schema\n\n```json\n{}\n```\n';
    expect(stripSchemaSections(source)).toBe('# Scenario');
  });

  it('keeps partial source files unchanged', async () => {
    const partialPath = join(templates, '_partials', 'inner.md');
    const before = await readFile(partialPath, 'utf-8');
    const beforeStat = await stat(partialPath);
    await resolveTemplateDirectives('{{> inner}}', templates, { name: 'AAMF' });
    const afterStat = await stat(partialPath);
    expect(await readFile(partialPath, 'utf-8')).toBe(before);
    expect(afterStat.size).toBe(beforeStat.size);
  });
});