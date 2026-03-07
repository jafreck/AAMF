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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ALL_AGENT_NAMES, AGENT_REGISTRY } from '../src/agents/registry.js';
import { generateAgentDefinitions, stripSchemaSections } from '../src/agents/generator.js';

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
