# Knowledge Base Construction — Deep Investigation & Redesign

**Date**: 2026-02-25  
**Status**: Proposal / RFC  
**Scope**: AAMF Phase 2 (Knowledge Base Construction) and all downstream consumers

---

## 1. Current State Analysis

### 1.1 What exists today

The AAMF knowledge base pipeline is entirely **LLM-driven**:

```
Phase 1: impact-assessor
  └─ Reads source tree with grep/find/wc
  └─ Writes: impact-assessment.md

Phase 2: knowledge-builder
  └─ Reads source files module-by-module
  └─ Writes: knowledge-base/index.md
            knowledge-base/architecture.md
            knowledge-base/patterns.md
            knowledge-base/data-models.md
            knowledge-base/integrations.md
            knowledge-base/modules/{name}.md
  └─ Delegates large files (>500 lines) to: large-file-analyzer
     └─ Writes: knowledge-base/large-files/{name}.analysis.md

Phase 3: migration-planner
  └─ Reads KB markdown files
  └─ Creates task list referencing KB entries

Phase 4: code-migrator (per task)
  └─ Reads: task-plan-slice.md + knowledge-base/modules/{name}.md + source file
  └─ Writes target code
```

The knowledge base is a **collection of Markdown files** produced by an LLM reading source code. All agent interactions with the KB are file reads.

### 1.2 Fundamental Problems

#### Problem 1: LLM-produced documentation is lossy and unreliable

When the `knowledge-builder` agent reads `parser.c` (3 000 lines), it produces a Markdown document describing `parser.c`. That document necessarily omits information and may contain hallucinations. The `code-migrator` that later reads that Markdown makes decisions based on a lossy, unverifiable summary.

- **Missing symbols**: An LLM may document 80/120 exported functions, silently skipping 40.
- **Wrong dependency lists**: "Imports: `lexer.h`, `ast.h`" may omit `util/arena.h` that's actually `#include`d.
- **Incorrect signatures**: Function signatures paraphrased rather than verbatim-extracted.
- **Stale KB**: If a source file is large and complex, the LLM's notes about it may contradict the actual code in subtle ways.

#### Problem 2: Context window saturation during KB construction

The `knowledge-builder` must read every source file. For a 100 000-line codebase this is ~70 000–100 000+ tokens of source code flowing through a single agent's session. Even with module-by-module processing, each invocation is large and there is no good way to share a derived, compressed representation between invocations.

#### Problem 3: The KB is not queryable

A `code-migrator` working on `engine.c` needs to answer:
- "What other files call `engine_step()`?"
- "What does `arena_t` actually look like?"
- "What is the full signature of `parse_token()` including its error contract?"

Today, the answer lives somewhere in the KB Markdown — maybe. The agent has to load its assigned KB document and hope it contains the answer. If the dependency the migrator needs was documented in a different module's KB entry it may not have been given to that agent, because context routing passes only the *directly relevant* KB entry.

#### Problem 4: No programmatic dependency ordering

The `migration-planner` decides task order based on the KB's prose description of dependencies. This is:
- Imprecise (LLM summaries of "what imports what")
- Not machine-verifiable
- Prone to producing plans with hidden cycles or under-specified dependencies

#### Problem 5: Semantic search is absent

There is no way to ask "find all functions in the codebase that perform base64 encoding" or "show me all places an HTTP client is constructed". Agents resort to grep-in-agent, which consumes context and is slow.

---

## 2. Proposed Architecture

The central idea is to separate **deterministic extraction** from **semantic interpretation**, then expose both through an **MCP server** that agents query on-demand.

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 0: Index Build (deterministic, pre-LLM)                  │
│                                                                 │
│  Source Tree ──► tree-sitter Parser ──► Symbol Extractor        │
│                                              │                  │
│                              ┌───────────────┼─────────────┐   │
│                              ▼               ▼             ▼   │
│                         symbols.db      dep_graph       embeddings │
│                         (SQLite)        (SQLite)        (sqlite-vec)│
│                              └───────────────┴─────────────┘   │
│                                        kb.db                   │
└─────────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  kb-mcp-server              │
                    │  (Model Context Protocol)   │
                    │                             │
                    │  tools: search, lookup,     │
                    │  graph traversal, snippets  │
                    └──────────────┬──────────────┘
                                   │ MCP
           ┌───────────────────────┼──────────────────────┐
           ▼                       ▼                       ▼
    impact-assessor         knowledge-builder        code-migrator
    migration-planner       large-file-analyzer      parity-verifier
                            etc.
```

### 2.1 Phase 0: Deterministic Index Build

Before any LLM agent is invoked, a **deterministic indexer** runs against the source tree. This is a TypeScript process (fits within the existing `aamf-runtime` build) that:

1. Walks the source tree using `fast-glob`
2. For each source file, invokes `tree-sitter` to parse it into an AST
3. Visits the AST to extract:
   - All top-level declarations (functions, methods, classes, structs, enums, interfaces, type aliases, constants, macros)
   - Their exact locations (file, start line, end line)
   - Their verbatim signatures (first N lines of the declaration)
   - Their docstrings/comments if present
4. Resolves import/include/use statements to build a **file-level dependency graph**
5. Resolves call expressions to build a **symbol-level call graph** (best-effort)
6. Generates **structural embeddings** for each symbol (name + signature + docstring) using a local embedding model
7. Stores everything in `kb.db` (SQLite + `sqlite-vec`)

This step is **entirely deterministic** — the same source tree always produces the same index. It does not consume LLM tokens.

#### 2.1.1 Knowledge-Builder Write-Back (Existing Phase 2)

After the `knowledge-builder` agent completes (the existing Phase 2, unchanged in name), it writes behavioral summaries for each symbol back into `kb.db` via `kb_write_symbol_summary`. These are re-embedded to produce **semantic embeddings** that capture intent and behavior rather than just syntax. `kb_search` queries both embedding layers and merges results via *reciprocal rank fusion (RRF)* — a rank-merging algorithm that combines results from both embedding layers without requiring score normalization — meaning semantic search improves progressively as the KB is built. See §9.1 ("Why Two Embedding Layers?") for a detailed explanation of the structural/semantic distinction.

#### 2.1.2 Time Budget

For a 100 000-line codebase, tree-sitter parsing is ~1–5 seconds total on modern hardware. Embedding generation (batch) is the dominant cost, ~30–120 seconds using a local embedding model. This is a one-time cost per source snapshot.

### 2.2 Database Schema

```sql
-- Files indexed
CREATE TABLE files (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,  -- relative to source root
  language   TEXT NOT NULL,
  lines      INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  hash       TEXT NOT NULL          -- sha256 for change detection
);

