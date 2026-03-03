## Migration Progress

### Task task-1: Migrate examples/common.h to Rust
- **Status**: Completed
- **Source**: `examples/common.h` (lines 1-247)
- **Target**: `examples/common.rs`
- **Parity**: Passed
- **Tests**: Pending
- **Notes**: Migrated all functions and error codes. CHECK macro → check! macro. File I/O helpers preserve exit codes and error messaging. malloc_orDie → malloc_or_die returning Vec<u8>. mallocAndLoadFile_orDie simplified to return Vec<u8> directly (no size out-param needed in Rust).

### Task task-32: v07 types and bitstream
- **Status**: Completed
- **Source**: lib/legacy/zstd_v07.c (lines 1-612, 2630-2900), lib/legacy/zstd_v07.h
- **Target**: src/legacy/v07/types.rs, src/legacy/v07/bitstream.rs, src/legacy/v07/mod.rs
- **Parity**: Passed
- **Tests**: Written (18 unit tests, all passing)
- **Notes**: Ported all v07 constants, enums (BlockType, LitBlockType, DStage, DStreamStatus), structs (FrameParams, BlockProperties, FseDecodeEntry, FseDTableHeader, FseDState, Match, Optimal, Stats, CustomMem), error codes, LE memory I/O helpers, wildcopy, and the backward bitstream reader (DStream with init/look/read/skip/reload/end_of_stream). Used idiomatic Rust: enum with from_u8, slice-based I/O, no unsafe.

### Task task-8: Port educational decoder: types, constants, and frame header parsing
- **Status**: Completed
- **Source**: `doc/educational_decoder/zstd_decompress.h` (full), `doc/educational_decoder/zstd_decompress.c` (full, 2323 lines)
- **Target**: `doc/educational_decoder/src/lib.rs`, `doc/educational_decoder/src/types.rs`, `doc/educational_decoder/src/frame.rs`
- **Parity**: Passed
- **Tests**: Written (4 unit tests, all passing)
- **Notes**: Complete port of the educational decoder including all type definitions, IO stream types, frame header parsing, block decompression, literals decoding (raw/RLE/Huffman), sequence decoding with FSE, sequence execution with repeat-offset handling, and dictionary support. Error handling converted from exit(1) macros to Rust Result types. All C malloc/free replaced with Vec. cargo check and cargo test pass cleanly.
