// Migrated from zstd v0.7 legacy decoder: lib/legacy/zstd_v07.c + zstd_v07.h
// Types, constants, and structural definitions for the v0.7 format decoder.

use std::{ffi::c_void, fmt};

// ─── Magic Numbers ──────────────────────────────────────────────────────────

pub const ZSTDV07_MAGICNUMBER: u32 = 0xFD2FB527;
pub const ZSTDV07_MAGIC_SKIPPABLE_START: u32 = 0x184D2A50;
pub const ZSTDV07_DICT_MAGIC: u32 = 0xEC30A437;

// ─── Window / Chain / Hash / Search Constants ───────────────────────────────

pub const ZSTDV07_WINDOWLOG_MAX_32: u32 = 25;
pub const ZSTDV07_WINDOWLOG_MAX_64: u32 = 27;

/// Runtime-selected max window log (32-bit vs 64-bit).
#[inline]
pub fn zstdv07_windowlog_max() -> u32 {
    if std::mem::size_of::<usize>() == 4 {
        ZSTDV07_WINDOWLOG_MAX_32
    } else {
        ZSTDV07_WINDOWLOG_MAX_64
    }
}

pub const ZSTDV07_WINDOWLOG_MIN: u32 = 18;
pub const ZSTDV07_WINDOWLOG_ABSOLUTEMIN: u32 = 10;

#[inline]
pub fn zstdv07_chainlog_max() -> u32 {
    zstdv07_windowlog_max() + 1
}

pub const ZSTDV07_CHAINLOG_MIN: u32 = 4;

#[inline]
pub fn zstdv07_hashlog_max() -> u32 {
    zstdv07_windowlog_max()
}

pub const ZSTDV07_HASHLOG_MIN: u32 = 12;
pub const ZSTDV07_HASHLOG3_MAX: u32 = 17;

#[inline]
pub fn zstdv07_searchlog_max() -> u32 {
    zstdv07_windowlog_max() - 1
}

pub const ZSTDV07_SEARCHLOG_MIN: u32 = 1;
pub const ZSTDV07_SEARCHLENGTH_MAX: u32 = 7;
pub const ZSTDV07_SEARCHLENGTH_MIN: u32 = 3;
pub const ZSTDV07_TARGETLENGTH_MIN: u32 = 4;
pub const ZSTDV07_TARGETLENGTH_MAX: u32 = 999;

// ─── Frame Header Constants ─────────────────────────────────────────────────

pub const ZSTDV07_FRAMEHEADERSIZE_MAX: usize = 18;
pub const ZSTDV07_FRAME_HEADER_SIZE_MIN: usize = 5;
pub const ZSTDV07_SKIPPABLE_HEADER_SIZE: usize = 8;

// ─── Block Constants ────────────────────────────────────────────────────────

pub const ZSTDV07_BLOCKSIZE_ABSOLUTEMAX: usize = 128 * 1024;
pub const ZSTDV07_BLOCKHEADERSIZE: usize = 3;

// ─── Content Size Error Sentinel ────────────────────────────────────────────

pub const ZSTD_CONTENTSIZE_ERROR: u64 = 0u64.wrapping_sub(2);

// ─── Repetition Offsets ─────────────────────────────────────────────────────

pub const ZSTDV07_REP_NUM: usize = 3;
pub const ZSTDV07_REP_INIT: usize = ZSTDV07_REP_NUM;
pub const ZSTDV07_REP_MOVE: usize = ZSTDV07_REP_NUM - 1;
pub const REP_START_VALUE: [u32; ZSTDV07_REP_NUM] = [1, 4, 8];

// ─── Bit Constants ──────────────────────────────────────────────────────────

pub const BIT7: u8 = 128;
pub const BIT6: u8 = 64;
pub const BIT5: u8 = 32;
pub const BIT4: u8 = 16;
pub const BIT1: u8 = 2;
pub const BIT0: u8 = 1;

// ─── Sequence Constants ─────────────────────────────────────────────────────

pub const MINMATCH: usize = 3;
pub const EQUAL_READ32: usize = 4;