-- Every declaration-level symbol
CREATE TABLE symbols (
  id           INTEGER PRIMARY KEY,
  file_id      INTEGER NOT NULL REFERENCES files(id),
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- 'function' | 'class' | 'struct' | 'enum'
                                     -- | 'interface' | 'type' | 'constant' | 'macro'
                                     -- | 'method' | 'field' | 'variable'
  qualified_name TEXT,               -- e.g. "MyClass::method"
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  signature    TEXT NOT NULL,        -- verbatim first line(s) of declaration
  docstring    TEXT,                 -- extracted doc comment if any
  visibility   TEXT,                 -- 'public' | 'private' | 'internal' | 'exported'
  is_exported  INTEGER NOT NULL DEFAULT 0  -- 1 if exported from its module
);

-- File-level import/include/use edges
CREATE TABLE file_imports (
  from_file_id   INTEGER NOT NULL REFERENCES files(id),
  to_file_id     INTEGER REFERENCES files(id),  -- NULL if external
  import_spec    TEXT NOT NULL,                   -- raw import string
  is_external    INTEGER NOT NULL DEFAULT 0,
  external_name  TEXT                             -- package/crate name if external
);

-- Symbol-level call/reference edges (best-effort from AST)
CREATE TABLE symbol_refs (
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id),
  to_symbol_id   INTEGER REFERENCES symbols(id),  -- NULL if unresolved
  to_name        TEXT NOT NULL,                    -- unresolved name if to_symbol_id is NULL
  ref_kind       TEXT NOT NULL,                    -- 'calls' | 'inherits' | 'implements'
                                                   -- | 'uses_type' | 'instantiates'
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

-- External package dependencies (language-level: package.json, Cargo.toml, etc.)
CREATE TABLE external_deps (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  version  TEXT,
  dep_kind TEXT NOT NULL  -- 'runtime' | 'dev' | 'build'
);

-- Modules / packages (logical groupings of files)
CREATE TABLE modules (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL  -- directory path relative to source root
);

CREATE TABLE file_modules (
  file_id   INTEGER NOT NULL REFERENCES files(id),
  module_id INTEGER NOT NULL REFERENCES modules(id)
);

-- Symbol behavioral summaries (written by knowledge-builder agent in Phase 2)
CREATE TABLE symbol_summaries (
  symbol_id    INTEGER PRIMARY KEY REFERENCES symbols(id),
  summary      TEXT NOT NULL,       -- LLM-written behavioral description (2-5 sentences)
  migration_notes TEXT,             -- migration-specific observations
  written_at   TEXT NOT NULL        -- ISO timestamp
);

-- Index metadata: persists model choice and dimensions so subsequent opens can validate
-- compatibility and the MCP server knows how to embed query strings.
CREATE TABLE kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
  -- keys: 'schema_version', 'embedding_provider', 'embedding_model', 'embedding_dimensions'
  -- e.g.: '1', 'sentence-transformers', 'Qwen/Qwen3-Embedding-0.6B', '1024'
);

-- Structural embeddings: embed(name + signature + docstring), written by Phase 0 indexer.
-- The vec0 DDL is generated dynamically by IndexBuilder based on kb_meta.embedding_dimensions.
-- Example for Qwen3-Embedding-0.6B (1024 dims); 8B variant would use FLOAT[4096]:
CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
  symbol_id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]             -- actual dimension from EmbeddingProvider.dimensions
);

