import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultParser } from '../src/agents/result-parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('ResultParser', () => {
  describe('parseMigrationPlanContent', () => {
    it('should parse tasks from migration plan markdown', async () => {
      const content = await readFile(join(__dirname, 'fixtures', 'sample-migration-plan.md'), 'utf-8');
      const tasks = ResultParser.parseMigrationPlanContent(content);
      
      expect(tasks).toHaveLength(3);
      expect(tasks[0]?.id).toBe('task-001');
      expect(tasks[0]?.name).toContain('User Authentication');
      expect(tasks[0]?.complexity).toBe('moderate');
      expect(tasks[0]?.sourceFiles).toContain('src/auth/login.py');
      expect(tasks[0]?.dependencies).toHaveLength(0);
      
      expect(tasks[1]?.id).toBe('task-002');
      expect(tasks[1]?.dependencies).toContain('task-001');
      
      expect(tasks[2]?.id).toBe('task-003');
      expect(tasks[2]?.dependencies).toContain('task-001');
      expect(tasks[2]?.dependencies).toContain('task-002');
    });
  });

  describe('parseTokenUsage', () => {
    it('should parse prompt and completion tokens', () => {
      const output = 'prompt_tokens: 1500\ncompletion_tokens: 800\ntotal_tokens: 2300';
      const usage = ResultParser.parseTokenUsage(output);
      expect(usage).toEqual({ prompt: 1500, completion: 800, total: 2300 });
    });

    it('should parse total-only format', () => {
      const output = 'Total tokens: 5000';
      const usage = ResultParser.parseTokenUsage(output);
      expect(usage).toBeDefined();
      expect(usage?.total).toBe(5000);
    });

    it('should return undefined for no token info', () => {
      const usage = ResultParser.parseTokenUsage('some output with no tokens');
      expect(usage).toBeUndefined();
    });
  });
});
