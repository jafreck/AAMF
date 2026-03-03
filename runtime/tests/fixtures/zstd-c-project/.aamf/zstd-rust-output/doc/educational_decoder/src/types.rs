// Zstandard educational decoder — type definitions
// Migrated from doc/educational_decoder/zstd_decompress.h and zstd_decompress.c

use std::fmt;

/// Zstandard frame magic number: 0xFD2FB528
pub const ZSTD_MAGIC_NUMBER: u32 = 0xFD2FB528;

/// Maximum block content size (128 KiB)
pub const ZSTD_BLOCK_SIZE_MAX: usize = 128 * 1024;

/// Literal blocks can't be larger than their block
pub const MAX_LITERALS_SIZE: usize = ZSTD_BLOCK_SIZE_MAX;

/// Huffman table decode max bit depth
pub const HUF_MAX_BITS: u8 = 16;

/// Maximum number of Huffman symbols
pub const HUF_MAX_SYMBS: usize = 256;

/// FSE maximum accuracy log
pub const FSE_MAX_ACCURACY_LOG: u8 = 15;

/// FSE maximum number of symbols
pub const FSE_MAX_SYMBS: usize = 256;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Errors produced by the educational decoder.
#[derive(Debug, Clone)]
pub enum DecompressError {
    InputTooSmall,
    OutputTooSmall,
    Corruption,
    BadAlloc,
    InvalidBitRead,
    NonByteAlignedStream,
    NotZstdFrame,
    WrongDictionary,
    DictionaryTooSmall,
    NullDictionarySrc,
    DictionaryCorrupted,
    DictionaryNotSupported,
    FseAccuracyTooLarge,
    TooManySymbols,
    HuffmanDepthTooLarge,
    Impossible,
    Other(String),
}

impl fmt::Display for DecompressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooSmall => write!(f, "Input buffer smaller than it should be or input is corrupted"),
            Self::OutputTooSmall => write!(f, "Output buffer too small for output"),
            Self::Corruption => write!(f, "Corruption detected while decompressing"),
            Self::BadAlloc => write!(f, "Memory allocation error"),
            Self::InvalidBitRead => write!(f, "Attempt to read an invalid number of bits"),
            Self::NonByteAlignedStream => write!(f, "Attempting to operate on a non-byte aligned stream"),
            Self::NotZstdFrame => write!(f, "Tried to decode non-ZSTD frame"),
            Self::WrongDictionary => write!(f, "Wrong dictionary provided"),
            Self::DictionaryTooSmall => write!(f, "Dictionary size cannot be less than 8 bytes"),
            Self::NullDictionarySrc => write!(f, "Tried to create dictionary with pointer to null src"),
            Self::DictionaryCorrupted => write!(f, "Dictionary corrupted"),
            Self::DictionaryNotSupported => write!(f, "dictionary not supported"),
            Self::FseAccuracyTooLarge => write!(f, "FSE accuracy too large"),
            Self::TooManySymbols => write!(f, "Too many symbols for FSE"),
            Self::HuffmanDepthTooLarge => write!(f, "Huffman table depth too large"),
            Self::Impossible => write!(f, "An impossibility has occurred"),
            Self::Other(msg) => write!(f, "Error: {}", msg),
        }
    }
}

impl std::error::Error for DecompressError {}

pub type Result<T> = std::result::Result<T, DecompressError>;

// ---------------------------------------------------------------------------
// IO stream types
// ---------------------------------------------------------------------------

/// Output stream — wraps a mutable byte slice and tracks the write position.
pub struct OStream<'a> {
    pub buf: &'a mut [u8],
    pub pos: usize,
}