-- Semantic embeddings: embed(behavioral summary), written by Phase 2 knowledge-builder.
-- Stored separately so queries can explicitly target structural vs. semantic search
-- or fuse both via reciprocal rank fusion (RRF).
-- Must use the same dimensions as symbol_embeddings.
CREATE VIRTUAL TABLE symbol_semantic_embeddings USING vec0(
  symbol_id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]             -- same dimension as symbol_embeddings; set from EmbeddingProvider.dimensions
);
```

### 2.3 MCP Server: `kb-mcp-server`

The MCP server is a standalone Node.js process that opens `kb.db` read-only and exposes tools to any connected MCP client. AAMF agents are launched with MCP client configuration pointing to `kb-mcp-server`, giving them access to the knowledge base without ever reading a source file.

#### 2.3.1 Tool Catalog

**Symbol Lookup & Navigation**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `kb_find_symbol` | Find a symbol by name (exact or fuzzy) | `name`, `kind?`, `file?` |
| `kb_get_symbol` | Get full details for a symbol by ID | `symbol_id` |
| `kb_get_file_symbols` | List all symbols declared in a file | `file_path`, `kind?`, `exported_only?` |
| `kb_get_module_exports` | All exported symbols from a module | `module_name` |
| `kb_get_type_definition` | Expand a type/class/struct fully | `name` |

**Dependency Graph Traversal**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `kb_get_callers` | All symbols that call this symbol | `name`, `file?`, `depth?` |
| `kb_get_callees` | All symbols this symbol calls | `name`, `file?`, `depth?` |
| `kb_get_file_consumers` | Files that import a given file | `file_path` |
| `kb_get_file_dependencies` | Files imported by a given file | `file_path` |
| `kb_get_dependency_graph` | Subgraph around a file/module | `path`, `depth?` |
| `kb_topological_order` | Migration-safe ordering of a file set | `file_paths[]` |
| `kb_find_cycles` | Detect circular dependency groups | *(none)* |

**Semantic Search**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `kb_search` | Fused semantic search (structural + behavioral embeddings via RRF) | `query`, `limit?`, `kind?`, `layer?` |
| `kb_search_in_file` | Semantic search scoped to one file | `query`, `file_path`, `limit?` |
| `kb_find_similar` | Find symbols similar to a known one | `symbol_id`, `limit?` |

`kb_search` accepts an optional `layer` parameter: `'structural'` (Phase 0 embeddings only), `'semantic'` (Phase 2 behavioral embeddings only), or `'fused'` (default). The `'fused'` mode uses *reciprocal rank fusion (RRF)* — a rank-merging algorithm that combines results from both embedding layers without requiring score normalization. Before any `knowledge-builder` runs, `layer: 'fused'` degrades gracefully to structural-only since no semantic embeddings exist yet.

**Knowledge Base Write-Back** *(called by `knowledge-builder` agent during Phase 2)*

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `kb_write_symbol_summary` | Write a behavioral summary back into `kb.db` and re-embed | `symbol_id`, `summary`, `migration_notes?` |
| `kb_write_file_summaries` | Batch write summaries for all symbols in a file | `file_path`, `summaries[]` |

**Code Retrieval**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `kb_get_snippet` | Get exact source lines | `file_path`, `start_line`, `end_line` |
| `kb_get_symbol_body` | Get the full body of a symbol | `symbol_id` |
| `kb_get_file_summary` | Narrative summary of a file's contents | `file_path` |

**Codebase Metrics**

| Tool | Description |
|------|-------------|
| `kb_codebase_stats` | Total LoC, files, symbols, external deps |
| `kb_complexity_ranking` | Files ranked by symbol count, depth, fan-out |
| `kb_large_files` | Files exceeding a line threshold |
| `kb_external_deps` | All external package dependencies |

#### 2.3.2 Example Tool Responses

`kb_find_symbol("arena_alloc")`:
```json
{
  "symbols": [
    {
      "id": 142,
      "name": "arena_alloc",
      "kind": "function",
      "file": "src/util/arena.c",
      "start_line": 47,
      "end_line": 61,
      "signature": "void *arena_alloc(Arena *a, size_t size, size_t align)",
      "docstring": "Allocate `size` bytes from arena `a` with the given alignment. Returns NULL if arena is full.",
      "is_exported": true
    }
  ]
}
```

`kb_get_callers("arena_alloc")`:
```json
{
  "callers": [
    { "symbol": "parser_init",  "file": "src/parser.c",  "line": 103 },
    { "symbol": "ast_node_new", "file": "src/ast.c",     "line": 28  },
    { "symbol": "eval_apply",   "file": "src/eval.c",    "line": 211 }
  ]
}
```

`kb_search("base64 encoding")`:
```json
{
  "results": [
    { "id": 88,  "name": "b64_encode",      "file": "src/codec/base64.c", "score": 0.94 },
    { "id": 89,  "name": "b64_encode_url",  "file": "src/codec/base64.c", "score": 0.91 },
    { "id": 230, "name": "encode_response", "file": "src/http/handlers.c","score": 0.71 }
  ]
}
```

`kb_topological_order(["src/parser.c","src/lexer.c","src/ast.c","src/util/arena.c"])`:
```json
{
  "order": [
    "src/util/arena.c",
    "src/ast.c",
    "src/lexer.c",
    "src/parser.c"
  ],
  "cycles": []
}
```

---

## 3. Technology Stack

### 3.1 AST Parsing: tree-sitter

**tree-sitter** is the correct choice for this use case. It supports all languages AAMF targets (C, Rust, Python, TypeScript, Go, C++, Java, C#, Ruby, etc.), has mature Node.js bindings, and produces concrete syntax trees with precise line/column information.

```
npm install tree-sitter

# Systems languages
npm install tree-sitter-c tree-sitter-cpp tree-sitter-rust tree-sitter-zig
npm install tree-sitter-objc                          # Objective-C / Objective-C++
npm install tree-sitter-fortran

# JVM / CLR
npm install tree-sitter-java tree-sitter-kotlin tree-sitter-scala
npm install tree-sitter-c-sharp

# Interpreted / scripting
npm install tree-sitter-python tree-sitter-ruby tree-sitter-php
npm install tree-sitter-lua tree-sitter-r tree-sitter-bash

# Web / typed JS
npm install tree-sitter-javascript tree-sitter-typescript

# Native mobile
npm install tree-sitter-swift

# Functional
npm install tree-sitter-haskell tree-sitter-ocaml
npm install tree-sitter-elixir tree-sitter-erlang

# Other
npm install tree-sitter-go tree-sitter-julia
```

Install only the grammars relevant to your project — grammars not present are silently skipped by the walker. See §3.6.1 for adding additional languages.

tree-sitter grammars expose **query patterns** (S-expressions) that let you efficiently extract well-defined node types without writing a custom traversal, e.g.:

```scheme
; C function declarations
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @function.name)
  body: (compound_statement)) @function.def
