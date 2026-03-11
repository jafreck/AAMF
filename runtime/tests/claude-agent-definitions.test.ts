/**
 * Tests for the agent definition generator, shared templates, and registry schemas.
 *
 * Verifies that:
 * - Templates exist for every registered agent
 * - Templates contain NO YAML front matter, example blocks, or schema sections
 * - Registry defines valid inputJsonSchema / outputJsonSchema for every agent
 * - Generation produces valid Copilot and Claude Code agent files
 * - Generated files have correct front matter per backend
 * - Generated files contain Input/Output Schema sections injected from the registry
 * - Both backends get identical body + schema content
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFile, readdir, rm, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ALL_AGENT_NAMES, AGENT_REGISTRY } from '../src/agents/registry.js';
import {
  generateAgentDefinitions,
  stripSchemaSections,
  resolvePartials,
  clearPartialsCache,
} from '../src/agents/generator.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../agents/templates/', import.meta.url));

// ─── Front-matter parser ─────────────────────────────────────────────────────

interface FrontMatter {
  name?: string;
  description?: string;
  tools?: string[];
  [key: string]: unknown;
}

function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontMatter: {}, body: content };
  }
  const rawYaml = match[1];
  const body = match[2];

  const frontMatter: FrontMatter = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of rawYaml.split('\n')) {
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    const keyValueMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);

    if (listItemMatch && currentList !== null) {
      currentList.push(listItemMatch[1].trim());
    } else if (keyValueMatch) {
      if (currentKey && currentList) {
        frontMatter[currentKey] = currentList;
      }
      currentKey = keyValueMatch[1];
      const rawValue = keyValueMatch[2].trim();

      if (rawValue === '' || rawValue === '|' || rawValue === '>') {
        currentList = [];
        frontMatter[currentKey] = currentList;
      } else {
        currentList = null;
        frontMatter[currentKey] = rawValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  return { frontMatter, body };
}

/** Extract the JSON object from a schema section in a generated agent file. */
function extractSchemaJson(content: string, sectionTitle: string): unknown {
  const headingRegex = new RegExp(`^##\\s+${sectionTitle}(?:\\s*\\(Required\\))?\\s*$`, 'im');
  const headingMatch = headingRegex.exec(content);
  if (!headingMatch) return undefined;
  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
  const jsonBlock = afterHeading.match(/```json\r?\n([\s\S]*?)```/m);
  if (!jsonBlock) return undefined;
  return JSON.parse(jsonBlock[1].trim());
}

// ─── Template Tests ──────────────────────────────────────────────────────────

