/**
 * @module kb-server/tools/snippet
 *
 * MCP tool: extract source-code snippets for a given file path and
 * optional line range directly from the filesystem.
 */

import { readFileSync } from 'node:fs';
import type { Database } from '../db.js';
import { getFileByPath } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_snippet',
  description:
    'Return the source lines for a given file path (as recorded in the index). ' +
    'Optionally restrict the output to a line range using `start_line` and `end_line` ' +
    '(1-based, inclusive).  Returns the raw source text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute file path as stored in the knowledge-base index.',
      },
      start_line: {
        type: 'number',
        description: 'First line to include (1-based, inclusive).  Defaults to 1.',
      },
      end_line: {
        type: 'number',
        description: 'Last line to include (1-based, inclusive).  Defaults to end-of-file.',
      },
    },
    required: ['path'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface SnippetArgs {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface SnippetResult {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
}

/** Read source lines from the filesystem for the given indexed file path. */
export function handler(db: Database.Database, args: SnippetArgs): SnippetResult {
  // Confirm the path is known to the index.
  const fileRow = getFileByPath(db, args.path);
  if (!fileRow) {
    throw new Error(`File not found in index: ${args.path}`);
  }

  const raw = readFileSync(args.path, 'utf8');
  const lines = raw.split('\n');

  const startLine = Math.max(1, args.start_line ?? 1);
  const endLine = Math.min(lines.length, args.end_line ?? lines.length);

  // slice is 0-based; lines are 1-based
  const text = lines.slice(startLine - 1, endLine).join('\n');

  return { path: args.path, start_line: startLine, end_line: endLine, text };
}
