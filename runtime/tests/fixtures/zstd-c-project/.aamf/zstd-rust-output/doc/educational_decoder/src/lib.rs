// Zstandard educational decoder — Rust port
//
// Ported from doc/educational_decoder/zstd_decompress.{h,c}
// See https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md

pub mod types;
pub mod frame;

// Re-export the public API at crate root for convenience.
pub use frame::{
    parse_dictionary, zstd_decompress, zstd_decompress_with_dict,
    zstd_get_decompressed_size,
};
pub use types::{
    DecompressError, Dictionary, FrameHeader, Result,
};
