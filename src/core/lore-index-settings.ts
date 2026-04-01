import type { EffectiveLspSettings, EffectiveScipSettings } from '@jafreck/lore';
import type { MigrationConfig } from '../config/schema.js';

type KbIndexConfig = MigrationConfig['options']['kbIndex'];
type LspServerOverride = { command: string; args?: string[] };

const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SCIP_TIMEOUT_MS = 120_000;

// Lore's programmatic API expects fully-effective settings, but the helper
// functions that build those defaults are not part of the public export surface.
// Mirror the 0.4.0 defaults here so AAMF can always pass the new API shape.
const DEFAULT_LSP_SERVER_REGISTRY: EffectiveLspSettings['servers'] = {
  c: { command: 'clangd', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  cpp: { command: 'clangd', args: [] },
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  javascript: { command: 'typescript-language-server', args: ['--stdio'] },
  go: { command: 'gopls', args: [] },
  java: { command: 'jdtls', args: [] },
  csharp: { command: 'csharp-ls', args: [] },
  ruby: { command: 'solargraph', args: ['stdio'] },
  php: { command: 'intelephense', args: ['--stdio'] },
  swift: { command: 'sourcekit-lsp', args: [] },
  kotlin: { command: 'kotlin-language-server', args: [] },
  scala: { command: 'metals', args: [] },
  lua: { command: 'lua-language-server', args: [] },
  bash: { command: 'bash-language-server', args: ['start'] },
  elixir: { command: 'elixir-ls', args: [] },
  zig: { command: 'zls', args: [] },
  ocaml: { command: 'ocamllsp', args: [] },
  haskell: { command: 'haskell-language-server-wrapper', args: ['--lsp'] },
  julia: {
    command: 'julia',
    args: ['--startup-file=no', '--history-file=no', '--quiet', '--eval', 'using LanguageServer, SymbolServer; runserver()'],
  },
  elm: { command: 'elm-language-server', args: [] },
  objc: { command: 'clangd', args: [] },
};

const DEFAULT_SCIP_INDEXER_REGISTRY: EffectiveScipSettings['indexers'] = {
  typescript: { command: 'scip-typescript', args: ['index', '--output', '{output}'] },
  python: { command: 'scip-python', args: ['index', '.', '--project-name', 'project', '--output', '{output}'] },
  java: { command: 'scip-java', args: ['index', '--output', '{output}'] },
  scala: { command: 'scip-java', args: ['index', '--output', '{output}'] },
  kotlin: { command: 'scip-java', args: ['index', '--output', '{output}'] },
  rust: { command: 'rust-analyzer', args: ['scip', '.'] },
  c: { command: 'scip-clang', args: ['--compdb-path={compdb}', '--index-output-path={output}'] },
  cpp: { command: 'scip-clang', args: ['--compdb-path={compdb}', '--index-output-path={output}'] },
  csharp: { command: 'scip-dotnet', args: ['index', '.', '--output', '{output}'] },
  ruby: { command: 'scip-ruby', args: ['--output', '{output}'] },
  php: { command: 'scip-php', args: ['index', '--output', '{output}'] },
  go: { command: 'scip-go', args: [] },
  dart: { command: 'scip-dart', args: ['index', '--output', '{output}'] },
};

export interface LoreIndexSettings {
  lsp: EffectiveLspSettings;
  scip: EffectiveScipSettings;
}

function cloneLspServerRegistry(registry: EffectiveLspSettings['servers']): EffectiveLspSettings['servers'] {
  return Object.fromEntries(
    Object.entries(registry).map(([language, server]) => [
      language,
      { command: server.command, args: [...server.args] },
    ]),
  );
}

function cloneScipIndexerRegistry(registry: EffectiveScipSettings['indexers']): EffectiveScipSettings['indexers'] {
  return Object.fromEntries(
    Object.entries(registry).map(([language, indexer]) => [
      language,
      {
        command: indexer.command,
        args: [...indexer.args],
        ...(indexer.cwd ? { cwd: indexer.cwd } : {}),
      },
    ]),
  );
}

function mergeLspServerOverrides(
  overrides: Record<string, LspServerOverride> | undefined,
): EffectiveLspSettings['servers'] {
  const merged = cloneLspServerRegistry(DEFAULT_LSP_SERVER_REGISTRY);
  for (const [language, override] of Object.entries(overrides ?? {})) {
    const base = merged[language];
    merged[language] = {
      command: override.command ?? base?.command ?? '',
      args: override.args ?? base?.args ?? [],
    };
  }
  return merged;
}

export function buildLoreIndexSettings(kbIndex: KbIndexConfig | undefined): LoreIndexSettings {
  return {
    lsp: {
      enabled: kbIndex?.lsp?.enabled ?? false,
      requestTimeoutMs: kbIndex?.lsp?.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
      servers: mergeLspServerOverrides(kbIndex?.lsp?.servers),
    },
    scip: {
      enabled: true,
      timeoutMs: DEFAULT_SCIP_TIMEOUT_MS,
      indexers: cloneScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY),
      indexDir: null,
    },
  };
}