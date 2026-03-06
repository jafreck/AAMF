import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('task-decomposer.tasks.schema.json — ID pattern', () => {
  let schema: {
    items: {
      properties: {
        id: { pattern: string };
        dependencies: { items: { pattern: string } };
      };
    };
  };

  const schemaPath = resolve(
    import.meta.dirname,
    '../../src/agents/task-decomposer.tasks.schema.json',
  );

  it('should load schema successfully', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    expect(schema).toBeDefined();
  });

  it('should allow standard task IDs like task-001', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const pattern = new RegExp(schema.items.properties.id.pattern);
    expect(pattern.test('task-001')).toBe(true);
    expect(pattern.test('task-999')).toBe(true);
  });

  it('should allow sub-task IDs like task-001a', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const pattern = new RegExp(schema.items.properties.id.pattern);
    expect(pattern.test('task-001a')).toBe(true);
    expect(pattern.test('task-002b')).toBe(true);
  });

  it('should reject IDs with uppercase suffix', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const pattern = new RegExp(schema.items.properties.id.pattern);
    expect(pattern.test('task-001A')).toBe(false);
  });

  it('should reject IDs with multiple letter suffixes', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const pattern = new RegExp(schema.items.properties.id.pattern);
    expect(pattern.test('task-001ab')).toBe(false);
  });

  it('should allow sub-task IDs in the dependencies pattern', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const depPattern = new RegExp(schema.items.properties.dependencies.items.pattern);
    expect(depPattern.test('task-001')).toBe(true);
    expect(depPattern.test('task-001a')).toBe(true);
    expect(depPattern.test('task-002b')).toBe(true);
  });

  it('should reject invalid dependency IDs', async () => {
    const raw = await readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
    const depPattern = new RegExp(schema.items.properties.dependencies.items.pattern);
    expect(depPattern.test('task-001AB')).toBe(false);
    expect(depPattern.test('invalid')).toBe(false);
  });
});
