# Knowledge Base MCP — Implementation Plan

**Design doc**: [knowledge-base-mcp-design.md](./knowledge-base-mcp-design.md)  
**Date**: 2026-02-25  
**Status**: Active  
**Scope**: AAMF Runtime (`runtime/`)

---

## Overview

This document translates the RFC in [knowledge-base-mcp-design.md](./knowledge-base-mcp-design.md) into a concrete, ordered set of engineering tasks. Each milestone is self-contained and produces testable output. Milestones correspond to §10 of the design doc but are expanded here with exact file paths, dependency annotations, and integration notes.

---

## Dependency Graph (Milestone Order)

```
M1 (Core Indexer, DB, tree-sitter)
 ├─► M2 (Embeddings + sqlite-vec) ─┐
 │                                  ├─► M4 (MCP Server)
 └─► M3 (Call Graph) ──────────────┘
                                         └─► M5 (Orchestrator Integration)
                                              ├─► M6 (Agent Prompt Updates)
                                              │
                                    (M6 drafts may begin in parallel
                                     with M4–M5; finalize after M5
                                     integration testing)
```

M1–M3 are purely internal (no MCP, no orchestrator changes). M2 and M3 both depend on M1 only — they are independent of each other and can be worked in parallel. M4 depends on M2 **and** M3 both being complete. M5 depends on M4. M6 can be drafted in parallel with M4–M5 but must only be finalized after M5 is integration-tested.

---

## Package Dependencies to Install

Run from `runtime/`:

```bash
# SQLite + vector search
npm install better-sqlite3 sqlite-vec
npm install -D @types/better-sqlite3

# AST parsing
npm install tree-sitter

# Systems languages (required for current fixtures: zstd-c, lz4-c, jq-c, protobuf-upb-c, sqlite-c)
npm install tree-sitter-c tree-sitter-cpp tree-sitter-rust

# Scripting (tiny-python-project fixture)
npm install tree-sitter-python

# JS/TS (useful for indexing the runtime itself)
npm install tree-sitter-javascript tree-sitter-typescript

# Additional languages — install as needed; missing grammars are silently skipped
npm install tree-sitter-go tree-sitter-java tree-sitter-c-sharp
npm install tree-sitter-ruby tree-sitter-swift tree-sitter-kotlin
npm install tree-sitter-php tree-sitter-scala tree-sitter-objc
npm install tree-sitter-lua tree-sitter-zig tree-sitter-haskell
npm install tree-sitter-elixir tree-sitter-erlang tree-sitter-ocaml
npm install tree-sitter-julia tree-sitter-r tree-sitter-bash
npm install tree-sitter-fortran

# File walking
npm install fast-glob
npm install -D @types/fast-glob   # if type stubs not bundled

# MCP server
npm install @modelcontextprotocol/sdk

# Embedding backend (Python subprocess)
# sentence-transformers>=2.7.0 must be available in the Python environment
# No Node package needed; the provider shells out to python3
```

---

## Milestone 1 — Core Indexer

**Goal**: Parse any supported language source tree into `kb.db` (symbols + file deps, no embeddings yet).  
**Produces**: `runtime/src/indexer/` module, `runtime/tests/indexer.test.ts`.

### 1.1 Database Schema (`runtime/src/indexer/db.ts`)