pub const LIT_BITS: u32 = 8;
pub const MAX_LIT: u32 = (1 << LIT_BITS) - 1;
pub const MAX_ML: usize = 52;
pub const MAX_LL: usize = 35;
pub const MAX_OFF: usize = 28;

/// max(MaxLL, MaxML) — assumption: MaxOff < MaxLL, MaxML
pub const MAX_SEQ: usize = if MAX_LL > MAX_ML { MAX_LL } else { MAX_ML };

pub const ML_FSE_LOG: u32 = 9;
pub const LL_FSE_LOG: u32 = 9;
pub const OFF_FSE_LOG: u32 = 8;

pub const MIN_SEQUENCES_SIZE: usize = 1;
pub const MIN_CBLOCK_SIZE: usize = 1 + 1 + MIN_SEQUENCES_SIZE;

pub const LONGNBSEQ: u32 = 0x7F00;

pub const WILDCOPY_OVERLENGTH: usize = 8;

// ─── FSE Encoding Modes ─────────────────────────────────────────────────────

pub const FSEV07_ENCODING_RAW: u32 = 0;
pub const FSEV07_ENCODING_RLE: u32 = 1;
pub const FSEV07_ENCODING_STATIC: u32 = 2;
pub const FSEV07_ENCODING_DYNAMIC: u32 = 3;

// ─── FSE Constants ──────────────────────────────────────────────────────────

pub const FSEV07_MAX_MEMORY_USAGE: u32 = 14;
pub const FSEV07_DEFAULT_MEMORY_USAGE: u32 = 13;
pub const FSEV07_MAX_SYMBOL_VALUE: u32 = 255;
pub const FSEV07_MAX_TABLELOG: u32 = FSEV07_MAX_MEMORY_USAGE - 2;
pub const FSEV07_MAX_TABLESIZE: u32 = 1 << FSEV07_MAX_TABLELOG;
pub const FSEV07_MAXTABLESIZE_MASK: u32 = FSEV07_MAX_TABLESIZE - 1;
pub const FSEV07_DEFAULT_TABLELOG: u32 = FSEV07_DEFAULT_MEMORY_USAGE - 2;
pub const FSEV07_MIN_TABLELOG: u32 = 5;
pub const FSEV07_TABLELOG_ABSOLUTE_MAX: u32 = 15;
pub const FSEV07_NCOUNTBOUND: usize = 512;

#[inline]
pub const fn fsev07_dtable_size_u32(max_table_log: u32) -> usize {
    1 + (1usize << max_table_log)
}

#[inline]
pub const fn fsev07_tablestep(table_size: u32) -> u32 {
    (table_size >> 1) + (table_size >> 3) + 3
}

// ─── HUF Constants ──────────────────────────────────────────────────────────

pub const HUFV07_TABLELOG_ABSOLUTEMAX: u32 = 16;
pub const HUFV07_TABLELOG_MAX: u32 = 12;
pub const HUFV07_TABLELOG_DEFAULT: u32 = 11;
pub const HUFV07_SYMBOLVALUE_MAX: u32 = 255;
pub const HUFV07_BLOCKSIZE_MAX: usize = 128 * 1024;

pub const ZSTD_HUFFDTABLE_CAPACITY_LOG: u32 = 12;

#[inline]
pub const fn hufv07_dtable_size(max_table_log: u32) -> usize {
    1 + (1usize << max_table_log)
}

// ─── Field-Size Lookup Tables ───────────────────────────────────────────────

pub const ZSTDV07_FCS_FIELD_SIZE: [usize; 4] = [0, 2, 4, 8];
pub const ZSTDV07_DID_FIELD_SIZE: [usize; 4] = [0, 1, 2, 4];

// ─── Default Normalized Distributions ───────────────────────────────────────

pub const LL_BITS: [u32; MAX_LL + 1] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
    13, 14, 15, 16,
];

pub const LL_DEFAULT_NORM: [i16; MAX_LL + 1] = [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
    -1, -1, -1, -1,
];