impl<'a> OStream<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    /// Number of bytes remaining for writing.
    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    /// Write a single byte.
    pub fn write_byte(&mut self, b: u8) -> Result<()> {
        if self.remaining() == 0 {
            return Err(DecompressError::OutputTooSmall);
        }
        self.buf[self.pos] = b;
        self.pos += 1;
        Ok(())
    }

    /// Get a mutable slice of `len` bytes at the current position and advance.
    pub fn get_write_slice(&mut self, len: usize) -> Result<&mut [u8]> {
        if len > self.remaining() {
            return Err(DecompressError::OutputTooSmall);
        }
        let start = self.pos;
        self.pos += len;
        Ok(&mut self.buf[start..start + len])
    }

    /// Direct access to already-written output for back-references.
    pub fn written(&self) -> &[u8] {
        &self.buf[..self.pos]
    }

    /// Direct mutable access for match-copy at current position.
    pub fn buf_mut(&mut self) -> &mut [u8] {
        self.buf
    }
}

/// Input stream — wraps an immutable byte slice with a bit-level offset.
pub struct IStream<'a> {
    pub data: &'a [u8],
    pub byte_pos: usize,
    pub bit_offset: u8, // 0..7, bits already consumed in the current byte
}

impl<'a> IStream<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_pos: 0,
            bit_offset: 0,
        }
    }

    /// Number of full bytes remaining (stream must be byte-aligned for this to
    /// be meaningful as a byte count).
    pub fn remaining_bytes(&self) -> usize {
        self.data.len() - self.byte_pos
    }

    /// Read `num_bits` bits (1..=64) in little-endian order and advance.
    pub fn read_bits(&mut self, num_bits: u32) -> Result<u64> {
        if num_bits == 0 || num_bits > 64 {
            return Err(DecompressError::InvalidBitRead);
        }

        let total_bit_pos = (self.byte_pos as u64) * 8 + self.bit_offset as u64;
        let end_bit = total_bit_pos + num_bits as u64;
        let end_byte = ((end_bit + 7) / 8) as usize;

        if end_byte > self.data.len() {
            return Err(DecompressError::InputTooSmall);
        }

        let result = read_bits_le(self.data, num_bits, self.byte_pos, self.bit_offset);

        let new_total = total_bit_pos + num_bits as u64;
        self.byte_pos = (new_total / 8) as usize;
        self.bit_offset = (new_total % 8) as u8;

        Ok(result)
    }

    /// Rewind the stream by `num_bits` bits.
    pub fn rewind_bits(&mut self, num_bits: u32) -> Result<()> {
        let total = (self.byte_pos as i64) * 8 + self.bit_offset as i64 - num_bits as i64;
        if total < 0 {
            return Err(DecompressError::InputTooSmall);
        }
        self.byte_pos = (total / 8) as usize;
        self.bit_offset = (total % 8) as u8;
        Ok(())
    }

    /// Align stream to the next byte boundary, consuming remaining bits.
    pub fn align(&mut self) -> Result<()> {
        if self.bit_offset != 0 {
            if self.byte_pos >= self.data.len() {
                return Err(DecompressError::InputTooSmall);
            }
            self.byte_pos += 1;
            self.bit_offset = 0;
        }
        Ok(())
    }

    /// Get a read slice of `len` bytes at the current position and advance.
    /// Stream must be byte-aligned.
    pub fn get_read_slice(&mut self, len: usize) -> Result<&'a [u8]> {
        if self.bit_offset != 0 {
            return Err(DecompressError::NonByteAlignedStream);
        }
        if len > self.remaining_bytes() {
            return Err(DecompressError::InputTooSmall);
        }
        let start = self.byte_pos;
        self.byte_pos += len;
        Ok(&self.data[start..start + len])
    }

    /// Advance by `len` bytes (must be byte-aligned).
    pub fn advance(&mut self, len: usize) -> Result<()> {
        if self.bit_offset != 0 {
            return Err(DecompressError::NonByteAlignedStream);
        }
        if len > self.remaining_bytes() {
            return Err(DecompressError::InputTooSmall);
        }
        self.byte_pos += len;
        Ok(())
    }

    /// Create a sub-stream of `len` bytes at the current position and advance
    /// the parent stream. Must be byte-aligned.
    pub fn sub_stream(&mut self, len: usize) -> Result<IStream<'a>> {
        let slice = self.get_read_slice(len)?;
        Ok(IStream::new(slice))
    }
}

