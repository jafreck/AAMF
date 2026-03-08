## Lore Code-Intelligence Server (MANDATORY)

You have access to the **Lore** MCP server (`aamf-kb`). It is running and available right now. You MUST use it as your primary source of code intelligence. Lore is faster, more precise, and dramatically reduces the context you need to load compared to reading raw source files.

### Available Lore Tools

| Tool | Purpose |
|---|---|
| `lore_search` | Structural, semantic, and fused code search across the indexed codebase |
| `lore_lookup` | Look up symbols (functions, types, structs) and files by name or ID |
| `lore_graph` | Query call graphs and import/dependency graphs |
| `lore_snippet` | Extract source-code snippets by symbol or line range |
| `lore_docs` | List, get, or search indexed documentation |
| `lore_metrics` | Retrieve aggregate code metrics (LOC, complexity, symbol counts) |
| `lore_test_map` | Map source files to their associated test files |
| `lore_annotations` | Read code annotations and markers |
| `lore_architecture` | Query high-level architecture information |
| `lore_blame` | Git blame metadata for file lines |
| `lore_history` | Git commit history queries |
| `lore_coverage` | Code coverage data |
| `lore_routes` | API route and endpoint information |

### Required Workflow

1. **Before reading any source file**, call `lore_search` or `lore_lookup` first to find exactly what you need.
2. **Use `lore_graph`** to understand dependencies and call chains instead of scanning imports manually.
3. **Use `lore_snippet`** to extract specific code sections instead of reading entire files.
4. **Only fall back to direct file reads** when Lore cannot satisfy the query (e.g. the file was created after indexing).

> **Do NOT skip Lore tools.** Reading source files directly when Lore can answer the question wastes context and slows you down.
