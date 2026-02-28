export { IndexBuilder } from './indexer/index.js';
export { openDb, setKbMeta, getKbMeta, createVec0Tables, computeSourceFingerprint, getKbFingerprint, setKbFingerprint } from './indexer/db.js';
export type { Database } from './indexer/db.js';
export { buildCallGraph, topoSort, detectCycles } from './indexer/call-graph.js';
export { walkFiles } from './indexer/walker.js';
export type { WalkerConfig, FileEntry } from './indexer/walker.js';
export { ImportResolver } from './indexer/resolver.js';
export { ParserPool } from './indexer/parser.js';
export { ensurePythonDeps } from './indexer/ensure-python-deps.js';
export { SentenceTransformersProvider, Qwen3EmbeddingProvider } from './indexer/embedder.js';
export type { EmbeddingProvider } from './indexer/embedder.js';
export { CExtractor } from './indexer/extractors/c.js';
export { CppExtractor } from './indexer/extractors/cpp.js';
export { CSharpExtractor } from './indexer/extractors/csharp.js';
export { GoExtractor } from './indexer/extractors/go.js';
export { JavaExtractor } from './indexer/extractors/java.js';
export { JavaScriptExtractor } from './indexer/extractors/javascript.js';
export { PythonExtractor } from './indexer/extractors/python.js';
export { RustExtractor } from './indexer/extractors/rust.js';
export { TypeScriptExtractor } from './indexer/extractors/typescript.js';
export type {
  ExtractionResult,
  RawCallRef,
  RawImport,
  RawSymbol,
  SymbolExtractor,
} from './indexer/extractors/types.js';
export { walk, findFirst, nodeSignature, emptyResult } from './indexer/extractors/types.js';