// ---------------------------------------------------------------------------
// Low-level bit reading helpers
// ---------------------------------------------------------------------------

/// Read `num_bits` bits in little-endian from `src` starting at byte `byte_pos`
/// with `bit_offset` bits already consumed in that byte.
pub fn read_bits_le(src: &[u8], num_bits: u32, byte_pos: usize, bit_offset: u8) -> u64 {
    let mut src_idx = byte_pos;
    let mut bo = bit_offset as u32;
    let mut res: u64 = 0;
    let mut shift: u32 = 0;
    let mut left = num_bits as i32;

    while left > 0 {
        let available = 8 - bo;
        let mask: u64 = if left >= available as i32 {
            0xff >> bo
        } else {
            ((1u64 << left as u32) - 1) << bo >> bo
        };
        let byte_val = (src[src_idx] as u64 >> bo) & mask;
        res |= byte_val << shift;
        shift += available;
        left -= available as i32;
        src_idx += 1;
        bo = 0;
    }
    // Mask to exact bit width to avoid extra high bits
    if num_bits < 64 {
        res &= (1u64 << num_bits) - 1;
    }
    res
}

/// Read bits from the end of a bitstream (backwards), updating `offset`.
/// If offset goes negative, fill with zeros.
pub fn stream_read_bits(src: &[u8], bits: u32, offset: &mut i64) -> u64 {
    *offset -= bits as i64;
    if bits == 0 {
        return 0;
    }
    let actual_off: usize;
    let actual_bits: u32;
    if *offset < 0 {
        actual_bits = (bits as i64 + *offset) as u32;
        actual_off = 0;
    } else {
        actual_bits = bits;
        actual_off = *offset as usize;
    }
    if actual_bits == 0 {
        return 0;
    }
    let byte_pos = actual_off / 8;
    let bit_off = (actual_off % 8) as u8;
    let mut res = read_bits_le(src, actual_bits, byte_pos, bit_off);
    if *offset < 0 {
        let shift = (-*offset) as u32;
        res = if shift >= 64 { 0 } else { res << shift };
    }
    res
}

/// Returns the index of the highest set bit, or -1 if `num == 0`.
pub fn highest_set_bit(num: u64) -> i32 {
    if num == 0 {
        return -1;
    }
    63 - num.leading_zeros() as i32
}

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

/// Parsed contents of a Zstandard frame header.
#[derive(Debug, Clone, Default)]
pub struct FrameHeader {
    pub window_size: u64,
    pub frame_content_size: u64,
    pub dictionary_id: u32,
    pub content_checksum_flag: bool,
    pub single_segment_flag: bool,
}

// ---------------------------------------------------------------------------
// Huffman decoding table
// ---------------------------------------------------------------------------

/// Structure containing all tables necessary for efficient Huffman decoding.
#[derive(Debug, Clone, Default)]
pub struct HufDtable {
    pub symbols: Vec<u8>,
    pub num_bits: Vec<u8>,
    pub max_bits: u8,
}

impl HufDtable {
    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty()
    }

    pub fn free(&mut self) {
        self.symbols.clear();
        self.num_bits.clear();
        self.max_bits = 0;
    }
}

// ---------------------------------------------------------------------------
// FSE decoding table
// ---------------------------------------------------------------------------

/// Tables needed to decode FSE encoded streams.
#[derive(Debug, Clone, Default)]
pub struct FseDtable {
    pub symbols: Vec<u8>,
    pub num_bits: Vec<u8>,
    pub new_state_base: Vec<u16>,
    pub accuracy_log: u8,
}

impl FseDtable {
    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty()
    }

    pub fn free(&mut self) {
        self.symbols.clear();
        self.num_bits.clear();
        self.new_state_base.clear();
        self.accuracy_log = 0;
    }
}

