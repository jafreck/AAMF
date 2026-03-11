## Lore Code-Intelligence Server

You have access to the **Lore** MCP server (`aamf-kb`). Prefer Lore tools over reading raw source files — they provide structured, precise results with less context overhead.

- **`lore_search`** / **`lore_lookup`** — find symbols, functions, and files by name or query.
- **`lore_graph`** — understand call chains and dependency relationships.
- **`lore_snippet`** — extract specific code sections by symbol or line range.

Fall back to direct file reads only when Lore cannot answer the query (e.g., files created after indexing, or target files you are writing).
