/**
 * Tests for the agent definition generator and shared templates.
 *
 * Verifies that:
 * - Templates exist for every registered agent
 * - Templates contain required Input/Output Schema sections
 * - Templates contain NO YAML front matter or example blocks
 * - Generation produces valid Copilot and Claude Code agent files
 * - Generated files have correct front matter per backend
 * - Generated file content matches the template body
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ALL_AGENT_NAMES, AGENT_REGISTRY } from '../src/agents/registry.js';
import { generateAgentDefinitions } from '../src/agents/generator.js';

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
        // Strip surrounding quotes
        frontMatter[currentKey] = rawValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  return { frontMatter, body };
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

      it('should contain an Input Schema section', () => {
        expect(content).toMatch(/##\s+Input Schema/);
      });

      it('should contain an Output Schema section', () => {
        expect(content).toMatch(/##\s+Output Schema/);
      });

      it('should contain a valid JSON code block in Input Schema', () => {
        const inputSection = content.slice(content.search(/##\s+Input Schema/));
        const jsonBlock = inputSection.match(/```json\r?\n([\s\S]*?)```/m);
        expect(jsonBlock).not.toBeNull();
        const parsed = JSON.parse(jsonBlock![1].trim());
        expect(parsed.type).toBe('object');
        expect(Array.isArray(parsed.required)).toBe(true);
      });

      it('should contain a valid JSON code block in Output Schema', () => {
        const outputIdx = content.search(/##\s+Output Schema/);
        const outputSection = content.slice(outputIdx);
        const jsonBlock = outputSection.match(/```json\r?\n([\s\S]*?)```/m);
        expect(jsonBlock).not.toBeNull();
        const parsed = JSON.parse(jsonBlock![1].trim());
        expect(parsed.type).toBe('object');
        expect(Array.isArray(parsed.required)).toBe(true);
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

    for (const agentName of ALL_AGENT_NAMES) {
      describe(`${agentName}.agent.md`, () => {
        it('should have Title Case name in front matter', async () => {
          const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.name).toBe(AGENT_REGISTRY[agentName].displayName);
        });

        it('should have a description matching the registry', async () => {
          const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.description).toBe(AGENT_REGISTRY[agentName].description);
        });

        it('should have JSON-array tools in front matter', async () => {
          const content = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          // Copilot tools are on the same line as `tools:` as a JSON array
          const toolsStr = frontMatter.tools as unknown as string;
          const parsed = JSON.parse(toolsStr);
          expect(parsed).toEqual([...AGENT_REGISTRY[agentName].copilotTools]);
        });

        it('should contain the template body after front matter', async () => {
          const generated = await readFile(join(copilotDir, `${agentName}.agent.md`), 'utf-8');
          const template = await readFile(join(TEMPLATE_DIR, `${agentName}.md`), 'utf-8');
          const { body } = parseFrontMatter(generated);
          expect(body.trim()).toBe(template.trim());
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

    for (const agentName of ALL_AGENT_NAMES) {
      describe(`${agentName}.md`, () => {
        it('should have kebab-case name matching agent name', async () => {
          const content = await readFile(join(claudeDir, `${agentName}.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.name).toBe(agentName);
        });

        it('should have YAML-list tools in front matter', async () => {
          const content = await readFile(join(claudeDir, `${agentName}.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(Array.isArray(frontMatter.tools)).toBe(true);
          expect(frontMatter.tools).toEqual([...AGENT_REGISTRY[agentName].claudeTools]);
        });

        it('should contain the template body after front matter', async () => {
          const generated = await readFile(join(claudeDir, `${agentName}.md`), 'utf-8');
          const template = await readFile(join(TEMPLATE_DIR, `${agentName}.md`), 'utf-8');
          const { body } = parseFrontMatter(generated);
          expect(body.trim()).toBe(template.trim());
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