Implement the full schema from [§2.2 of the design doc](./knowledge-base-mcp-design.md#22-database-schema):

- `files`, `symbols`, `file_imports`, `symbol_refs`, `external_deps`, `modules`, `file_modules`, `symbol_summaries`, `kb_meta`
- `symbol_embeddings` and `symbol_semantic_embeddings` are `vec0` virtual tables created dynamically in M2; leave DDL stubs with a `TODO(M2)` comment for now
- Export a `openDb(path: string, readOnly?: boolean): Database` helper
- Export typed prepared-statement helpers: `upsertFile`, `upsertSymbol`, `upsertImport`, `upsertCallRef`, `upsertExternalDep`

### 1.2 File Walker (`runtime/src/indexer/walker.ts`)

- Use `fast-glob` to enumerate source files respecting `includeGlobs` / `excludeGlobs`
- Detect language from file extension using a static extension-to-language map (sourced from §3.6 of the design doc)
- Export: `walkSourceTree(root: string, config: WalkerConfig): AsyncGenerator<SourceFile>`

### 1.3 Parser Pool (`runtime/src/indexer/parser.ts`)

- Maintain one `tree-sitter` `Parser` instance per language
- Try `require(`tree-sitter-${lang}`)` inside a `try/catch`; log a warning and skip the language if the grammar package is not installed
- Export: `parseFile(file: SourceFile): Tree | null`

### 1.4 Symbol Extractor Interface (`runtime/src/indexer/extractors/types.ts`)

```typescript
export interface RawSymbol { name: string; kind: SymbolKind; startLine: number; endLine: number; signature: string; docstring?: string; visibility?: string; isExported?: boolean; qualifiedName?: string; }
export interface RawImport { importSpec: string; isExternal: boolean; externalName?: string; resolvedPath?: string; }
export interface RawCallRef  { callerName: string; calleeName: string; refKind: RefKind; occurrenceCount: number; }
export interface SymbolExtractor { language: string; extensions: string[]; extractSymbols(tree: Tree, source: string, filePath: string): RawSymbol[]; extractImports(tree: Tree, source: string): RawImport[]; extractCallRefs(tree: Tree, source: string): RawCallRef[]; }
```

### 1.5 Language Extractors (`runtime/src/indexer/extractors/`)

Implement one file per language. Priority order matches existing test fixtures:

| Priority | File | Languages covered |
|----------|------|-------------------|
| P0 (required for current fixtures) | `c.ts` | C |
| P0 | `rust.ts` | Rust |
| P0 | `python.ts` | Python |
| P1 | `cpp.ts` | C++ |
| P1 | `typescript.ts` | TypeScript / TSX |
| P1 | `javascript.ts` | JavaScript / JSX |
| P2 | `go.ts` | Go |
| P2 | `java.ts` | Java |
| P2 | `csharp.ts` | C# |
| P3 | remaining 16 languages | per §3.6 of design doc |

Each extractor uses tree-sitter S-expression queries (see §3.1 of the design doc for the C example pattern). The C extractor is the reference implementation.

### 1.6 Import Resolver (`runtime/src/indexer/resolver.ts`)

- Maps `RawImport.importSpec` to a `to_file_id` in the `files` table
- Language strategies: `#include` path lookup (C/C++), `use`/`mod` resolution (Rust), relative `import` (Python/JS/TS), etc.
- Populates `file_imports.to_file_id` when resolution succeeds; leaves `NULL` with `is_external=1` for external packages
- Also reads language manifest files (`Cargo.toml`, `package.json`, `requirements.txt`, `go.mod`, `pom.xml`) to populate `external_deps`

### 1.7 Core `IndexBuilder` (`runtime/src/indexer/index.ts`)

Implement the `IndexBuilder` class and `IndexStats` interface from §4.2 of the design doc:

- `build()`: full walk → parse → extract → resolve → write to DB
- `update(changedFiles)`: re-hash, skip unchanged files, re-index changed ones
- `ingestSummary()`: stub that throws `Error('M2 not yet implemented')` — filled in M2
- Wire a `'kb-indexer'` `AgentName` entry for observability (see M5)

### 1.8 CLI Entry Point (`runtime/src/index.ts` — extend existing)

Add a `index` subcommand to the existing `commander` CLI:

```
aamf index build --source <path> --db <path> [--languages c,rust,python]
aamf index update --db <path> --files <file1,file2,...>
```

### 1.9 Tests (`runtime/tests/indexer.test.ts`)

- Parse `tests/fixtures/lz4-c-project/lz4-src/lz4-1.10.0/` — verify symbol count > 0, exported functions present
- Parse `tests/fixtures/tiny-python-project/` — verify `calculator.py` symbols, import edges
- Verify `file_imports` edges are bidirectionally consistent
- Verify incremental update: mutate a file hash, re-run `update()`, confirm only that file re-indexed

---

## Milestone 2 — Semantic Search (Embeddings + sqlite-vec)

**Goal**: Structural embeddings in `symbol_embeddings`; `kb_search` over them; write-back path for semantic embeddings.  
**Depends on**: M1 complete.

### 2.1 `EmbeddingProvider` Interface (`runtime/src/indexer/embedder.ts`)

Implement the interface from §3.4 of the design doc:

```typescript
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

### 2.2 `SentenceTransformersProvider` (`runtime/src/indexer/embedder.ts`)

- Spawns a Python subprocess; communicates via stdin/stdout newline-delimited JSON
- Ships a small inline Python bootstrap script (see §3.4 of the design doc)
- Supports `Qwen/Qwen3-Embedding-0.6B` (default), `4B`, and `8B`
- `embedQuery` uses the `"query"` prompt name for asymmetric encoding; `embed` uses `"passage"`

### 2.3 `Qwen3Embedding(size)` Factory

A convenience factory that returns a `SentenceTransformersProvider` with the correct `modelId` and `dimensions` for `'0.6B'` | `'4B'` | `'8B'`.

### 2.4 `kb_meta` Persistence

- Write `schema_version`, `embedding_provider`, `embedding_model`, `embedding_dimensions` to `kb_meta` at index creation
- On subsequent opens, validate that `embedding_dimensions` matches the active provider; throw if mismatched (model change requires rebuild)

### 2.5 Dynamic `vec0` DDL

Update `db.ts` to create `symbol_embeddings` and `symbol_semantic_embeddings` as `vec0` virtual tables with the correct `FLOAT[N]` dimension from `EmbeddingProvider.dimensions` (remove the M2 TODO stub).

### 2.6 Structural Embedding Population

In `IndexBuilder.build()`, after all symbols are written:
- Batch symbols into groups of `embeddingBatchSize` (default 64)
- Embed `"${name} ${signature} ${docstring ?? ''}"` for each symbol
- Write vectors to `symbol_embeddings`

### 2.7 `ingestSummary()` Implementation

- Write to `symbol_summaries` (summary text, migration_notes, timestamp)
- Embed summary text with `EmbeddingProvider.embed()`
- Write vector to `symbol_semantic_embeddings`

### 2.8 `kb_search` Logic (`runtime/src/kb-server/tools/search.ts`)

- `layer: 'structural'`: ANN query on `symbol_embeddings`
- `layer: 'semantic'`: ANN query on `symbol_semantic_embeddings`; degrade gracefully to structural if table is empty
- `layer: 'fused'` (default): run both queries, merge via reciprocal rank fusion (RRF with k=60)

### 2.9 Tests

- `tests/embedder.test.ts`: verify `SentenceTransformersProvider` spawns successfully, returns correct array shape. **Gate with `AAMF_EMBEDDER=1`** (skip by default in CI unless the flag is set) — the test requires `python3` with `sentence-transformers>=2.7.0` available in `PATH`. Add a `test.skipIf(!process.env.AAMF_EMBEDDER)` guard at the top of the file, consistent with how `AAMF_E2E` gates e2e tests.
- Add to `tests/indexer.test.ts`: after `build()`, verify `symbol_embeddings` row count matches symbol count
- Add `tests/search.test.ts`: verify RRF degrades to structural-only before any `ingestSummary` calls; verify mixed-layer search improves recall after a simulated write-back

---

## Milestone 3 — Call Graph

**Goal**: Populate `symbol_refs`; implement `kb_get_callers`, `kb_get_callees`, topological ordering, and cycle detection.  
**Depends on**: M1 complete. M2 is **not** required — call graph extraction is purely AST-based and reads only from `symbols`, `files`, and `file_imports` tables written in M1. M2 and M3 may be developed in parallel.

### 3.1 Call Graph Extractor (`runtime/src/indexer/call-graph.ts`)

- Post-processes `RawCallRef` from each extractor
- Resolves `to_name` → `to_symbol_id` by looking up `symbols` table (intra-file first, then cross-file)
- Writes edges to `symbol_refs`
- Best-effort only: unresolvable references leave `to_symbol_id = NULL`

### 3.2 Topological Sort (`runtime/src/indexer/call-graph.ts`)

Kahn's algorithm over `file_imports`:

```typescript
export function topologicalOrder(fileIds: number[], db: Database): { order: number[]; cycles: number[][] }
```

### 3.3 Cycle Detection

- Detect SCCs (Tarjan's or Kosaraju's) in the `file_imports` graph
- Return groups of file IDs that are mutually recursive

### 3.4 Tests (`runtime/tests/call-graph.test.ts`)

- Verify call edges extracted from `lz4-c-project`
- Verify `topologicalOrder` returns a valid ordering (no file appears before its dependency)
- Verify `topologicalOrder` returns non-empty `cycles` for a synthetic fixture with a mutual import

---

## Milestone 4 — MCP Server

**Goal**: A running `kb-mcp-server` (stdio transport) exposing all tools from §2.3.1 of the design doc.  
**Depends on**: M1–M3 complete.

### 4.1 Module Structure

Create `runtime/src/kb-server/` as specified in §5.1 of the design doc.

### 4.2 Read-Only DB Layer (`runtime/src/kb-server/db.ts`)

- Opens `KB_DB_PATH` (env var) in read-only mode via `better-sqlite3`
- Exports typed prepared-statement accessors: `findSymbolByName`, `getSymbolById`, `getFileSymbols`, `getImporters`, `getImportees`, etc.
- Re-exports read-only wrappers for M2's vector search queries

### 4.3 Tool Implementations

| File | Tools implemented |
|------|-------------------|
| `tools/lookup.ts` | `kb_find_symbol`, `kb_get_symbol`, `kb_get_file_symbols`, `kb_get_module_exports`, `kb_get_type_definition` |
| `tools/graph.ts` | `kb_get_callers`, `kb_get_callees`, `kb_get_file_consumers`, `kb_get_file_dependencies`, `kb_get_dependency_graph`, `kb_topological_order`, `kb_find_cycles` |
| `tools/search.ts` | `kb_search`, `kb_search_in_file`, `kb_find_similar` |
| `tools/snippet.ts` | `kb_get_snippet` (reads source file lines directly), `kb_get_symbol_body`, `kb_get_file_summary` |
| `tools/metrics.ts` | `kb_codebase_stats`, `kb_complexity_ranking`, `kb_large_files`, `kb_external_deps` |
| `tools/writeback.ts` | `kb_write_symbol_summary`, `kb_write_file_summaries` — these open a **separate read-write connection** directly (bypassing the server's read-only handle from §4.2) and call `IndexBuilder.ingestSummary()`. The read-only handle from §4.2 is used only for query tools; writeback opens its own short-lived connection, writes, then closes it. |

Each tool file exports an array of `{ name, description, inputSchema, handler }` objects that `server.ts` registers with the MCP SDK.

### 4.4 Server Bootstrap (`runtime/src/kb-server/server.ts`)

- Use `@modelcontextprotocol/sdk` stdio transport
- Register all tools from 4.3
- Read `KB_DB_PATH` from env; validate file exists on startup

### 4.5 CLI Entry (`runtime/src/index.ts` — extend)

```
aamf kb-server --db <path>
```

Starts the MCP server process (used by orchestrator and manual testing).

### 4.6 `KbServerProcess` Wrapper (`runtime/src/core/kb-server-process.ts`)

```typescript
export class KbServerProcess {
  constructor(dbPath: string) {}
  async start(): Promise<void>   // spawns the server, waits for ready signal
  async stop(): Promise<void>
  readonly mcpConfig: McpServerConfig  // JSON blob to inject into agents
}
```

`start()` spawn strategy: use `npx tsx src/kb-server/server.ts` during development (consistent with how the rest of the runtime is invoked). In production/CI, use `node dist/kb-server/server.js` after a `tsc` build. Gate on `process.env.NODE_ENV === 'production'` or a `AAMF_USE_COMPILED_KB_SERVER` flag. Note that M4 tests require the server to be startable **without** a pre-build step, so the `tsx` path must work.

### 4.7 Tests (`runtime/tests/kb-server.test.ts`)

- Start `KbServerProcess` against a pre-built `kb.db` from the lz4-c fixture
- Call `kb_find_symbol("lz4_compress_default")` — verify response shape
- Call `kb_topological_order([...all .c files...])` — verify ordering correctness
- Call `kb_codebase_stats` — verify non-zero counts
- Call `kb_get_snippet` — verify exact source lines returned

---

## Milestone 5 — Orchestrator Integration

**Goal**: Phase 0 runs before Phase 1; all agents receive MCP config; `kb-indexer` appears in observability.  
**Depends on**: M4 complete.

### 5.1 `AgentName` (extend `runtime/src/agents/types.ts`)

Add `'kb-indexer'` to the `AgentName` union (for observability — no LLM session created):

```typescript
export type AgentName =
  | 'kb-indexer'           // NEW — Phase 0 deterministic indexer
  | 'migration-orchestrator'
  // ... existing names
```

### 5.2 `agentOutputSchemas` (extend `runtime/src/core/agent-launcher.ts`)

Add `'kb-indexer': z.object({ filesIndexed: z.number(), symbolsExtracted: z.number(), durationMs: z.number() })` to the schema map.

### 5.3 Phase Registry (extend `runtime/src/core/phase-registry.ts`)

Add Phase 0 entry:

```typescript
{
  id: 0,
  name: 'Index Build',
  description: 'Deterministic AST indexing of source tree — builds kb.db',
  agents: ['kb-indexer'],
  critical: true,
  parallel: false,
}
```

Existing phase IDs 1–7 remain unchanged. Phase 0 is **not** executed through the normal phase loop — it runs via `executePhase0()` before the loop begins (see §5.4). The phase registry entry exists for observability and checkpoint purposes only.

### 5.4 `MigrationOrchestrator` (extend `runtime/src/core/orchestrator.ts`)

Following §5.2 of the design doc:

- Add `private kbServer?: KbServerProcess`
- Add private `executePhase0(): Promise<void>` that:
  1. Creates `IndexBuilder` with `sourceRoot`, `languages`, `dbPath = join(progressDir, 'kb.db')`
  2. Calls `builder.build()`
  3. Logs `{ phase: 0, event: 'index-built', ...stats }`
  4. Constructs and starts `KbServerProcess`
  5. Stores `this.kbServer`
- Call `executePhase0()` at the top of `run()`, before Phase 1
- Call `await this.kbServer?.stop()` in the cleanup block

### 5.5 `ContextBuilder` (extend `runtime/src/agents/context-builder.ts`)

`ContextBuilder` **owns MCP config construction**: when `kbServer` is active it calls `kbServer.mcpConfig` and attaches the resulting object to `AgentInvocation.mcpConfig`. `ContextBuilder` does not serialize or pass flags — it only populates the typed field. See §5.3 of the design doc for the exact JSON structure.

### 5.6 `AgentLauncher` (extend `runtime/src/core/agent-launcher.ts`)

`AgentLauncher` **owns MCP config serialization**: it reads `invocation.mcpConfig` (set by `ContextBuilder`) and passes it to the agent subprocess as `--mcp-config <json>`. It also injects `KB_DB_PATH` into the subprocess environment when `mcpConfig` is present. `AgentLauncher` never constructs config — it only serializes what `ContextBuilder` provides.

### 5.7 E2E Test (extend `runtime/tests/e2e-lz4-rust.test.ts`)

- Add a test variant that sets `AAMF_USE_KB_INDEX=1`
- Verify Phase 0 runs, `kb.db` is created, `kb-mcp-server` starts, and the migration completes successfully
- Assert `kb.db` contains `> 0` symbols and `> 0` file_imports rows

---

## Milestone 6 — Agent Prompt Updates

**Goal**: Update agent system prompts to use MCP tools instead of raw file reads.  
**Depends on**: M5 integration-tested (so prompt updates can be validated against a live server).

### Prompts to update

Prompts live in the agent definition files referenced by the orchestrator. Locate them with:

```bash
grep -r 'impact-assessor\|knowledge-builder\|migration-planner\|code-migrator' runtime/ --include='*.md' -l
```

| Agent | Key prompt changes (per §6 of the design doc) |
|-------|------------------------------------------------|
| `impact-assessor` | Replace grep/find section with `kb_codebase_stats`, `kb_complexity_ranking`, `kb_external_deps`, `kb_find_cycles` calls |
| `knowledge-builder` | Replace file-reading workflow with the 5-step MCP-first workflow from §9 of the design doc; add `kb_write_file_summaries` as the write-back step |
| `migration-planner` | Replace LLM-inferred ordering with `kb_topological_order` + `kb_find_cycles` |
| `code-migrator` | Replace source file read with `kb_get_snippet` + `kb_find_symbol` + `kb_get_callers` |

For each updated prompt, add an integration test asserting that the agent's output references MCP tool calls (or that the migration succeeds end-to-end using only index data).

---

## File Manifest

All new files to create, in dependency order:

```
runtime/src/indexer/
  db.ts                          M1.1
  walker.ts                      M1.2
  parser.ts                      M1.3
  extractors/
    types.ts                     M1.4
    c.ts                         M1.5 P0
    rust.ts                      M1.5 P0
    python.ts                    M1.5 P0
    cpp.ts                       M1.5 P1
    typescript.ts                M1.5 P1
    javascript.ts                M1.5 P1
    go.ts                        M1.5 P2
    java.ts                      M1.5 P2
    csharp.ts                    M1.5 P2
    ruby.ts                      M1.5 P3
    swift.ts                     M1.5 P3
    kotlin.ts                    M1.5 P3
    php.ts                       M1.5 P3
    scala.ts                     M1.5 P3
    objc.ts                      M1.5 P3
    lua.ts                       M1.5 P3
    zig.ts                       M1.5 P3
    haskell.ts                   M1.5 P3
    elixir.ts                    M1.5 P3
    erlang.ts                    M1.5 P3
    ocaml.ts                     M1.5 P3
    julia.ts                     M1.5 P3
    r.ts                         M1.5 P3
    bash.ts                      M1.5 P3
    fortran.ts                   M1.5 P3
  resolver.ts                    M1.6
  index.ts                       M1.7
  embedder.ts                    M2.1–M2.3
  call-graph.ts                  M3.1–M3.3

runtime/src/kb-server/
  server.ts                      M4.4
  db.ts                          M4.2
  tools/
    lookup.ts                    M4.3
    graph.ts                     M4.3
    search.ts                    M4.3 + M2.8
    snippet.ts                   M4.3
    metrics.ts                   M4.3
    writeback.ts                 M4.3

runtime/src/core/
  kb-server-process.ts           M4.6

runtime/tests/
  indexer.test.ts                M1.9 + M2.9
  embedder.test.ts               M2.9
  search.test.ts                 M2.9
  call-graph.test.ts             M3.4
  kb-server.test.ts              M4.7
```

Files modified (not created):

```
runtime/src/agents/types.ts          M5.1  — add 'kb-indexer' to AgentName
runtime/src/core/agent-launcher.ts   M5.2  — add schema entry, mcp-config injection
runtime/src/core/phase-registry.ts   M5.3  — add Phase 0
runtime/src/core/orchestrator.ts     M5.4  — executePhase0(), kbServer lifecycle
runtime/src/agents/context-builder.ts M5.5 — MCP config injection
runtime/src/index.ts                 M1.8, M4.5 — CLI subcommands
runtime/package.json                 all   — new dependencies
```

---

## Testing Strategy

| Level | Where | What |
|-------|-------|-------|
| Unit | `indexer.test.ts` | Symbol extraction per language, import edge correctness, incremental re-index |
| Unit | `embedder.test.ts` | Provider startup, shapes, asymmetric encoding |
| Unit | `call-graph.test.ts` | Call edge resolution, topological sort, cycle detection |
| Unit | `kb-server.test.ts` | Each MCP tool handler, read-only enforcement |
| Integration | `e2e-lz4-rust.test.ts` | Full migration with `AAMF_USE_KB_INDEX=1` |
| Integration | `e2e-zstd-rust.test.ts` | Second fixture validation |

Add `AAMF_USE_KB_INDEX` env flag (default `0`). When `1`, Phase 0 is enabled. E2E tests in CI run both with and without the flag to preserve backward compatibility during the transition.

---

## Open Questions (Tracked from Design Doc §11)

1. **Call graph fidelity in dynamic languages** — accepted limitation; topological ordering uses `file_imports` only, not call graph. Call graph is supplementary.

2. **Target codebase indexing** — deferred to Phase 5 implementation. When the `parity-verifier` phase arrives, spin up a second `IndexBuilder` / `KbServerProcess` against the target output directory with a separate `KB_DB_PATH`.

3. **`kb.db` in worktrees** — the file is written to `progressDir` (`.aamf/migration/{projectName}/kb.db`), consistent with existing checkpoint location. Worktrees at `~/.cadre/aamf/worktrees/` each get their own `progressDir`, so no collision.

---

## Acceptance Criteria for Completion

- [ ] `aamf index build` successfully indexes all current test fixtures without error
- [ ] `kb_find_symbol` returns correct results for known symbols in `lz4` and `zstd` fixtures
- [ ] `kb_topological_order` produces a valid ordering that matches the known dependency structure
- [ ] `kb_search` returns semantically relevant results without requiring `layer: 'structural'` override
- [ ] No LLM tokens consumed during Phase 0