describe('Agent templates (runtime/agents/templates/)', () => {
  it('should have a template for every registered agent', async () => {
    const files = await readdir(TEMPLATE_DIR);
    const templateNames = files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    for (const agent of ALL_AGENT_NAMES) {
      expect(templateNames, `Missing template for agent "${agent}"`).toContain(agent);
    }
  });

  for (const agentName of ALL_AGENT_NAMES) {
    describe(`${agentName}.md`, () => {
      let content: string;

      beforeAll(async () => {
        content = await readFile(join(TEMPLATE_DIR, `${agentName}.md`), 'utf-8');
      });

      it('should NOT contain YAML front matter', () => {
        expect(content).not.toMatch(/^---\r?\n/);
      });

      it('should NOT contain example aamf-json blocks', () => {
        expect(content).not.toMatch(/### Example/i);
      });

      it('should NOT contain Input Schema sections (injected at generation)', () => {
        expect(content).not.toMatch(/##\s+Input Schema/);
      });

      it('should NOT contain Output Schema sections (injected at generation)', () => {
        expect(content).not.toMatch(/##\s+Output Schema/);
      });

      it('should NOT contain inline duplicates of partial content', () => {
        // Templates reference partials via {{> name}} inside {{#if}} blocks.
        // The partial body itself should NOT also appear verbatim in the template.
        if (content.includes('lore-index-first-principle')) {
          expect(content).not.toContain(
            'You have access to the **Lore** MCP server',
          );
        }
        if (content.includes('{{> aamf-json-output-format}}')) {
          expect(content).not.toContain(
            'Missing or malformed `aamf-json` block',
          );
        }
      });
    });
  }
});

// ─── Registry Schema Tests ───────────────────────────────────────────────────

describe('Registry JSON schemas', () => {
  for (const agentName of ALL_AGENT_NAMES) {
    describe(`${agentName}`, () => {
      it('should define a valid inputJsonSchema', () => {
        const schema = AGENT_REGISTRY[agentName].inputJsonSchema;
        expect(schema.type).toBe('object');
        expect(Array.isArray(schema.required)).toBe(true);
        expect((schema.required as string[]).length).toBeGreaterThan(0);
        // All agents require the base context fields
        for (const field of ['contextFile', 'projectRoot', 'progressDir', 'phase']) {
          expect(schema.required, `Missing base required field "${field}"`).toContain(field);
        }
      });

      it('should define a valid outputJsonSchema', () => {
        const schema = AGENT_REGISTRY[agentName].outputJsonSchema;
        expect(schema.type).toBe('object');
        expect(Array.isArray(schema.required)).toBe(true);
        expect(schema.required).toContain('agent');
        expect(schema.required).toContain('status');
        expect(schema.required).toContain('outputFiles');
        const props = schema.properties as Record<string, unknown>;
        expect(props.agent).toBeDefined();
      });
    });
  }
});

// ─── Generation Tests ────────────────────────────────────────────────────────

describe('generateAgentDefinitions()', () => {
  let copilotDir: string;
  let claudeDir: string;

  beforeAll(async () => {
    copilotDir = await mkdtemp(join(tmpdir(), 'aamf-copilot-'));
    claudeDir = await mkdtemp(join(tmpdir(), 'aamf-claude-'));

    await generateAgentDefinitions({
      backend: 'copilot',
      outputDir: copilotDir,
      templateDir: TEMPLATE_DIR,
    });

    await generateAgentDefinitions({
      backend: 'claude-code',
      outputDir: claudeDir,
      templateDir: TEMPLATE_DIR,
    });
  });

  afterAll(async () => {
    await rm(copilotDir, { recursive: true, force: true });
    await rm(claudeDir, { recursive: true, force: true });
  });

  describe('Copilot backend', () => {
    it('should generate a .agent.md file for every registered agent', async () => {
      const files = await readdir(copilotDir);
      for (const agent of ALL_AGENT_NAMES) {
        expect(files, `Missing Copilot file for "${agent}"`).toContain(`${agent}.agent.md`);
      }
    });

    it('should generate exactly one file per registered agent', async () => {
      const files = (await readdir(copilotDir)).filter(f => f.endsWith('.agent.md'));
      expect(files.length).toBe(ALL_AGENT_NAMES.length);
    });

    for (const agentName of ALL_AGENT_NAMES) {
      describe(`${agentName}.agent.md`, () => {
        let content: string;

        beforeAll(async () => {
          content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
        });

        it('should have Title Case name in front matter', () => {
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.name).toBe(AGENT_REGISTRY[agentName].displayName);
        });

        it('should have a description matching the registry', () => {
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.description).toBe(AGENT_REGISTRY[agentName].description);
        });

        it('should have JSON-array tools in front matter', () => {
          const { frontMatter } = parseFrontMatter(content);
          const toolsStr = frontMatter.tools as unknown as string;
          const parsed = JSON.parse(toolsStr);
          expect(parsed).toEqual([...AGENT_REGISTRY[agentName].copilotTools]);
        });

        it('should contain Input Schema heading with (Required) suffix', () => {
          expect(content).toMatch(/^## Input Schema \(Required\)/m);
        });

        it('should contain Input Schema section matching registry', () => {
          const parsed = extractSchemaJson(content, 'Input Schema');
          expect(parsed).toEqual(AGENT_REGISTRY[agentName].inputJsonSchema);
        });

        it('should contain Output Schema heading with (Required) suffix', () => {
          expect(content).toMatch(/^## Output Schema \(Required\)/m);
        });

        it('should contain Output Schema section matching registry', () => {
          const parsed = extractSchemaJson(content, 'Output Schema');
          expect(parsed).toEqual(AGENT_REGISTRY[agentName].outputJsonSchema);
        });
      });
    }
  });

  describe('Claude Code backend', () => {
    it('should generate a .md file for every registered agent', async () => {
      const files = await readdir(claudeDir);
      for (const agent of ALL_AGENT_NAMES) {
        expect(files, `Missing Claude file for "${agent}"`).toContain(`${agent}.md`);
      }
    });

    it('should generate exactly one file per registered agent', async () => {
      const files = (await readdir(claudeDir)).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(ALL_AGENT_NAMES.length);
    });

    for (const agentName of ALL_AGENT_NAMES) {
      describe(`${agentName}.md`, () => {
        let content: string;

        beforeAll(async () => {
          content = await readFile(join(claudeDir, `${agentName}.md`), 'utf-8');
        });

        it('should have kebab-case name matching agent name', () => {
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.name).toBe(agentName);
        });

        it('should have a description matching the registry', () => {
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.description).toBe(AGENT_REGISTRY[agentName].description);
        });

        it('should have YAML-list tools in front matter', () => {
          const { frontMatter } = parseFrontMatter(content);
          expect(Array.isArray(frontMatter.tools)).toBe(true);
          expect(frontMatter.tools).toEqual([...AGENT_REGISTRY[agentName].claudeTools]);
        });

        it('should contain Input Schema heading with (Required) suffix', () => {
          expect(content).toMatch(/^## Input Schema \(Required\)/m);
        });

        it('should contain Input Schema section matching registry', () => {
          const parsed = extractSchemaJson(content, 'Input Schema');
          expect(parsed).toEqual(AGENT_REGISTRY[agentName].inputJsonSchema);
        });

        it('should contain Output Schema heading with (Required) suffix', () => {
          expect(content).toMatch(/^## Output Schema \(Required\)/m);
        });

        it('should contain Output Schema section matching registry', () => {
          const parsed = extractSchemaJson(content, 'Output Schema');
          expect(parsed).toEqual(AGENT_REGISTRY[agentName].outputJsonSchema);
        });
      });
    }
  });

  it('should produce identical body content for both backends', async () => {
    for (const agentName of ALL_AGENT_NAMES) {
      const copilotContent = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
      const claudeContent = await readFile(join(claudeDir, `${agentName}.md`), 'utf-8');
      const { body: copilotBody } = parseFrontMatter(copilotContent);
      const { body: claudeBody } = parseFrontMatter(claudeContent);
      expect(copilotBody.trim(), `Body mismatch for "${agentName}"`).toBe(claudeBody.trim());
    }
  });

  it('should contain no unresolved partial directives in generated output', async () => {
    for (const agentName of ALL_AGENT_NAMES) {
      const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
      expect(content, `Unresolved partial in "${agentName}"`).not.toMatch(/\{\{>\s*[\w-]+\s*\}\}/);
    }
  });

  it('should contain no unresolved placeholder variables in generated output', async () => {
    for (const agentName of ALL_AGENT_NAMES) {
      const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
      // Match {{word}} but not {{> partial}}
      const unresolvedVars = content.match(/\{\{(?!>)[\w]+\}\}/g);
      expect(unresolvedVars, `Unresolved vars in "${agentName}": ${unresolvedVars}`).toBeNull();
    }
  });

  it('should contain no unresolved conditional blocks in generated output', async () => {
    for (const agentName of ALL_AGENT_NAMES) {
      const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
      expect(content, `Unresolved {{#if}} in "${agentName}"`).not.toMatch(/\{\{#if\s+[\w-]+\}\}/);
      expect(content, `Unresolved {{/if}} in "${agentName}"`).not.toContain('{{/if}}');
    }
  });
});

// ─── Lore Guidance Tests ─────────────────────────────────────────────────────
// Lore is always enabled — templates unconditionally include Lore guidance.

describe('generateAgentDefinitions() always includes Lore guidance', () => {
  let loreDir: string;

  beforeAll(async () => {
    loreDir = await mkdtemp(join(tmpdir(), 'aamf-lore-'));

    await generateAgentDefinitions({
      backend: 'copilot',
      outputDir: loreDir,
      templateDir: TEMPLATE_DIR,
      vars: { loreEnabled: 'true' },
    });
  });

  afterAll(async () => {
    await rm(loreDir, { recursive: true, force: true });
  });

  it('should include Lore guidance in code-migrator', async () => {
    const content = await readFile(join(loreDir, 'code-migrator.agent.md'), 'utf-8');
    expect(content).toContain('Lore Code-Intelligence Server (MANDATORY');
    expect(content).toContain('lore_search');
    expect(content).toContain('lore_lookup');
    expect(content).toContain('lore_graph');
  });

  it('should include Lore guidance in all KB-aware agent templates', async () => {
    const kbAwareAgents = [
      'knowledge-builder', 'migration-planner', 'adjudicator',
      'code-migrator', 'parity-verifier', 'test-writer', 'parity-failure-resolver',
      'final-parity-checker', 'e2e-test-crafter', 'documentation-writer',
      'idiomatic-reviewer', 'idiomatic-refactorer',
    ];
    for (const agent of kbAwareAgents) {
      const content = await readFile(join(loreDir, `${agent}.agent.md`), 'utf-8');
      expect(content, `${agent} should contain Lore guidance`).toContain('Lore Code-Intelligence Server (MANDATORY');
    }
  });

  it('should not contain any unresolved conditional blocks', async () => {
    for (const agentName of ALL_AGENT_NAMES) {
      const content = await readFile(join(loreDir, `${agentName}.agent.md`), 'utf-8');
      expect(content, `Unresolved {{#if}} in "${agentName}"`).not.toMatch(/\{\{#if\s+[\w-]+\}\}/);
      expect(content, `Unresolved {{/if}} in "${agentName}"`).not.toContain('{{/if}}');
    }
  });
});

// ─── stripSchemaSections unit tests ──────────────────────────────────────────

describe('stripSchemaSections()', () => {
  it('should remove ## Input Schema section', () => {
    const input = '# Title\n\nSome text.\n\n## Input Schema (Required)\n\n```json\n{}\n```\n\n## Next';
    const result = stripSchemaSections(input);
    expect(result).not.toContain('Input Schema');
    expect(result).toContain('# Title');
    expect(result).toContain('## Next');
  });

  it('should remove ## Output Schema section at end of file', () => {
    const input = '# Title\n\n## Output Schema (Required)\n\n```json\n{"type":"object"}\n```\n';
    const result = stripSchemaSections(input);
    expect(result).not.toContain('Output Schema');
    expect(result).toContain('# Title');
  });

  it('should remove both schema sections', () => {
    const input = [
      '# Agent',
      '',
      '## Responsibilities',
      'Do things.',
      '',
      '## Input Schema (Required)',
      '',
      '```json',
      '{"type": "object", "required": ["a"]}',
      '```',
      '',
      '## Output Schema (Required)',
      '',
      '```json',
      '{"type": "object", "required": ["b"]}',
      '```',
    ].join('\n');
    const result = stripSchemaSections(input);
    expect(result).not.toContain('Input Schema');
    expect(result).not.toContain('Output Schema');
    expect(result).toContain('## Responsibilities');
  });

  it('should leave content unchanged when no schema sections exist', () => {
    const input = '# Title\n\nSome text.\n\n## Other Section\n\nMore text.';
    expect(stripSchemaSections(input)).toBe(input);
  });
});

// ─── Front-matter parser unit tests ──────────────────────────────────────────

describe('parseFrontMatter helper', () => {
  it('should return empty frontMatter for content without delimiters', () => {
    const { frontMatter, body } = parseFrontMatter('just a body');
    expect(frontMatter).toEqual({});
    expect(body).toBe('just a body');
  });

  it('should parse simple key-value pairs', () => {
    const content = `---\nname: my-agent\ndescription: "A test agent"\n---\nbody here`;
    const { frontMatter, body } = parseFrontMatter(content);
    expect(frontMatter.name).toBe('my-agent');
    expect(frontMatter.description).toBe('A test agent');
    expect(body).toBe('body here');
  });

  it('should parse a YAML list under a key', () => {
    const content = `---\ntools:\n  - Read\n  - Write\n---\nbody`;
    const { frontMatter } = parseFrontMatter(content);
    expect(frontMatter.tools).toEqual(['Read', 'Write']);
  });
});

// ─── resolvePartials unit tests ──────────────────────────────────────────────

describe('resolvePartials()', () => {
  let tmpTemplateDir: string;

  beforeAll(async () => {
    tmpTemplateDir = await mkdtemp(join(tmpdir(), 'aamf-partials-'));
    await mkdir(join(tmpTemplateDir, '_partials'), { recursive: true });
    await writeFile(
      join(tmpTemplateDir, '_partials', 'greeting.md'),
      'Hello, world!',
    );
    await writeFile(
      join(tmpTemplateDir, '_partials', 'parameterized.md'),
      'Agent: {{agentName}}, Scope: {{scope}}',
    );
  });

  afterEach(() => {
    clearPartialsCache();
  });

  afterAll(async () => {
    await rm(tmpTemplateDir, { recursive: true, force: true });
  });

  it('should return content unchanged when no partials are referenced', async () => {
    const input = '# Title\n\nSome text.';
    expect(await resolvePartials(input, tmpTemplateDir)).toBe(input);
  });

  it('should resolve a single partial directive', async () => {
    const input = '# Title\n\n{{> greeting}}\n\nMore text.';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).toContain('Hello, world!');
    expect(result).not.toContain('{{> greeting}}');
  });

  it('should resolve multiple partial directives', async () => {
    const input = '{{> greeting}}\n\n{{> greeting}}';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).toBe('Hello, world!\n\nHello, world!');
  });

  it('should interpolate {{var}} placeholders after partial inclusion', async () => {
    const input = '{{> parameterized}}';
    const result = await resolvePartials(input, tmpTemplateDir, {
      agentName: 'code-migrator',
      scope: 'task-001',
    });
    expect(result).toBe('Agent: code-migrator, Scope: task-001');
  });

  it('should handle partial directives with surrounding whitespace', async () => {
    const input = '  {{> greeting}}  ';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).toContain('Hello, world!');
  });

  it('should throw when a referenced partial does not exist', async () => {
    const input = '{{> nonexistent}}';
    await expect(resolvePartials(input, tmpTemplateDir)).rejects.toThrow();
  });

  it('should resolve partial-like text inline within a line', async () => {
    const input = 'Some text {{> greeting}} more text';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).toBe('Some text Hello, world! more text');
  });

  // ─── {{#if var}} conditional block tests ─────────────────────────────

  it('should retain {{#if}} block content when variable is truthy', async () => {
    const input = 'Before\n{{#if flag}}Included\n{{/if}}\nAfter';
    const result = await resolvePartials(input, tmpTemplateDir, { flag: 'true' });
    expect(result).toContain('Included');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
  });

  it('should strip {{#if}} block content when variable is missing', async () => {
    const input = 'Before\n{{#if flag}}Removed\n{{/if}}\nAfter';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).not.toContain('Removed');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
  });

  it('should strip {{#if}} block content when variable is empty string', async () => {
    const input = 'Before\n{{#if flag}}Removed\n{{/if}}\nAfter';
    const result = await resolvePartials(input, tmpTemplateDir, { flag: '' });
    expect(result).not.toContain('Removed');
  });

  it('should handle nested {{#if}} blocks', async () => {
    const input = '{{#if a}}A-start {{#if b}}B-inner{{/if}} A-end{{/if}}';
    const result = await resolvePartials(input, tmpTemplateDir, { a: 'yes', b: 'yes' });
    expect(result).toContain('A-start');
    expect(result).toContain('B-inner');
    expect(result).toContain('A-end');
  });

  it('should strip inner block when nested variable is missing', async () => {
    const input = '{{#if a}}A-start {{#if b}}B-inner{{/if}} A-end{{/if}}';
    const result = await resolvePartials(input, tmpTemplateDir, { a: 'yes' });
    expect(result).toContain('A-start');
    expect(result).not.toContain('B-inner');
    expect(result).toContain('A-end');
  });

  it('should expand partial inside a conditional block when variable is truthy', async () => {
    const input = '{{#if flag}}\n{{> greeting}}\n{{/if}}';
    const result = await resolvePartials(input, tmpTemplateDir, { flag: 'true' });
    expect(result).toContain('Hello, world!');
  });

  it('should skip partial inside a conditional block when variable is missing', async () => {
    const input = '{{#if flag}}\n{{> greeting}}\n{{/if}}';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).not.toContain('Hello, world!');
  });

  it('should not leave excessive blank lines after stripping conditional blocks', async () => {
    const input = 'A\n\n{{#if flag}}\nRemoved\n{{/if}}\n\nB';
    const result = await resolvePartials(input, tmpTemplateDir);
    expect(result).not.toMatch(/\n{3,}/);
  });
});
