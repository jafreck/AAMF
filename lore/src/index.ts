export { IndexBuilder } from './indexer/index.js';
export { openDb, setKbMeta, getKbMeta, createVec0Tables } from './indexer/db.js';
export type { Database } from './indexer/db.js';
export { buildCallGraph, topoSort, detectCycles } from './indexer/call-graph.js';
export { walkFiles } from './indexer/walker.js';
export type { WalkerConfig, FileEntry } from './indexer/walker.js';
export { ImportResolver } from './indexer/resolver.js';
export { ParserPool } from './indexer/parser.js';
export { ensurePythonDeps } from './indexer/ensure-python-deps.js';
export { SentenceTransformersProvider, Qwen3EmbeddingProvider } from './indexer/embedder.js';
export type { EmbeddingProvider } from './indexer/embedder.js';
export type {
  ExtractionResult,
  RawCallRef,
  RawImport,
  RawSymbol,
  SymbolExtractor,
} from './indexer/extractors/types.js';