pub const LL_DEFAULT_NORM_LOG: u32 = 6;

pub const ML_BITS: [u32; MAX_ML + 1] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11,
    12, 13, 14, 15, 16,
];

pub const ML_DEFAULT_NORM: [i16; MAX_ML + 1] = [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
    -1, -1, -1, -1, -1,
];

pub const ML_DEFAULT_NORM_LOG: u32 = 6;

pub const OF_DEFAULT_NORM: [i16; MAX_OFF + 1] = [
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

pub const OF_DEFAULT_NORM_LOG: u32 = 5;

// ─── Enumerations ───────────────────────────────────────────────────────────

/// Block type as stored in the block header (top 2 bits).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BlockType {
    Compressed = 0,
    Raw = 1,
    Rle = 2,
    End = 3,
}

impl BlockType {
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(BlockType::Compressed),
            1 => Some(BlockType::Raw),
            2 => Some(BlockType::Rle),
            3 => Some(BlockType::End),
            _ => None,
        }
    }
}

/// Literal block type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LitBlockType {
    Huffman = 0,
    Repeat = 1,
    Raw = 2,
    Rle = 3,
}

impl LitBlockType {
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(LitBlockType::Huffman),
            1 => Some(LitBlockType::Repeat),
            2 => Some(LitBlockType::Raw),
            3 => Some(LitBlockType::Rle),
            _ => None,
        }
    }
}

/// Decompression stage for the streaming state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DStage {
    GetFrameHeaderSize,
    DecodeFrameHeader,
    DecodeBlockHeader,
    DecompressBlock,
    DecodeSkippableHeader,
    SkipFrame,
}

// ─── Struct Types ───────────────────────────────────────────────────────────

/// Frame parameters extracted from the v0.7 frame header.
/// Mirrors `ZSTDv07_frameParams` from the C header.
#[derive(Debug, Clone, Copy, Default)]
pub struct FrameParams {
    pub frame_content_size: u64,
    pub window_size: u32,
    pub dict_id: u32,
    pub checksum_flag: u32,
}

/// Block properties extracted from a block header.
#[derive(Debug, Clone, Copy, Default)]
pub struct BlockProperties {
    pub block_type: Option<BlockType>,
    pub orig_size: u32,
}

/// Custom memory allocator callbacks (opaque-pointer style).
/// In Rust this is modeled with trait objects or closures; here we provide
/// a structural equivalent that other modules can adapt.
pub struct CustomMem {
    pub alloc_fn: Option<fn(*mut c_void, usize) -> *mut u8>,
    pub free_fn: Option<fn(*mut c_void, *mut u8)>,
    pub opaque: *mut c_void,
}

impl Default for CustomMem {
    fn default() -> Self {
        Self {
            alloc_fn: None,
            free_fn: None,
            opaque: std::ptr::null_mut(),
        }
    }
}

/// FSE decode entry — mirrors `FSEv07_decode_t`.
#[derive(Debug, Clone, Copy, Default)]
#[repr(C)]
pub struct FseDecodeEntry {
    pub new_state: u16,
    pub symbol: u8,
    pub nb_bits: u8,
}

/// FSE DTable header — mirrors `FSEv07_DTableHeader`.
#[derive(Debug, Clone, Copy, Default)]
#[repr(C)]
pub struct FseDTableHeader {
    pub table_log: u16,
    pub fast_mode: u16,
}

/// FSE decode state — mirrors `FSEv07_DState_t`.
#[derive(Debug, Clone)]
pub struct FseDState {
    pub state: usize,
    pub table: Vec<FseDecodeEntry>,
}

impl FseDState {
    pub fn new() -> Self {
        Self {
            state: 0,
            table: Vec::new(),
        }
    }
}

/// Match (offset + length) used in sequence store.
#[derive(Debug, Clone, Copy, Default)]
pub struct Match {
    pub off: u32,
    pub len: u32,
}

