## Migration Progress

### Task task-1: Migrate examples/common.h to Rust
- **Status**: Completed
- **Source**: `examples/common.h` (lines 1-247)
- **Target**: `examples/common.rs`
- **Parity**: Passed
- **Tests**: Pending
- **Notes**: Migrated all functions and error codes. CHECK macro → check! macro. File I/O helpers preserve exit codes and error messaging. malloc_orDie → malloc_or_die returning Vec<u8>. mallocAndLoadFile_orDie simplified to return Vec<u8> directly (no size out-param needed in Rust).
