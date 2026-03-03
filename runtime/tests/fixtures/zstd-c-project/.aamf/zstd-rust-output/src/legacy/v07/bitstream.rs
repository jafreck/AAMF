// Migrated from zstd v0.7 legacy decoder: lib/legacy/zstd_v07.c
// Bitstream decoding API (read backward) — part of the FSE library embedded in v07.

use super::types::{read_le_st, ErrorCode, V07Result};

// ─── Bitstream Status ───────────────────────────────────────────────────────

/// Result of `reload_dstream()`. Maps to `BITv07_DStream_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DStreamStatus {
    Unfinished = 0,
    EndOfBuffer = 1,
    Completed = 2,
    Overflow = 3,
}

// ─── Bitstream Reader ───────────────────────────────────────────────────────

/// Backward bitstream reader.
/// Mirrors `BITv07_DStream_t` from the C source.
///
/// The stream is read from the *end* of the source buffer toward the start.
/// `bit_container` holds a `usize`-width window of bits; `bits_consumed`
/// tracks how many of those bits have already been consumed.
#[derive(Debug, Clone)]
pub struct DStream<'a> {
    /// Current window of bits (native-endian, loaded as LE from source).
    pub bit_container: usize,
    /// Number of bits already consumed from `bit_container`.
    pub bits_consumed: u32,
    /// Pointer into the source buffer — moves backward during reload.
    ptr: usize,
    /// Start index (always 0 for our slice-based API).
    start: usize,
    /// Backing byte buffer.
    src: &'a [u8],
}

/// Number of bits in a `usize` on this platform.
const REGISTER_SIZE: u32 = (std::mem::size_of::<usize>() * 8) as u32;
const REGISTER_BYTES: usize = std::mem::size_of::<usize>();

impl<'a> DStream<'a> {
    // ── Initialisation ──────────────────────────────────────────────────

    /// Initialise a `DStream` from an exact-size source buffer.
    ///
    /// Equivalent of `BITv07_initDStream`.
    /// Returns the source size on success, or an error code.
    pub fn init(src: &'a [u8]) -> V07Result<Self> {
        let src_size = src.len();
        if src_size < 1 {
            return Err(ErrorCode::SrcSizeWrong);
        }

        let last_byte = src[src_size - 1];
        if last_byte == 0 {
            return Err(ErrorCode::Generic); // end-mark not present
        }
        let end_bits = 8 - highest_bit32(last_byte as u32);

        if src_size >= REGISTER_BYTES {
            // Normal case: enough bytes to fill the full container.
            let ptr = src_size - REGISTER_BYTES;
            let bit_container = read_le_st(&src[ptr..]);
            Ok(DStream {
                bit_container,
                bits_consumed: end_bits,
                ptr,
                start: 0,
                src,
            })
        } else {
            // Small source: manually compose the container.
            let mut container: usize = src[0] as usize;
            match src_size {
                7 => {
                    container +=
                        (src[6] as usize) << (REGISTER_SIZE - 16);
                    container +=
                        (src[5] as usize) << (REGISTER_SIZE - 24);
                    container +=
                        (src[4] as usize) << (REGISTER_SIZE - 32);
                    container += (src[3] as usize) << 24;
                    container += (src[2] as usize) << 16;
                    container += (src[1] as usize) << 8;
                }
                6 => {
                    container +=
                        (src[5] as usize) << (REGISTER_SIZE - 24);
                    container +=
                        (src[4] as usize) << (REGISTER_SIZE - 32);
                    container += (src[3] as usize) << 24;
                    container += (src[2] as usize) << 16;
                    container += (src[1] as usize) << 8;
                }
                5 => {
                    container +=
                        (src[4] as usize) << (REGISTER_SIZE - 32);
                    container += (src[3] as usize) << 24;
                    container += (src[2] as usize) << 16;
                    container += (src[1] as usize) << 8;
                }
                4 => {
                    container += (src[3] as usize) << 24;
                    container += (src[2] as usize) << 16;
                    container += (src[1] as usize) << 8;
                }
                3 => {
                    container += (src[2] as usize) << 16;
                    container += (src[1] as usize) << 8;
                }
                2 => {
                    container += (src[1] as usize) << 8;
                }
                _ => {} // 1 byte: just the base
            }

            let extra_consumed = ((REGISTER_BYTES - src_size) * 8) as u32;
            Ok(DStream {
                bit_container: container,
                bits_consumed: end_bits + extra_consumed,
                ptr: 0,
                start: 0,
                src,
            })
        }
    }

    // ── Look / Skip / Read ──────────────────────────────────────────────

    /// Peek at the next `nb_bits` without consuming them.
    /// Equivalent of `BITv07_lookBits`.
    #[inline]
    pub fn look_bits(&self, nb_bits: u32) -> usize {
        let bit_mask = REGISTER_SIZE - 1;
        ((self.bit_container << (self.bits_consumed & bit_mask)) >> 1)
            >> ((bit_mask - nb_bits) & bit_mask)
    }

    /// Peek at the next `nb_bits` (unsafe version, requires `nb_bits >= 1`).
    /// Equivalent of `BITv07_lookBitsFast`.
    #[inline]
    pub fn look_bits_fast(&self, nb_bits: u32) -> usize {
        let bit_mask = REGISTER_SIZE - 1;
        (self.bit_container << (self.bits_consumed & bit_mask))
            >> (((bit_mask + 1) - nb_bits) & bit_mask)
    }