/// Optimal parse entry.
#[derive(Debug, Clone)]
pub struct Optimal {
    pub price: u32,
    pub off: u32,
    pub mlen: u32,
    pub litlen: u32,
    pub rep: [u32; ZSTDV07_REP_INIT],
}

impl Default for Optimal {
    fn default() -> Self {
        Self {
            price: 0,
            off: 0,
            mlen: 0,
            litlen: 0,
            rep: [0; ZSTDV07_REP_INIT],
        }
    }
}

/// Placeholder for stats (unused in the C source).
#[derive(Debug, Clone, Copy, Default)]
pub struct Stats {
    pub unused: u32,
}

// ─── Error Handling ─────────────────────────────────────────────────────────

/// Error codes mirroring the C `ERR_enum` / `ZSTD_ErrorCode` used by v0.7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NoError,
    Generic,
    PrefixUnknown,
    VersionUnsupported,
    ParameterUnsupported,
    FrameHeaderSizeWrong,
    SrcSizeWrong,
    DstSizeTooSmall,
    CorruptionDetected,
    ChecksumWrong,
    TableLogTooLarge,
    MaxSymbolValueTooLarge,
    MaxSymbolValueTooSmall,
    DictionaryCorrupted,
    DictionaryWrong,
    StageWrong,
    MemoryAllocation,
    InitMissing,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            ErrorCode::NoError => "No error",
            ErrorCode::Generic => "Error (generic)",
            ErrorCode::PrefixUnknown => "Unknown frame descriptor",
            ErrorCode::VersionUnsupported => "Version not supported",
            ErrorCode::ParameterUnsupported => "Unsupported parameter",
            ErrorCode::FrameHeaderSizeWrong => "Frame header size error",
            ErrorCode::SrcSizeWrong => "Src size is incorrect",
            ErrorCode::DstSizeTooSmall => "Dst buffer too small",
            ErrorCode::CorruptionDetected => "Corrupted block detected",
            ErrorCode::ChecksumWrong => "Checksum does not match",
            ErrorCode::TableLogTooLarge => "tableLog is too large",
            ErrorCode::MaxSymbolValueTooLarge => "maxSymbolValue is too large",
            ErrorCode::MaxSymbolValueTooSmall => "maxSymbolValue is too small",
            ErrorCode::DictionaryCorrupted => "Dictionary is corrupted",
            ErrorCode::DictionaryWrong => "Dictionary mismatch",
            ErrorCode::StageWrong => "Operation not authorized at current stage",
            ErrorCode::MemoryAllocation => "Allocation error: not enough memory",
            ErrorCode::InitMissing => "Context should be init first",
        };
        write!(f, "{msg}")
    }
}

impl std::error::Error for ErrorCode {}

/// Result type used throughout the v07 decoder.
pub type V07Result<T> = Result<T, ErrorCode>;

// ─── Utility Functions ──────────────────────────────────────────────────────

/// Copy exactly 8 bytes (equivalent of `ZSTDv07_copy8`).
#[inline]
pub fn copy8(dst: &mut [u8], src: &[u8]) {
    dst[..8].copy_from_slice(&src[..8]);
}

/// Copy exactly 4 bytes (equivalent of `ZSTDv07_copy4`).
#[inline]
pub fn copy4(dst: &mut [u8], src: &[u8]) {
    dst[..4].copy_from_slice(&src[..4]);
}

/// Wildcard copy: may over-read up to 7 bytes past `length`
/// (8 bytes if `length == 0`).
/// Equivalent of `ZSTDv07_wildcopy` — uses do-while semantics: always
/// copies at least one 8-byte chunk even when `length == 0`.
#[inline]
pub fn wildcopy(dst: &mut [u8], src: &[u8], length: usize) {
    let mut pos: usize = 0;
    loop {
        let end = (pos + 8).min(dst.len()).min(src.len());
        let chunk = end - pos;
        if chunk > 0 {
            dst[pos..pos + chunk].copy_from_slice(&src[pos..pos + chunk]);
        }
        pos += 8;
        if pos >= length {
            break;
        }
    }
}

// ─── Memory I/O (Little-Endian) ─────────────────────────────────────────────

