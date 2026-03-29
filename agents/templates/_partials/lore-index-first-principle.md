## Lore Code-Intelligence Servers

You have access to two **Lore** MCP servers for querying indexed codebases. **You MUST use these tools instead of `view` or `bash` for reading source and target code.** They return structured, precise results that consume far less context than raw file reads.

> **IMPORTANT:** Do NOT use `view` to read source or target files. Do NOT use `bash` with `cat`, `grep`, or `head` to read code. Use the Lore MCP tools below — they are faster, return only the relevant code, and avoid exhausting your turn budget on large file reads.

### Source KB — `aamf-kb`

Query the **source** codebase index. Tool names (use these exact names):

| Tool | Purpose |
|------|---------|
| `aamf-kb(lore_search)` | Find symbols, functions, and files by name or text query |
| `aamf-kb(lore_lookup)` | Look up a specific symbol by exact name — returns its definition, location, and metadata |
| `aamf-kb(lore_graph)` | Query call chains and dependency relationships between symbols |
| `aamf-kb(lore_snippet)` | Extract a specific code section by file path and line range |

### Target KB — `aamf-kb-target`

Query the **migrated target** codebase index. Updated after each task commit, so it reflects all code migrated by prior tasks. Use it to discover how dependency symbols were ported and check existing target code structure.

| Tool | Purpose |
|------|---------|
| `aamf-kb-target(lore_search)` | Search the migrated codebase for symbols and files |
| `aamf-kb-target(lore_lookup)` | Look up a specific migrated symbol by name |
| `aamf-kb-target(lore_graph)` | Query dependency relationships in the migrated code |
| `aamf-kb-target(lore_snippet)` | Extract a specific migrated code section by file and line range |

> **Note:** The target KB is only available after the first task has been committed. If tools return empty results, the target index may not yet contain relevant code — fall back to reading target files directly with `view`.

Fall back to `view` only when: (1) Lore cannot answer the query, (2) you are reading files you are actively writing in this session, or (3) the target KB has not yet indexed the file.