```

This is far more reliable than regex or LLM extraction.

### 3.2 Relational Store: better-sqlite3

`better-sqlite3` provides synchronous, high-performance SQLite access for Node.js. It is the best choice for the indexer (which runs synchronously) and the MCP server (which handles one request at a time per tool call).

```
npm install better-sqlite3
npm install @types/better-sqlite3 --save-dev
```

### 3.3 Vector Search: sqlite-vec

`sqlite-vec` is a SQLite extension that adds vector search capabilities (cosine similarity, L2 distance) via virtual tables. It keeps the entire knowledge base in a single `.db` file with no external processes.

```
npm install sqlite-vec
```

Alternative: `hnswlib-node` if HNSW performance characteristics are needed for very large codebases (>500k symbols).

### 3.4 Embeddings: `EmbeddingProvider`

Embedding quality has a direct impact on `kb_search` recall. AAMF defines a common provider interface so the backend is a configuration detail rather than an engineering change:

```typescript
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;       // must match the vec0 table at creation time
  /** Embed documents (symbols, source snippets) at index time */
  embed(texts: string[]): Promise<number[][]>;
  /** Embed a search query — Qwen3-Embedding uses instruction-aware asymmetric encoding */
  embedQuery(text: string): Promise<number[]>;
}
```

The `embedQuery` method supports **asymmetric encoding**: Qwen3-Embedding accepts an instruction prefix at query time (e.g. `"Instruct: Retrieve relevant code\nQuery: ..."`) while document vectors are embedded without instruction. `embedQuery` exists as a distinct method so the indexer and MCP server handle this transparently. For symmetric models, `embedQuery` simply delegates to `embed([text])[0]`.

The `dimensions` value is written into `kb.db` at index-creation time (via `kb_meta` table) and enforced on subsequent opens. Switching models requires rebuilding the index.

#### Supported Models: Qwen3-Embedding Family

AAMF uses the **Qwen3-Embedding family** (Alibaba, Apache 2.0, released June 2025) — currently the highest-scoring open embedding models on both MTEB Multilingual and MTEB English v2 leaderboards.

| Variant | Dims (max) | RAM | Context | MTEB Eng v2 | Use case |
|---------|------------|-----|---------|-------------|----------|
| **`Qwen3-Embedding-0.6B`** | 1 024 (MRL: 32–1024) | ~1.2 GB | 32 000 tok | 70.70 | **Default.** Fits in any dev machine RAM; strong quality for code retrieval |
| **`Qwen3-Embedding-4B`** | 2 560 (MRL: 32–2560) | ~8 GB | 32 000 tok | 74.60 | Higher quality where RAM allows |
| **`Qwen3-Embedding-8B`** | 4 096 (MRL: 32–4096) | ~16 GB | 32 000 tok | 75.22 | Maximum quality; #1 on MTEB leaderboard |

All variants: Apache 2.0, instruction-aware asymmetric encoding, MRL (Matryoshka Representation Learning) support. MRL allows requesting a smaller sub-dimension (e.g. 512) from any variant to reduce `kb.db` size on large codebases at modest quality cost.

**Why local-first?** AAMF targets offline/air-gapped enterprise environments. A local model has zero marginal cost per indexing run and produces deterministic embeddings across runs. The `EmbeddingProvider` interface is intentionally minimal so additional backends can be added later without changing the indexer or MCP-server code.

#### Provider Implementation

`SentenceTransformersProvider` spawns a minimal Python subprocess (`sentence-transformers>=2.7.0`) and communicates over stdin/stdout JSON. Qwen3-Embedding does **not** require `trust_remote_code=True` — standard `sentence-transformers` works out of the box.

```python
# SentenceTransformersProvider subprocess (simplified)
from sentence_transformers import SentenceTransformer
model = SentenceTransformer("Qwen/Qwen3-Embedding-0.6B")
# document embedding (index time)
embeddings = model.encode(texts, prompt_name="passage")
# query embedding (search time — asymmetric instruction prefix)
query_vec = model.encode([query], prompt_name="query")[0]
```

The active provider is selected via `IndexConfig.embeddingProvider`. The default is `Qwen3Embedding('0.6B')`.

### 3.5 MCP Server: @modelcontextprotocol/sdk

```
npm install @modelcontextprotocol/sdk
```

The server is a stdio-transport MCP server. It is started by the AAMF orchestrator at the beginning of Phase 0 and shut down at the end of the migration. Claude Code (and other MCP-aware clients) can be configured with a `.mcp.json` pointing to it.

### 3.6 Language Support Matrix

| Language | tree-sitter grammar | Extensions | Import Resolution |
|----------|--------------------|-----------|-----------------|
| C | `tree-sitter-c` | `.c` `.h` | `#include` tracking (header/source correlation) |
| C++ | `tree-sitter-cpp` | `.cpp` `.cc` `.cxx` `.hh` `.hpp` | `#include` + `namespace` + `using` |
| Rust | `tree-sitter-rust` | `.rs` | `use` + `mod` + `Cargo.toml` |
| Python | `tree-sitter-python` | `.py` | `import` + `from … import` + `__init__.py` |
| JavaScript | `tree-sitter-javascript` | `.js` `.jsx` `.mjs` `.cjs` | ES modules + `package.json` |
| TypeScript | `tree-sitter-typescript` | `.ts` `.tsx` | ES modules + `tsconfig.json` `paths` |
| Go | `tree-sitter-go` | `.go` | `import` + `go.mod` |
| Java | `tree-sitter-java` | `.java` | `import` + Maven/Gradle POM |
| C# | `tree-sitter-c-sharp` | `.cs` | `using` + `.csproj` / `.sln` |
| Ruby | `tree-sitter-ruby` | `.rb` | `require` / `require_relative` + `Gemfile` |
| Swift | `tree-sitter-swift` | `.swift` | `import` + `Package.swift` |
| Kotlin | `tree-sitter-kotlin` | `.kt` `.kts` | `import` + `build.gradle[.kts]` |
| PHP | `tree-sitter-php` | `.php` | `require` / `include` / `use` + `composer.json` |
| Scala | `tree-sitter-scala` | `.scala` `.sc` | `import` + `build.sbt` |
| Objective-C | `tree-sitter-objc` | `.m` `.mm` | `#import` + Xcode project / `podspec` |
| Lua | `tree-sitter-lua` | `.lua` | `require` + `*.rockspec` |
| Zig | `tree-sitter-zig` | `.zig` | `@import` + `build.zig` |
| Haskell | `tree-sitter-haskell` | `.hs` `.lhs` | `import` + `*.cabal` / `package.yaml` |
| Elixir | `tree-sitter-elixir` | `.ex` `.exs` | `alias` / `import` / `use` / `require` + `mix.exs` |
| Erlang | `tree-sitter-erlang` | `.erl` `.hrl` | `-include` / `-import` + `rebar.config` |
| OCaml | `tree-sitter-ocaml` | `.ml` `.mli` | `open` / `module` + `dune` / `*.opam` |
| Julia | `tree-sitter-julia` | `.jl` | `using` / `import` + `Project.toml` |
| R | `tree-sitter-r` | `.r` `.R` | `library()` / `source()` + `DESCRIPTION` |
| Bash | `tree-sitter-bash` | `.sh` `.bash` | `source` / `.` includes |
| Fortran | `tree-sitter-fortran` | `.f` `.f90` `.f95` `.for` | `USE` / `INCLUDE` + build manifests |