/// Read a little-endian `u16` from a byte slice.
#[inline]
pub fn read_le16(data: &[u8]) -> u16 {
    u16::from_le_bytes([data[0], data[1]])
}

/// Read a little-endian `u32` from a byte slice.
#[inline]
pub fn read_le32(data: &[u8]) -> u32 {
    u32::from_le_bytes([data[0], data[1], data[2], data[3]])
}

/// Read a little-endian `u64` from a byte slice.
#[inline]
pub fn read_le64(data: &[u8]) -> u64 {
    u64::from_le_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ])
}

/// Read a little-endian `usize` (4 bytes on 32-bit, 8 bytes on 64-bit).
#[inline]
pub fn read_le_st(data: &[u8]) -> usize {
    if std::mem::size_of::<usize>() == 4 {
        read_le32(data) as usize
    } else {
        read_le64(data) as usize
    }
}

/// Write a little-endian `u16` into a byte slice.
#[inline]
pub fn write_le16(dst: &mut [u8], val: u16) {
    let bytes = val.to_le_bytes();
    dst[0] = bytes[0];
    dst[1] = bytes[1];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_magic_numbers() {
        assert_eq!(ZSTDV07_MAGICNUMBER, 0xFD2FB527);
        assert_eq!(ZSTDV07_MAGIC_SKIPPABLE_START, 0x184D2A50);
        assert_eq!(ZSTDV07_DICT_MAGIC, 0xEC30A437);
    }

    #[test]
    fn test_block_type_roundtrip() {
        for val in 0..=3u8 {
            let bt = BlockType::from_u8(val).unwrap();
            assert_eq!(bt as u8, val);
        }
        assert!(BlockType::from_u8(4).is_none());
    }

    #[test]
    fn test_lit_block_type_roundtrip() {
        for val in 0..=3u8 {
            let lt = LitBlockType::from_u8(val).unwrap();
            assert_eq!(lt as u8, val);
        }
        assert!(LitBlockType::from_u8(4).is_none());
    }

    #[test]
    fn test_read_write_le16() {
        let mut buf = [0u8; 2];
        write_le16(&mut buf, 0x0102);
        assert_eq!(read_le16(&buf), 0x0102);
    }

    #[test]
    fn test_read_le32() {
        let buf = 0x12345678u32.to_le_bytes();
        assert_eq!(read_le32(&buf), 0x12345678);
    }

    #[test]
    fn test_read_le64() {
        let buf = 0x0102030405060708u64.to_le_bytes();
        assert_eq!(read_le64(&buf), 0x0102030405060708);
    }

    #[test]
    fn test_fse_constants() {
        assert_eq!(FSEV07_MAX_TABLELOG, 12);
        assert_eq!(FSEV07_MAX_TABLESIZE, 4096);
        assert_eq!(fsev07_dtable_size_u32(12), 4097);
    }

    #[test]
    fn test_content_size_error() {
        assert_eq!(ZSTD_CONTENTSIZE_ERROR, u64::MAX - 1);
    }

    #[test]
    fn test_default_norm_lengths() {
        assert_eq!(LL_BITS.len(), MAX_LL + 1);
        assert_eq!(LL_DEFAULT_NORM.len(), MAX_LL + 1);
        assert_eq!(ML_BITS.len(), MAX_ML + 1);
        assert_eq!(ML_DEFAULT_NORM.len(), MAX_ML + 1);
        assert_eq!(OF_DEFAULT_NORM.len(), MAX_OFF + 1);
    }

    #[test]
    fn test_wildcopy() {
        let src = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let mut dst = [0u8; 16];
        wildcopy(&mut dst, &src, 10);
        assert_eq!(&dst[..10], &src[..10]);
    }

    #[test]
    fn test_wildcopy_zero_length() {
        // C do-while semantics: always copies at least 8 bytes even when length==0
        let src = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut dst = [0u8; 8];
        wildcopy(&mut dst, &src, 0);
        assert_eq!(&dst[..8], &src[..8]);
    }
}