    /// Consume `nb_bits` from the stream without reading them.
    /// Equivalent of `BITv07_skipBits`.
    #[inline]
    pub fn skip_bits(&mut self, nb_bits: u32) {
        self.bits_consumed += nb_bits;
    }

    /// Read (look + skip) `nb_bits` from the stream.
    /// Equivalent of `BITv07_readBits`.
    #[inline]
    pub fn read_bits(&mut self, nb_bits: u32) -> usize {
        let value = self.look_bits(nb_bits);
        self.skip_bits(nb_bits);
        value
    }

    /// Read `nb_bits` (unsafe fast version, requires `nb_bits >= 1`).
    /// Equivalent of `BITv07_readBitsFast`.
    #[inline]
    pub fn read_bits_fast(&mut self, nb_bits: u32) -> usize {
        let value = self.look_bits_fast(nb_bits);
        self.skip_bits(nb_bits);
        value
    }

    // ── Reload ──────────────────────────────────────────────────────────

    /// Reload the bit container from the source buffer.
    /// Equivalent of `BITv07_reloadDStream`.
    pub fn reload(&mut self) -> DStreamStatus {
        if self.bits_consumed > REGISTER_SIZE {
            return DStreamStatus::Overflow;
        }

        if self.ptr >= self.start + REGISTER_BYTES {
            self.ptr -= (self.bits_consumed >> 3) as usize;
            self.bits_consumed &= 7;
            self.bit_container = read_le_st(&self.src[self.ptr..]);
            return DStreamStatus::Unfinished;
        }

        if self.ptr == self.start {
            if self.bits_consumed < REGISTER_SIZE {
                return DStreamStatus::EndOfBuffer;
            }
            return DStreamStatus::Completed;
        }

        // Partial reload
        let mut nb_bytes = (self.bits_consumed >> 3) as usize;
        let mut result = DStreamStatus::Unfinished;
        if self.ptr.saturating_sub(nb_bytes) < self.start {
            nb_bytes = self.ptr - self.start;
            result = DStreamStatus::EndOfBuffer;
        }
        self.ptr -= nb_bytes;
        self.bits_consumed -= (nb_bytes as u32) * 8;
        self.bit_container = read_le_st(&self.src[self.ptr..]);
        result
    }

    // ── End Check ───────────────────────────────────────────────────────

    /// Returns `true` if the stream has been fully consumed.
    /// Equivalent of `BITv07_endOfDStream`.
    #[inline]
    pub fn end_of_stream(&self) -> bool {
        self.ptr == self.start && self.bits_consumed == REGISTER_SIZE
    }
}

// ─── Helper: Highest Bit ────────────────────────────────────────────────────

/// Return the position of the highest set bit (0-indexed from LSB).
/// Equivalent of `BITv07_highbit32`.
///
/// For `val == 0` the behaviour is technically undefined in the C source
/// (the GCC intrinsic returns garbage); here we return 0 to match the
/// DeBruijn fallback path.
#[inline]
pub fn highest_bit32(val: u32) -> u32 {
    if val == 0 {
        return 0;
    }
    31 - val.leading_zeros()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_highest_bit32() {
        assert_eq!(highest_bit32(1), 0);
        assert_eq!(highest_bit32(2), 1);
        assert_eq!(highest_bit32(255), 7);
        assert_eq!(highest_bit32(256), 8);
        assert_eq!(highest_bit32(0x8000_0000), 31);
    }

    #[test]
    fn test_empty_src_error() {
        assert!(DStream::init(&[]).is_err());
    }

    #[test]
    fn test_zero_last_byte_error() {
        // Last byte 0 means no end-mark.
        assert!(DStream::init(&[0]).is_err());
        assert!(DStream::init(&[1, 0]).is_err());
    }

    #[test]
    fn test_init_single_byte() {
        // 0x80 = 1000_0000 → highest bit = 7, bitsConsumed = 8-7 = 1
        let ds = DStream::init(&[0x80]).unwrap();
        assert_eq!(ds.bits_consumed & 7, 1); // modulo extra padding bits
        assert!(ds.bit_container != 0);
    }

    #[test]
    fn test_init_large_buffer() {
        let buf = vec![0xAAu8; 16];
        // Last byte must be non-zero (it already is 0xAA).
        let ds = DStream::init(&buf).unwrap();
        // ptr should point REGISTER_BYTES from the end
        assert_eq!(ds.ptr, buf.len() - REGISTER_BYTES);
    }

    #[test]
    fn test_read_bits_basic() {
        // Build a small stream: [0x01, 0x80]
        // last byte = 0x80 → highbit=7, bitsConsumed=1
        let buf = [0x01u8, 0x80];
        let mut ds = DStream::init(&buf).unwrap();
        // We can read some bits from the container.
        let _ = ds.read_bits(1);
        // Just ensure it doesn't panic.
    }

    #[test]
    fn test_reload_completed() {
        // Minimal 1-byte stream
        let buf = [0x80u8];
        let mut ds = DStream::init(&buf).unwrap();
        // Consume all meaningful bits
        while ds.bits_consumed < REGISTER_SIZE {
            ds.skip_bits(1);
        }
        let status = ds.reload();
        assert_eq!(status, DStreamStatus::Completed);
        assert!(ds.end_of_stream());
    }

    #[test]
    fn test_reload_overflow() {
        let buf = [0x80u8];
        let mut ds = DStream::init(&buf).unwrap();
        ds.bits_consumed = REGISTER_SIZE + 1;
        assert_eq!(ds.reload(), DStreamStatus::Overflow);
    }
}