All grammars listed above have stable npm packages and are used in production tree-sitter tooling. Languages whose grammars are not installed are silently skipped by the file walker — there is no hard requirement to install all of them.

#### 3.6.1 Adding a Custom Language

The indexer is designed for zero-friction language extension. Adding support for any language that has a tree-sitter grammar (see [tree-sitter's grammar list](https://tree-sitter.github.io/tree-sitter/#parsers)) requires three steps:

1. **Install the grammar package**
   ```
   npm install tree-sitter-<language>
   ```

2. **Implement a `SymbolExtractor`** (see §4.3 for the interface) in `runtime/src/indexer/extractors/<language>.ts`. The extractor defines the tree-sitter S-expression query patterns that identify symbols, imports, and call references for the language. The C extractor (`c.ts`) is the simplest reference implementation.

3. **Register the extractor** in `runtime/src/indexer/parser.ts` by adding a `{ extensions: ['.ext'], grammar: require('tree-sitter-<language>'), extractor: new MyExtractor() }` entry to the language registry.

No changes to the core `IndexBuilder`, `walker.ts`, `resolver.ts`, `db.ts`, or any MCP server code are needed. The call graph, embedding, topological sort, and all MCP tools work automatically for the new language once the extractor is registered.

---

## 4. Indexer Implementation

### 4.1 Module Structure

```
runtime/src/indexer/
├── index.ts                 # Entry point: IndexBuilder class
├── walker.ts                # File tree walker (fast-glob + language detection)
├── parser.ts                # tree-sitter parser pool (one parser per language)
├── extractors/
│   ├── c.ts                 # C
│   ├── cpp.ts               # C++
│   ├── rust.ts              # Rust
│   ├── python.ts            # Python
│   ├── javascript.ts        # JavaScript / JSX
│   ├── typescript.ts        # TypeScript / TSX
│   ├── go.ts                # Go
│   ├── java.ts              # Java
│   ├── csharp.ts            # C#
│   ├── ruby.ts              # Ruby
│   ├── swift.ts             # Swift
│   ├── kotlin.ts            # Kotlin
│   ├── php.ts               # PHP
│   ├── scala.ts             # Scala
│   ├── objc.ts              # Objective-C / Objective-C++
│   ├── lua.ts               # Lua
│   ├── zig.ts               # Zig
│   ├── haskell.ts           # Haskell
│   ├── elixir.ts            # Elixir
│   ├── erlang.ts            # Erlang
│   ├── ocaml.ts             # OCaml
│   ├── julia.ts             # Julia
│   ├── r.ts                 # R
│   ├── bash.ts              # Bash / Shell
│   └── fortran.ts           # Fortran
├── resolver.ts              # Import → file resolution logic
├── call-graph.ts            # AST-based call expression extraction
├── embedder.ts              # Embedding provider interface + local impl
└── db.ts                    # SQLite schema management and write helpers
```

### 4.2 Core `IndexBuilder` API

```typescript
interface IndexConfig {
  sourceRoot: string;
  languages: string[];               // e.g. ['c', 'python'] — auto-detected from extensions if omitted
  dbPath: string;
  embeddingProvider?: EmbeddingProvider; // defaults to Qwen3Embedding('0.6B')
  embeddingBatchSize?: number;           // default 64
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

class IndexBuilder {
  constructor(config: IndexConfig) {}

  /** Full index build. Idempotent; re-hashes files and skips unchanged. */
  async build(): Promise<IndexStats>

  /** Incremental update for a set of changed files. */
  async update(changedFiles: string[]): Promise<IndexStats>

  /**
   * Ingest behavioral summaries written by the knowledge-builder agent.
   * Re-embeds each summary and writes to symbol_semantic_embeddings.
   * Called by the MCP server's kb_write_symbol_summary tool — not directly
   * by the orchestrator.
   */
  async ingestSummary(symbolId: number, summary: string, migrationNotes?: string): Promise<void>
}

interface IndexStats {
  filesIndexed: number;
  symbolsExtracted: number;
  importsResolved: number;
  structuralEmbeddingsGenerated: number;
  durationMs: number;
}
```

### 4.3 Symbol Extractor Pattern

Each language extractor implements the same interface:

```typescript
interface SymbolExtractor {
  readonly language: string;
  readonly extensions: string[];

  /** Extract symbols from a parsed tree */
  extractSymbols(tree: Tree, source: string, filePath: string): RawSymbol[];

  /** Extract import/include statements */
  extractImports(tree: Tree, source: string): RawImport[];

  /** Extract call expressions (best-effort) */
  extractCallRefs(tree: Tree, source: string): RawCallRef[];
}
```

### 4.4 Incremental Indexing

Files are hashed (SHA-256 of content). On re-runs, only files whose hash has changed are re-parsed and re-embedded. This makes incremental updates to the source tree cheap — important when AAMF is used in a workflow where the source tree may be patched between phases.

---

## 5. MCP Server Implementation

### 5.1 Module Structure

```
runtime/src/kb-server/
├── server.ts          # MCP server bootstrap (stdio transport)
├── tools/
│   ├── lookup.ts      # kb_find_symbol, kb_get_symbol, kb_get_file_symbols
│   ├── graph.ts       # kb_get_callers, kb_get_callees, kb_topological_order, ...
│   ├── search.ts      # kb_search, kb_search_in_file, kb_find_similar
│   ├── snippet.ts     # kb_get_snippet, kb_get_symbol_body
│   └── metrics.ts     # kb_codebase_stats, kb_complexity_ranking, ...
└── db.ts              # Read-only DB access layer (prepared statements)
```

### 5.2 Server Lifecycle in AAMF

The AAMF orchestrator gains a new `PhaseZero` step and a new runtime concern:

```typescript
class MigrationOrchestrator {
  private kbServer?: KbServerProcess;

  async run() {
    // Phase 0 (new)
    await this.executePhase0();   // Build index + start MCP server

    // Existing phases, but agents now have MCP access
    await this.executePhase1();   // impact-assessor
    await this.executePhase2();   // knowledge-builder (LLM-augmented)
    // ...

    // Cleanup
    await this.kbServer?.stop();
  }

  private async executePhase0() {
    const builder = new IndexBuilder({
      sourceRoot: this.config.source.path,
      languages: this.config.source.languages,  // multi-language; auto-detected if omitted
      dbPath: join(this.progressDir, 'kb.db'),
    });

    const stats = await builder.build();
    this.logger.log({ phase: 0, event: 'index-built', ...stats });

    this.kbServer = new KbServerProcess(join(this.progressDir, 'kb.db'));
    await this.kbServer.start();
    this.kbServerSocketPath = this.kbServer.socketPath;
  }
}
```

### 5.3 Agent MCP Configuration

When the orchestrator launches an agent (via `AgentLauncher`), it injects MCP server configuration into the agent's environment or `--mcp-config` flag:

```json
{
  "mcpServers": {
    "kb": {
      "command": "node",
      "args": ["/path/to/aamf-runtime/dist/kb-server/server.js"],
      "env": {
        "KB_DB_PATH": "/path/to/.aamf/migration/my-project/kb.db"
      }
    }
  }
}
```

Agents then have access to `mcp__kb__*` tools.

---

## 6. How Each AAMF Phase Changes

### Phase 0 (New): Index Build

- Deterministic, no LLM tokens consumed
- Output: `kb.db` at `.aamf/migration/{projectName}/kb.db`
- Duration: ~30–120 seconds for 100k-line codebase
- Fully idempotent / resumable

### Phase 1: Impact Assessor

**Before**: Reads source files with grep/find to gather metrics.  
**After**: Calls `kb_codebase_stats` for aggregate metrics. Calls `kb_complexity_ranking` for high-complexity files. Calls `kb_external_deps` for dependency list. Calls `kb_find_cycles` for circular dependency risk.

Context reduction: from reading N files to ~5 tool calls. The agent's context window is almost entirely free for reasoning.

### Phase 2: Knowledge Builder

**Before**: Reads each source file and writes prose descriptions.  
**After**:

1. Calls `kb_get_file_symbols(file)` to get a precise symbol list for each module — **no file reading required**
2. For complex modules, calls `kb_get_snippet` to read only specific function bodies of interest
3. Writes KB markdown that is now **grounded** in deterministic facts (exact signatures, exact line numbers, exact dependency edges)
4. **For each symbol**, calls `kb_write_symbol_summary(symbol_id, summary, migration_notes)` to persist its behavioral description back into `kb.db`. The MCP server re-embeds the summary immediately, populating `symbol_semantic_embeddings`. This closes the structural/semantic gap: after Phase 2 completes, `kb_search` operates over both the AST-derived structural embeddings (from Phase 0) and the LLM-derived behavioral embeddings (from Phase 2).
5. The `large-file-analyzer` sub-agent's scope shrinks to behavioral annotation only — structural decomposition (line ranges, chunk boundaries) is already provided by the indexer.

Context reduction: **massive**. Instead of reading entire source files, the agent reads structured tool responses. A 3 000-line file becomes a ~50-symbol JSON list.

### Phase 3: Migration Planner

**Before**: Reads KB markdown and attempts to infer the correct task ordering.  
**After**:

1. Calls `kb_topological_order(all_files)` to get a dependency-respecting ordering **guaranteed to be cycle-free**
2. Calls `kb_find_cycles()` to identify files that need special treatment (mutual recursion, etc.)
3. Uses `kb_large_files(threshold=500)` to auto-identify files requiring piecemeal migration
4. Task generation has precise `start_line`/`end_line` from the index, removing ambiguity

Task quality improvement: task ordering is now backed by a computed topological sort, not LLM-inferred ordering.

### Phase 4: Code Migrator

**Before**: Reads KB module doc + source file.  
**After**:

1. Gets assigned task with precise `start_line`/`end_line` (from indexer)
2. Calls `kb_get_snippet(file, start_line, end_line)` to read **only** its assigned lines
3. During migration, resolves unknowns via:
   - `kb_find_symbol("some_dependency")` → gets exact signature without reading the file
   - `kb_get_callers("fn_being_migrated")` → knows all call sites to ensure API compatibility
   - `kb_search("error code pattern in this codebase")` → finds patterns semantically
4. Never needs to open any file outside its task assignment

Context reduction: from reading whole source files (+ KB docs) to reading only the assigned line range plus targeted tool queries.

### Phases 5–7 (Parity, E2E, Docs)

- **parity-verifier**: `kb_find_symbol` to verify all exports are present in target
- **final-parity-checker**: `kb_get_module_exports` for comprehensive export checklist
- **e2e-test-crafter**: `kb_get_dependency_graph` to understand integration points
- **documentation-writer**: `kb_codebase_stats` + `kb_get_file_summary` for accurate docs

---

## 7. Impact on Context Window Pressure

Estimated token consumption for a **100 000-line codebase**, Phase 2 (Knowledge Builder), before and after:

| Metric | Before (today) | After (with MCP KB) |
|--------|---------------|---------------------|
| Source lines read per knowledge-builder invocation | ~3 000–8 000 | 0 |
| Tokens from source reading | ~6 000–16 000 | 0 |
| Tokens from structured tool responses | 0 | ~2 000–4 000 |
| Tokens available for reasoning | ~40 000 | ~60 000+ |
| Risk of hallucinated dependencies | High | Low (deterministic) |
| Knowledge base accuracy | ~80–90% (estimated) | ~95–99% (estimated; dependency facts deterministic, behavioral summaries still LLM-written) |

For the code-migrator specifically, the improvement is even more dramatic: instead of a 3 000-token KB doc + 2 000-token source excerpt, the agent gets a 200-token symbol list + 200-token targeted snippet from `kb_get_snippet`. That's **~5 000 tokens saved per task**.

---

## 8. Index Build: Direct Invocation (Not an Agent)

The index build is pure computation with no LLM reasoning. It is implemented as a **direct TypeScript invocation** within the orchestrator's `PhaseZero` (see §5.2) — not as an agent subprocess. Wrapping it as an agent would incur unnecessary LLM billing and process overhead for a fully deterministic task.

A named entry (`AgentName = 'kb-indexer'`) is reserved in the orchestrator's agent registry for observability purposes — progress reporting, logging, and checkpoint tracking — but no LLM session is created for it.

---

## 9. Revised Knowledge Builder Agent

With the MCP KB available, the `knowledge-builder` agent prompt changes significantly:

**New tool access**:

> `Bash`, `Read`, and `Edit` are retained as fallback tools for edge cases where a source file cannot be adequately described from index data alone (e.g., non-standard syntax or macro-heavy C). In practice the workflow below uses MCP tools for all standard module analysis.

```yaml
tools:
  - Bash
  - Read
  - Write
  - Edit
  - mcp__kb__kb_find_symbol
  - mcp__kb__kb_get_file_symbols
  - mcp__kb__kb_get_callers
  - mcp__kb__kb_get_callees
  - mcp__kb__kb_get_snippet
  - mcp__kb__kb_search
  - mcp__kb__kb_get_dependency_graph
  - mcp__kb__kb_codebase_stats
  - mcp__kb__kb_get_module_exports
```

**New workflow**:

```
1. Call kb_codebase_stats → understand project size and shape
2. Call kb_get_dependency_graph(root, depth=2) → understand top-level module structure
3. For each module:
   a. Call kb_get_file_symbols(file) → get complete symbol list [ZERO file reading]
   b. For symbols requiring behavioral description, call kb_get_snippet(file, start, end)
   c. Write modules/{name}.md with guaranteed-accurate API table
   d. Call kb_write_file_summaries(file, summaries) → persist behavioral descriptions
      back into kb.db; the server re-embeds them immediately into
      symbol_semantic_embeddings, making them available to all subsequent agents
4. Write architecture.md citing exact file dependency edges from kb_get_dependency_graph
5. Write patterns.md using kb_search (layer: 'fused') to find recurring patterns
```

The KB markdown files are now supplemented by (or could be replaced by) the `kb.db`. Keeping human-readable Markdown output remains valuable for debugging, auditing, and human-in-the-loop review — but the Markdown and the database are now kept **in sync**: everything the LLM writes in Markdown, it also writes into `kb.db` via `kb_write_symbol_summary`. This means future agents get the benefit of both formats.

### 9.1 Why Two Embedding Layers?

The structural embedding (Phase 0) captures **identity**: `arena_alloc` is a function that takes `(Arena*, size_t, size_t)`. The semantic embedding (Phase 2) captures **intent**: `arena_alloc` implements a bump-pointer allocator with O(1) allocation for the migration's memory management strategy. A `code-migrator` searching for "how does the codebase manage memory" will score the semantic embedding far higher than the structural one. Both are necessary:

| Layer | Source | Captures | Best for |
|-------|--------|----------|----------|
| Structural | Phase 0 (deterministic) | Name, type, signature | "Find a function named X" / "Find all functions of kind Y" |
| Semantic | Phase 2 (LLM-written) | Behavior, intent, patterns | "Find all functions that do Z" / "Find error-handling patterns" |
| Fused (RRF) | Both | Both | General-purpose `kb_search` |

---

## 10. Implementation Roadmap

### Milestone 1: Core Indexer

- [ ] Schema design finalized and implemented in `runtime/src/indexer/db.ts`
- [ ] tree-sitter parser pool — language registry with all supported grammars (§3.6); any grammar not installed is skipped gracefully
- [ ] Symbol extractors for all 25 languages in §3.6 (functions, classes, types, constants, macros)
- [ ] Import resolver (file-level dependency graph)
- [ ] Basic `IndexBuilder` CLI: `aamf index build --source ./src --db ./kb.db`
- [ ] Tests: `indexer.test.ts` against `lz4-c-project` and `tiny-python-project` fixtures

### Milestone 2: Semantic Search

- [ ] `sqlite-vec` integration
- [ ] `EmbeddingProvider` interface (`modelId`, `dimensions`, `embed()`, `embedQuery()` — instruction-aware asymmetric encoding)
- [ ] `SentenceTransformersProvider` — Python subprocess via `sentence-transformers>=2.7.0`; supports `Qwen/Qwen3-Embedding-0.6B` (default), `4B`, `8B`
- [ ] `Qwen3Embedding(size)` factory shorthand for `SentenceTransformersProvider` with the correct model ID and dimensions
- [ ] `kb_meta` table: persist `embedding_provider`, `embedding_model`, `embedding_dimensions`, `schema_version` at index creation
- [ ] Dynamic `vec0` DDL generation based on `EmbeddingProvider.dimensions`
- [ ] `symbol_embeddings` (structural) populated during Phase 0 build
- [ ] `symbol_summaries` + `symbol_semantic_embeddings` tables added to schema
- [ ] `kb_write_symbol_summary` / `kb_write_file_summaries` MCP tools
- [ ] `IndexBuilder.ingestSummary()` — re-embeds a summary into `symbol_semantic_embeddings`
- [ ] `kb_search` with `layer` param: `'structural'` | `'semantic'` | `'fused'` (RRF)
- [ ] Graceful degradation: `fused` falls back to structural-only when no semantic embeddings exist
- [ ] Tests: verify that after a simulated knowledge-builder write-back, `kb_search(layer: 'fused')` scores behavioral queries higher than structural-only

### Milestone 3: Call Graph

- [ ] Call expression extraction per language
- [ ] Best-effort resolution (intra-file first, then cross-file)
- [ ] `kb_get_callers` / `kb_get_callees` implementation
- [ ] `kb_topological_order` + `kb_find_cycles` (topological sort on `file_imports`)

### Milestone 4: MCP Server

- [ ] `@modelcontextprotocol/sdk` server scaffold
- [ ] Implement all tools in the catalog (§2.3.1)
- [ ] `KbServerProcess` wrapper for orchestrator lifecycle management
- [ ] MCP config injection into `AgentLauncher`

### Milestone 5: Orchestrator Integration

- [ ] `Phase0` in `MigrationOrchestrator` — calls `IndexBuilder`, then starts `KbServerProcess`
- [ ] `AgentName` extended with `'kb-indexer'` (even if run inline)
- [ ] Updated `ContextBuilder` to include MCP server config in agent contexts
- [ ] E2E test: `e2e-lz4-rust.test.ts` with indexer + MCP

### Milestone 6: Updated Agent Prompts

- [ ] `knowledge-builder.md` — MCP-first workflow, no raw file reading
- [ ] `impact-assessor.md` — use `kb_codebase_stats` + `kb_complexity_ranking`
- [ ] `migration-planner.md` — use `kb_topological_order` for task ordering
- [ ] `code-migrator.md` — use `kb_get_snippet` + `kb_find_symbol` instead of reading source

---

## 11. Open Questions

1. **Call graph fidelity**: tree-sitter is a syntactic parser; it cannot fully resolve calls in dynamic languages (Python duck typing) or through function pointers (C). How impactful is this? Likely acceptable — structural/import dependency is the critical part for migration ordering. The call graph is best-effort and supplementary; topological ordering relies on `file_imports`, which is reliably extractable from all target languages.

2. **Embedding model choice**: Addressed in §3.4. AAMF uses the **Qwen3-Embedding family** exclusively, all local/offline. **Default: `Qwen3-Embedding-0.6B`** (~1.2 GB, 70.70 MTEB Eng v2). Upgrade to `4B` (74.60) or `8B` (75.22, #1 on MTEB) when RAM allows. The `EmbeddingProvider` interface with `embedQuery()` keeps the backend swappable without touching the indexer or MCP server. See §3.4.

3. **`kb.db` size**: For a 100k-line codebase with ~10k symbols and 1024-dim float32 embeddings, the vector table alone is ~40 MB. Total `kb.db` should be <100 MB. Acceptable.

4. **Target knowledge base**: The design above indexes the **source** codebase. Should the **target** codebase also be indexed incrementally as migration proceeds? This would allow parity-verifier to use `kb_find_symbol` on the target too. A lightweight approach: run a second `IndexBuilder` against the target output directory at the start of Phase 5 (parity verification), using the same `kb-mcp-server` binary with a different `KB_DB_PATH`. No architectural change required — just a second index file.

*Previously resolved questions (cross-language projects, KB freshness during migration, MCP server restart cost) have been incorporated into the main design in §2.1, §4.4, and §5.2 respectively.*

---

## 12. Summary

The current AAMF knowledge base is a collection of LLM-written Markdown files — expensive to produce, imprecise in dependency information, and impossible to query programmatically. For 100k+ line codebases this approach saturates context windows and produces unreliable dependency orderings.

The proposed improvement has four pillars:

1. **Deterministic AST Indexer** (tree-sitter): replaces LLM file-reading with a precise, lossless symbol and dependency extraction pass. Runs once per source snapshot, consumes zero LLM tokens.

2. **Structured Knowledge Base** (SQLite + sqlite-vec): stores symbols, dependency graphs, and vector embeddings in a queryable database. Enables exact lookup, graph traversal, topological ordering, and semantic search simultaneously.

3. **Two-Layer Embedding**: Phase 0 generates *structural* embeddings (name + signature + docstring) capturing syntactic identity. Phase 2 (`knowledge-builder`) writes *semantic* embeddings (LLM behavioral summaries) capturing intent and patterns. `kb_search` fuses both via reciprocal rank fusion (RRF), giving agents the precision of exact indexing and the recall of semantic understanding — and improving progressively as more of the KB is annotated.

4. **MCP Server**: exposes the knowledge base as on-demand tools that agents invoke at the exact moment they need information — instead of front-loading all context at agent startup. This is the key architectural shift: agents get a **narrow window into the KB** rather than a **broad flood of pre-loaded context**.

The result is dramatically lower context pressure per agent invocation, higher accuracy of dependency information, and the ability to handle codebases of arbitrary scale because agents never need to load the entire KB — they query what they need, when they need it.