// ---------------------------------------------------------------------------
// Frame context — decoding state carried across blocks
// ---------------------------------------------------------------------------

/// The context needed to decode blocks in a frame.
#[derive(Debug, Clone, Default)]
pub struct FrameContext {
    pub header: FrameHeader,
    pub current_total_output: usize,

    pub dict_content: Vec<u8>,

    pub literals_dtable: HufDtable,
    pub ll_dtable: FseDtable,
    pub ml_dtable: FseDtable,
    pub of_dtable: FseDtable,

    /// The last 3 offsets for the special "repeat offsets".
    pub previous_offsets: [u64; 3],
}

impl FrameContext {
    pub fn free_tables(&mut self) {
        self.literals_dtable.free();
        self.ll_dtable.free();
        self.ml_dtable.free();
        self.of_dtable.free();
    }
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

/// The decoded contents of a dictionary.
#[derive(Debug, Clone, Default)]
pub struct Dictionary {
    pub literals_dtable: HufDtable,
    pub ll_dtable: FseDtable,
    pub ml_dtable: FseDtable,
    pub of_dtable: FseDtable,

    pub content: Vec<u8>,

    pub previous_offsets: [u64; 3],
    pub dictionary_id: u32,
}

impl Dictionary {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn free(&mut self) {
        self.literals_dtable.free();
        self.ll_dtable.free();
        self.ml_dtable.free();
        self.of_dtable.free();
        self.content.clear();
        self.previous_offsets = [0; 3];
        self.dictionary_id = 0;
    }
}

// ---------------------------------------------------------------------------
// Sequence command
// ---------------------------------------------------------------------------

/// A tuple containing the parts necessary to decode and execute a ZSTD sequence command.
#[derive(Debug, Clone, Copy, Default)]
pub struct SequenceCommand {
    pub literal_length: u32,
    pub match_length: u32,
    pub offset: u32,
}

// ---------------------------------------------------------------------------
// Sequence table modes
// ---------------------------------------------------------------------------

/// Indicates which sequence table is being decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeqPart {
    LiteralLength = 0,
    Offset = 1,
    MatchLength = 2,
}

/// Compression mode for a sequence table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeqMode {
    Predefined = 0,
    Rle = 1,
    Fse = 2,
    Repeat = 3,
}

impl SeqMode {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Self::Predefined),
            1 => Ok(Self::Rle),
            2 => Ok(Self::Fse),
            3 => Ok(Self::Repeat),
            _ => Err(DecompressError::Impossible),
        }
    }
}

// ---------------------------------------------------------------------------
// Sequence states (FSE state triple)
// ---------------------------------------------------------------------------

/// FSE states for the three sequence symbol types.
#[derive(Debug, Clone, Default)]
pub struct SequenceStates {
    pub ll_table: FseDtable,
    pub of_table: FseDtable,
    pub ml_table: FseDtable,
    pub ll_state: u16,
    pub of_state: u16,
    pub ml_state: u16,
}

// ---------------------------------------------------------------------------
// Default distribution tables for predefined sequence mode
// ---------------------------------------------------------------------------

pub const SEQ_LITERAL_LENGTH_DEFAULT_DIST: [i16; 36] = [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
];

pub const SEQ_OFFSET_DEFAULT_DIST: [i16; 29] = [
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

pub const SEQ_MATCH_LENGTH_DEFAULT_DIST: [i16; 53] = [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];

pub const SEQ_LITERAL_LENGTH_BASELINES: [u32; 36] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40,
    48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
];

pub const SEQ_LITERAL_LENGTH_EXTRA_BITS: [u8; 36] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
    1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];

pub const SEQ_MATCH_LENGTH_BASELINES: [u32; 53] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83,
    99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539,
];

pub const SEQ_MATCH_LENGTH_EXTRA_BITS: [u8; 53] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
    2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];

/// Maximum code values per sequence part: [literal_length, offset, match_length]
pub const SEQ_MAX_CODES: [u8; 3] = [35, 255, 52];
