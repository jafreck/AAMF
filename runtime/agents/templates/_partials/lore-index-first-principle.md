## Lore Code-Intelligence Server (MANDATORY — READ THIS FIRST)

You have access to the **Lore** MCP server (`aamf-kb`). It is running and available right now.

### CRITICAL: Your very first tool call MUST be a Lore tool

Before doing ANYTHING else — before reading any file, before running any shell command — you MUST call one of the Lore MCP tools listed below. This is not optional. Start with `lore_search` or `lore_lookup` to understand the code you need to work with.

**If you skip Lore and read source files directly via `cat`, `head`, shell commands, or file-read tools, you are wasting tokens and violating your instructions.**

### Available Lore MCP Tools (server: `aamf-kb`)

| Tool | Purpose | Use When |
|---|---|---|
| `lore_search` | Structural, semantic, and fused code search | Finding functions, types, or code patterns |
| `lore_lookup` | Look up symbols by name or ID | You know the symbol name |
| `lore_graph` | Query call graphs and dependency graphs | Understanding what calls what |
| `lore_snippet` | Extract source-code snippets by symbol or line range | Reading specific code sections |
| `lore_docs` | List, get, or search indexed documentation | Finding docs/comments |
| `lore_metrics` | Aggregate code metrics (LOC, complexity, symbol counts) | Understanding code size/complexity |
| `lore_test_map` | Map source files to test files | Finding associated tests |
| `lore_annotations` | Read code annotations and markers | Finding TODOs, markers |
| `lore_architecture` | Query high-level architecture information | Understanding module structure |
| `lore_blame` | Git blame metadata | Understanding code history |
| `lore_history` | Git commit history | Finding recent changes |
| `lore_coverage` | Code coverage data | Understanding test coverage |
| `lore_routes` | API route/endpoint information | Finding API endpoints |

### Required Workflow

1. **Your first action** must be a `lore_lookup` or `lore_search` call — never a file read or shell command.
2. **Use `lore_snippet`** to read specific code sections instead of `cat` or direct file reads.
3. **Use `lore_graph`** to understand dependencies and call chains instead of grepping imports.
4. **Only fall back to direct file reads** when Lore genuinely cannot answer the query (e.g., files created after indexing, or the output target files you are writing).

> **VIOLATION**: Using `cat`, `head`, `tail`, `grep`, or any shell command to read SOURCE files when Lore can answer the query. Source files are fully indexed in Lore — use it.
