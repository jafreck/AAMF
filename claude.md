# AAMF — Autonomous Agent Migration Framework

AAMF is a pre-release TypeScript runtime that orchestrates AI agents to migrate very large legacy codebases between languages and frameworks. It does not perform reasoning itself — it is pure execution machinery that launches purpose-built agents, feeds them minimal context, collects structured output, and decides what to run next.

This is a greenfield pre-release project. There are no backwards-compatibility constraints, no legacy shims, and no deprecated code paths to preserve. Break things when it produces a better design.

## What AAMF Does

AAMF treats a codebase migration as a deterministic pipeline:

1. **Index the source** — Tree-sitter parses every file, extracts symbols and call edges, and stores them in a SQLite knowledge base (`@jafreck/lore`). Optional LSP integration resolves cross-file references with full semantic accuracy.
2. **Build a call graph** — Strongly-connected components (mutually-dependent symbols) are contracted into clusters. A greedy merge step groups clusters by inter-cluster edge weight until `maxLinesPerTask` is reached, producing a dependency-ordered task list.
3. **Plan** — Agents analyze the knowledge base and produce a migration strategy with module groups, task decomposition, and dependency ordering.
4. **Migrate iteratively** — Code-migrator agents translate tasks in topological order with parity verification, retry, model routing, and failure adjudication. Infrastructure errors are retried separately from agent failures.
5. **Verify and document** — Final parity checks, E2E test generation, idiomatic refactoring, and documentation run as post-migration phases.

The key insight is deterministic call-graph clustering: AAMF deconstructs the source codebase into a dependency graph of migration tasks before any agent touches code, so work is parallelizable, resumable, and ordered correctly.

## Architecture

```
migration.config.json → MigrationRuntime
                            │
                      FlowRunner (Cadre)
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      ContextBuilder   AgentLauncher   TaskGraphBuilder
      (writes JSON)    (spawns CLI)    (SCC + greedy merge)
            │               │
            ▼               ▼
       context.json    Agent CLI processes
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      ResultParser    TokenTracker    MetricsCollector
            │               │               │
            ▼               ▼               ▼
      Checkpoint       CostEstimator   ReportGenerator
```

**Key components:**

- `src/flow/` — Step definitions for each pipeline phase, wired together by `migration-flow.ts`.
- `src/core/runtime.ts` — Loads config, generates agent files from templates, builds a `FlowContext`, and runs the flow.
- `src/core/task-graph-builder.ts` — Deterministic call-graph clustering: SCC contraction → greedy merge → topologically-sorted `MigrationTask[]`.
- `src/agents/registry.ts` — Single authoritative registry of all 16 agent roles with Zod schemas, tool lists, and phase membership.
- `src/core/agent-launcher.ts` — Spawns out-of-process agent CLIs (Copilot or Claude Code), streams output, collects metrics.
- `src/execution/parallel-executor.ts` — p-limit concurrency control for parallel agent invocations.
- `src/core/checkpoint.ts` — JSON-based checkpoint with per-phase cursors for deterministic resume.
- `agents/templates/` — Markdown prompt templates for each agent role.

## Pipeline Phases

| Phase | Name | Agents | Critical |
|-------|------|--------|----------|
| 0 | KB Indexing | *(runtime — Lore)* | Yes |
| 1 | Task Graph Construction | *(runtime — Lore)* | Yes |
| 2 | Knowledge Base Construction | `knowledge-builder` | Yes |
| 3 | Migration Planning | `migration-planner`, `adjudicator` | Yes |
| 4 | Iterative Migration | `code-migrator`, `parity-verifier`, `test-writer`, `parity-failure-resolver` | Yes |
| 5 | Final Parity Verification | `final-parity-checker` | Yes |
| 6 | E2E Testing & Documentation | `e2e-test-crafter`, `documentation-writer` | Yes |
| 7 | Idiomatic Refactor (optional) | `idiomatic-reviewer`, `idiomatic-refactorer` | Yes |
| 8 | Completion | *(summary only)* | Yes |

Execution order: 0→1→2→3→4→5→6→7→8. All phases are critical — failure in any phase halts the flow.

## Agent Runtimes

AAMF supports two agent backends, selected by `agentRuntime` in the config:

| Runtime | CLI | Agent Dir |
|---------|-----|-----------|
| Copilot | `copilot --agent <name>` | `.github/agents/` |
| Claude Code | `claude --agent <name>` | `.claude/agents/` |

Agents run out-of-process. Context is passed as JSON files containing file paths (not contents). When KB indexing is enabled, an HTTP MCP server gives agents query access to the indexed codebase without saturating context windows.

## Development

### Prerequisites

- Node.js 22 (pinned in `.nvmrc`)
- An agent CLI: Copilot CLI or Claude Code CLI on `PATH`

### Setup

```bash
nvm use          # or: nvm install && nvm use
npm install
npm run build
```

### Run

```bash
npx aamf migrate -c migration.config.json
npx aamf migrate -c migration.config.json --dry-run
npx aamf migrate -c migration.config.json --resume
npx aamf migrate -c migration.config.json --phase 4
npx aamf status -c migration.config.json
npx aamf reset -c migration.config.json
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint     # tsc --noEmit
```

## Code Conventions

- TypeScript strict mode, ESM (`"type": "module"`).
- Zod for all config and agent output validation.
- Vitest for testing (`tests/` mirrors `src/` layout).
- No default exports. Named exports only.
- Agent prompt templates live in `agents/templates/` with `_partials/` for shared fragments.
- The runtime never calls an LLM directly — all reasoning is delegated to agent invocations.

## Troubleshooting

- Native module failures after switching Node → rerun `npm install` on Node 22.
- `npx aamf` not found → run `npm run build` first.
- Agent invocations fail immediately → verify the selected CLI is installed and on `PATH`.