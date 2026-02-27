# Lore

Lore is the knowledge-base indexing project extracted from AAMF runtime.

It owns:
- source-tree walking and language detection
- tree-sitter parsing and symbol extraction
- import resolution and call graph construction
- SQLite schema + index persistence
- optional embedding pipeline for semantic search

## Build

```bash
npm install
npm run build
```

## Public API

Import from `@aamf/lore` for runtime integration.
