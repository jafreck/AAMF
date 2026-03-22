## Lore Code-Intelligence Servers

You have access to two **Lore** MCP servers for querying indexed codebases. Both expose the same four tools — `lore_search`, `lore_lookup`, `lore_graph`, `lore_snippet` — but operate on different indexes. Check your available tool list to find the exact tool names for each server.

### Source KB — server name `aamf-kb`

The **source** codebase index. Prefer Lore tools over reading raw source files — they provide structured, precise results with less context overhead.

- **`lore_search`** / **`lore_lookup`** — find symbols, functions, and files by name or query.
- **`lore_graph`** — understand call chains and dependency relationships.
- **`lore_snippet`** — extract specific code sections by symbol or line range.

### Target KB — server name `aamf-kb-target`

The **migrated target** codebase index. Updated incrementally after each task commit, so it reflects all code migrated by prior tasks. Use it to discover how dependency symbols were ported, check existing target code structure, and avoid re-implementing or conflicting with work from earlier tasks.

The target KB exposes the same four tools as the source KB, but queries the migrated codebase.

> **Note:** The target KB is only available after the first task has been committed. If tools return empty results, the target index may not yet contain relevant code — fall back to reading target files directly.

Fall back to direct file reads only when Lore cannot answer the query (e.g., files created after indexing, or target files you are actively writing).
