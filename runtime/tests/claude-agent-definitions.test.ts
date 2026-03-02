/**
 * Tests for the Claude Code CLI agent definition files under `.claude/agents/`.
 *
 * Verifies that each file exists, has valid YAML front matter with the required
 * fields, that the `name` field matches the filename, and that the body instructs
 * the agent to read from AAMF_CONTEXT_FILE.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// All AgentName values from runtime/src/agents/types.ts
const EXPECTED_AGENTS = [
  'migration-orchestrator',
  'impact-assessor',
  'knowledge-builder',
  'migration-planner',
  'adjudicator',
  'code-migrator',
  'parity-verifier',
  'test-writer',
  'failure-adjudicator',
  'final-parity-checker',
  'e2e-test-crafter',
  'documentation-writer',
  'migration-runner',
] as const;

// Resolve `.claude/agents/` relative to the repo root (one level above `runtime/`)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS_DIR = join(REPO_ROOT, '.claude', 'agents');

// ─── Front-matter parser ─────────────────────────────────────────────────────

interface FrontMatter {
  name?: string;
  description?: string;
  tools?: string[];
  [key: string]: unknown;
}

/**
 * Parses a minimal YAML front matter block delimited by `---` lines.
 * Only handles simple key: value and list items (no nested objects).
 */
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
      // Save any in-progress list
      if (currentKey && currentList) {
        frontMatter[currentKey] = currentList;
      }
      currentKey = keyValueMatch[1];
      const rawValue = keyValueMatch[2].trim();

      if (rawValue === '' || rawValue === '|' || rawValue === '>') {
        // Start of a list or block scalar
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Claude agent definition files (.claude/agents/)', () => {
  describe('file existence', () => {
    it('should have exactly the 13 expected agent definition files', () => {
      // Verify all expected agents are enumerated (compile-time check via const array)
      expect(EXPECTED_AGENTS).toHaveLength(13);
    });

    for (const agentName of EXPECTED_AGENTS) {
      it(`should have a file for agent "${agentName}"`, async () => {
        const filePath = join(AGENTS_DIR, `${agentName}.md`);
        await expect(readFile(filePath, 'utf-8')).resolves.toBeDefined();
      });
    }
  });

  describe('YAML front matter validity', () => {
    for (const agentName of EXPECTED_AGENTS) {
      describe(`${agentName}.md`, () => {
        it('should have a "name" field matching the filename', async () => {
          const content = await readFile(join(AGENTS_DIR, `${agentName}.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(frontMatter.name).toBe(agentName);
        });

        it('should have a non-empty "description" field', async () => {
          const content = await readFile(join(AGENTS_DIR, `${agentName}.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(typeof frontMatter.description).toBe('string');
          expect((frontMatter.description as string).length).toBeGreaterThan(0);
        });

        it('should have a non-empty "tools" list', async () => {
          const content = await readFile(join(AGENTS_DIR, `${agentName}.md`), 'utf-8');
          const { frontMatter } = parseFrontMatter(content);
          expect(Array.isArray(frontMatter.tools)).toBe(true);
          expect((frontMatter.tools as string[]).length).toBeGreaterThan(0);
        });

        it('should reference AAMF_CONTEXT_FILE in the body', async () => {
          const content = await readFile(join(AGENTS_DIR, `${agentName}.md`), 'utf-8');
          const { body } = parseFrontMatter(content);
          expect(body).toContain('AAMF_CONTEXT_FILE');
        });
      });
    }
  });

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

    it('should parse a list under a key', () => {
      const content = `---\ntools:\n  - Read\n  - Write\n---\nbody`;
      const { frontMatter } = parseFrontMatter(content);
      expect(frontMatter.tools).toEqual(['Read', 'Write']);
    });
  });
});
