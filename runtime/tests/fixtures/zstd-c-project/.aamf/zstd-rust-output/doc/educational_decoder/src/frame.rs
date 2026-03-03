// Zstandard educational decoder — frame-level decompression
// Migrated from doc/educational_decoder/zstd_decompress.c (lines 1–660+)

use crate::types::*;

// ---------------------------------------------------------------------------
// Public decompression API
// ---------------------------------------------------------------------------

/// Decompress a single Zstandard frame without a dictionary.
///
/// `dst` must be large enough to hold the decompressed output.
/// Returns the number of decompressed bytes written.
pub fn zstd_decompress(dst: &mut [u8], src: &[u8]) -> Result<usize> {
    let dict = Dictionary::new();
    zstd_decompress_with_dict(dst, src, &dict)
}

/// Decompress a single Zstandard frame with an optional parsed dictionary.
///
/// Returns the number of decompressed bytes written.
pub fn zstd_decompress_with_dict(
    dst: &mut [u8],
    src: &[u8],
    parsed_dict: &Dictionary,
) -> Result<usize> {
    let mut input = IStream::new(src);
    let mut output = OStream::new(dst);

    // This decoder assumes decompression of a single frame.
    decode_frame(&mut output, &mut input, parsed_dict)?;

    Ok(output.pos)
}

/// Get the decompressed size of an input stream so memory can be allocated in
/// advance. Returns `None` if the size can't be determined.
/// Assumes decompression of a single frame.
pub fn zstd_get_decompressed_size(src: &[u8]) -> Result<Option<u64>> {
    let mut input = IStream::new(src);

    let magic_number = input.read_bits(32)? as u32;
    if magic_number != ZSTD_MAGIC_NUMBER {
        return Err(DecompressError::Other(
            "ZSTD frame magic number did not match".into(),
        ));
    }

    let header = parse_frame_header(&mut input)?;

    if header.frame_content_size == 0 && !header.single_segment_flag {
        return Ok(None);
    }
    Ok(Some(header.frame_content_size))
}

// ---------------------------------------------------------------------------
// Frame decoding
// ---------------------------------------------------------------------------

/// Decode a single Zstd frame. Validates the magic number, then delegates
/// to `decode_data_frame`.
fn decode_frame(
    out: &mut OStream,
    input: &mut IStream,
    dict: &Dictionary,
) -> Result<()> {
    let magic_number = input.read_bits(32)? as u32;
    if magic_number == ZSTD_MAGIC_NUMBER {
        decode_data_frame(out, input, dict)?;
        return Ok(());
    }
    Err(DecompressError::NotZstdFrame)
}

/// Decode a data frame (not a skippable frame).
fn decode_data_frame(
    out: &mut OStream,
    input: &mut IStream,
    dict: &Dictionary,
) -> Result<()> {
    let mut ctx = init_frame_context(input, dict)?;

    if ctx.header.frame_content_size != 0
        && ctx.header.frame_content_size as usize > out.remaining()
    {
        return Err(DecompressError::OutputTooSmall);
    }

    decompress_data(&mut ctx, out, input)?;

    ctx.free_tables();
    Ok(())
}

/// Initialize frame context from header and optional dictionary.
fn init_frame_context(input: &mut IStream, dict: &Dictionary) -> Result<FrameContext> {
    let header = parse_frame_header(input)?;

    let mut ctx = FrameContext {
        header,
        current_total_output: 0,
        dict_content: Vec::new(),
        literals_dtable: HufDtable::default(),
        ll_dtable: FseDtable::default(),
        ml_dtable: FseDtable::default(),
        of_dtable: FseDtable::default(),
        previous_offsets: [1, 4, 8],
    };

    frame_context_apply_dict(&mut ctx, dict)?;
    Ok(ctx)
}

/// Parse the frame header descriptor and fields.
pub fn parse_frame_header(input: &mut IStream) -> Result<FrameHeader> {
    let descriptor = input.read_bits(8)? as u8;

    let frame_content_size_flag = descriptor >> 6;
    let single_segment_flag = (descriptor >> 5) & 1 != 0;
    let reserved_bit = (descriptor >> 3) & 1;
    let content_checksum_flag = (descriptor >> 2) & 1 != 0;
    let dictionary_id_flag = descriptor & 3;

    if reserved_bit != 0 {
        return Err(DecompressError::Corruption);
    }

    let mut header = FrameHeader {
        single_segment_flag,
        content_checksum_flag,
        ..Default::default()
    };

    // Window descriptor
    if !single_segment_flag {
        let window_descriptor = input.read_bits(8)? as u8;
        let exponent = window_descriptor >> 3;
        let mantissa = window_descriptor & 7;

        let window_base: u64 = 1u64 << (10 + exponent);
        let window_add = (window_base / 8) * mantissa as u64;
        header.window_size = window_base + window_add;
    }

    // Dictionary ID
    if dictionary_id_flag != 0 {
        let bytes_array: [u32; 4] = [0, 1, 2, 4];
        let bytes = bytes_array[dictionary_id_flag as usize];
        header.dictionary_id = input.read_bits(bytes * 8)? as u32;
    }

    // Frame content size
    if single_segment_flag || frame_content_size_flag != 0 {
        let bytes_array: [u32; 4] = [1, 2, 4, 8];
        let bytes = bytes_array[frame_content_size_flag as usize];
        header.frame_content_size = input.read_bits(bytes * 8)?;
        if bytes == 2 {
            header.frame_content_size += 256;
        }
    }

    if single_segment_flag {
        header.window_size = header.frame_content_size;
    }

    Ok(header)
}

// ---------------------------------------------------------------------------
// Block-level decompression (data loop)
// ---------------------------------------------------------------------------

/// Decompress data from a frame block by block.
fn decompress_data(
    ctx: &mut FrameContext,
    out: &mut OStream,
    input: &mut IStream,
) -> Result<()> {
    loop {
        let last_block = input.read_bits(1)? != 0;
        let block_type = input.read_bits(2)? as u32;
        let block_len = input.read_bits(21)? as usize;

        match block_type {
            0 => {
                // Raw_Block
                let read_data = input.get_read_slice(block_len)?;
                let write_data = out.get_write_slice(block_len)?;
                write_data.copy_from_slice(read_data);
                ctx.current_total_output += block_len;
            }
            1 => {
                // RLE_Block
                let read_data = input.get_read_slice(1)?;
                let byte_val = read_data[0];
                let write_data = out.get_write_slice(block_len)?;
                write_data.iter_mut().for_each(|b| *b = byte_val);
                ctx.current_total_output += block_len;
            }
            2 => {
                // Compressed_Block
                let block_data = input.get_read_slice(block_len)?;
                let mut block_stream = IStream::new(block_data);
                decompress_block(ctx, out, &mut block_stream)?;
            }
            3 => {
                return Err(DecompressError::Corruption);
            }
            _ => {
                return Err(DecompressError::Impossible);
            }
        }

        if last_block {
            break;
        }
    }

    if ctx.header.content_checksum_flag {
        // Skip the 4-byte checksum (not verified)
        input.advance(4)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Block decompression
// ---------------------------------------------------------------------------

fn decompress_block(
    ctx: &mut FrameContext,
    out: &mut OStream,
    input: &mut IStream,
) -> Result<()> {
    // Part 1: decode literals
    let literals = decode_literals(ctx, input)?;

    // Part 2: decode sequences
    let sequences = decode_sequences(ctx, input)?;

    // Part 3: execute sequences
    execute_sequences(ctx, out, &literals, &sequences)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Literals decoding
// ---------------------------------------------------------------------------

fn decode_literals(
    ctx: &mut FrameContext,
    input: &mut IStream,
) -> Result<Vec<u8>> {
    let block_type = input.read_bits(2)? as u32;
    let size_format = input.read_bits(2)? as u32;

    if block_type <= 1 {
        decode_literals_simple(input, block_type, size_format)
    } else {
        decode_literals_compressed(ctx, input, block_type, size_format)
    }
}

fn decode_literals_simple(
    input: &mut IStream,
    block_type: u32,
    size_format: u32,
) -> Result<Vec<u8>> {
    let size = match size_format {
        0 | 2 => {
            input.rewind_bits(1)?;
            input.read_bits(5)? as usize
        }
        1 => input.read_bits(12)? as usize,
        3 => input.read_bits(20)? as usize,
        _ => return Err(DecompressError::Impossible),
    };

    if size > MAX_LITERALS_SIZE {
        return Err(DecompressError::Corruption);
    }

    let mut literals = vec![0u8; size];

    match block_type {
        0 => {
            let data = input.get_read_slice(size)?;
            literals.copy_from_slice(data);
        }
        1 => {
            let data = input.get_read_slice(1)?;
            literals.iter_mut().for_each(|b| *b = data[0]);
        }
        _ => return Err(DecompressError::Impossible),
    }

    Ok(literals)
}

fn decode_literals_compressed(
    ctx: &mut FrameContext,
    input: &mut IStream,
    block_type: u32,
    size_format: u32,
) -> Result<Vec<u8>> {
    let mut num_streams = 4u32;
    let (regenerated_size, compressed_size) = match size_format {
        0 => {
            num_streams = 1;
            let r = input.read_bits(10)? as usize;
            let c = input.read_bits(10)? as usize;
            (r, c)
        }
        1 => {
            let r = input.read_bits(10)? as usize;
            let c = input.read_bits(10)? as usize;
            (r, c)
        }
        2 => {
            let r = input.read_bits(14)? as usize;
            let c = input.read_bits(14)? as usize;
            (r, c)
        }
        3 => {
            let r = input.read_bits(18)? as usize;
            let c = input.read_bits(18)? as usize;
            (r, c)
        }
        _ => return Err(DecompressError::Impossible),
    };

    if regenerated_size > MAX_LITERALS_SIZE {
        return Err(DecompressError::Corruption);
    }

    let mut literals = vec![0u8; regenerated_size];
    let mut lit_stream = OStream::new(&mut literals);

    let huf_data = input.get_read_slice(compressed_size)?;
    let mut huf_stream = IStream::new(huf_data);

    if block_type == 2 {
        ctx.literals_dtable.free();
        ctx.literals_dtable = decode_huf_table(&mut huf_stream)?;
    } else {
        if ctx.literals_dtable.is_empty() {
            return Err(DecompressError::Corruption);
        }
    }

    let symbols_decoded = if num_streams == 1 {
        huf_decompress_1stream(&ctx.literals_dtable, &mut lit_stream, &mut huf_stream)?
    } else {
        huf_decompress_4stream(&ctx.literals_dtable, &mut lit_stream, &mut huf_stream)?
    };

    if symbols_decoded != regenerated_size {
        return Err(DecompressError::Corruption);
    }

    Ok(literals)
}

// ---------------------------------------------------------------------------
// Huffman table decoding
// ---------------------------------------------------------------------------

fn decode_huf_table(input: &mut IStream) -> Result<HufDtable> {
    let header_byte = input.read_bits(8)? as u8;

    let mut weights = [0u8; HUF_MAX_SYMBS];
    let num_symbs: usize;

    if header_byte >= 128 {
        num_symbs = (header_byte - 127) as usize;
        let bytes = (num_symbs + 1) / 2;
        let weight_src = input.get_read_slice(bytes)?;

        for i in 0..num_symbs {
            if i % 2 == 0 {
                weights[i] = weight_src[i / 2] >> 4;
            } else {
                weights[i] = weight_src[i / 2] & 0xf;
            }
        }
    } else {
        let fse_data = input.get_read_slice(header_byte as usize)?;
        let mut fse_stream = IStream::new(fse_data);
        let mut weight_buf = [0u8; HUF_MAX_SYMBS];
        let mut weight_out = OStream::new(&mut weight_buf);
        let decoded = fse_decode_hufweights(&mut weight_out, &mut fse_stream)?;
        num_symbs = decoded;
        weights[..decoded].copy_from_slice(&weight_buf[..decoded]);
    }

    huf_init_dtable_using_weights(&weights, num_symbs)
}

fn fse_decode_hufweights(
    weights: &mut OStream,
    input: &mut IStream,
) -> Result<usize> {
    const MAX_ACCURACY_LOG: u8 = 7;

    let dtable = fse_decode_header(input, MAX_ACCURACY_LOG)?;

    let num_symbs = fse_decompress_interleaved2(&dtable, weights, input)?;

    Ok(num_symbs)
}

// ---------------------------------------------------------------------------
// Sequence decoding
// ---------------------------------------------------------------------------

fn decode_sequences(
    ctx: &mut FrameContext,
    input: &mut IStream,
) -> Result<Vec<SequenceCommand>> {
    let header_byte = input.read_bits(8)? as u8;
    let num_sequences: usize;

    if header_byte < 128 {
        num_sequences = header_byte as usize;
    } else if header_byte < 255 {
        num_sequences = ((header_byte as usize - 128) << 8) + input.read_bits(8)? as usize;
    } else {
        num_sequences = input.read_bits(16)? as usize + 0x7F00;
    }

    if num_sequences == 0 {
        return Ok(Vec::new());
    }

    decompress_sequences(ctx, input, num_sequences)
}

fn decompress_sequences(
    ctx: &mut FrameContext,
    input: &mut IStream,
    num_sequences: usize,
) -> Result<Vec<SequenceCommand>> {
    let compression_modes = input.read_bits(8)? as u8;
    if (compression_modes & 3) != 0 {
        return Err(DecompressError::Corruption);
    }

    let ll_mode = SeqMode::from_u8((compression_modes >> 6) & 3)?;
    let of_mode = SeqMode::from_u8((compression_modes >> 4) & 3)?;
    let ml_mode = SeqMode::from_u8((compression_modes >> 2) & 3)?;

    decode_seq_table(&mut ctx.ll_dtable, input, SeqPart::LiteralLength, ll_mode)?;
    decode_seq_table(&mut ctx.of_dtable, input, SeqPart::Offset, of_mode)?;
    decode_seq_table(&mut ctx.ml_dtable, input, SeqPart::MatchLength, ml_mode)?;

    // Read the remaining bytes of the sequences bitstream
    let len = input.remaining_bytes();
    let src = input.get_read_slice(len)?;

    if src.is_empty() {
        return Err(DecompressError::InputTooSmall);
    }

    let padding = 8 - highest_set_bit(src[len - 1] as u64);
    let mut bit_offset = (len as i64) * 8 - padding as i64;

    // Initialize FSE states
    let mut ll_state: u16 = stream_read_bits(src, ctx.ll_dtable.accuracy_log as u32, &mut bit_offset) as u16;
    let mut of_state: u16 = stream_read_bits(src, ctx.of_dtable.accuracy_log as u32, &mut bit_offset) as u16;
    let mut ml_state: u16 = stream_read_bits(src, ctx.ml_dtable.accuracy_log as u32, &mut bit_offset) as u16;

    let mut sequences = Vec::with_capacity(num_sequences);

    for i in 0..num_sequences {
        let last = i == num_sequences - 1;

        let of_code = ctx.of_dtable.symbols[of_state as usize];
        let ll_code = ctx.ll_dtable.symbols[ll_state as usize];
        let ml_code = ctx.ml_dtable.symbols[ml_state as usize];

        if ll_code > SEQ_MAX_CODES[SeqPart::LiteralLength as usize]
            || ml_code > SEQ_MAX_CODES[SeqPart::MatchLength as usize]
        {
            return Err(DecompressError::Corruption);
        }

        let offset = ((1u32) << of_code) + stream_read_bits(src, of_code as u32, &mut bit_offset) as u32;
        let match_length = SEQ_MATCH_LENGTH_BASELINES[ml_code as usize]
            + stream_read_bits(src, SEQ_MATCH_LENGTH_EXTRA_BITS[ml_code as usize] as u32, &mut bit_offset) as u32;
        let literal_length = SEQ_LITERAL_LENGTH_BASELINES[ll_code as usize]
            + stream_read_bits(src, SEQ_LITERAL_LENGTH_EXTRA_BITS[ll_code as usize] as u32, &mut bit_offset) as u32;

        sequences.push(SequenceCommand {
            literal_length,
            match_length,
            offset,
        });

        if !last {
            // Update states
            let ll_bits = ctx.ll_dtable.num_bits[ll_state as usize];
            let ll_rest = stream_read_bits(src, ll_bits as u32, &mut bit_offset) as u16;
            ll_state = ctx.ll_dtable.new_state_base[ll_state as usize] + ll_rest;

            let ml_bits = ctx.ml_dtable.num_bits[ml_state as usize];
            let ml_rest = stream_read_bits(src, ml_bits as u32, &mut bit_offset) as u16;
            ml_state = ctx.ml_dtable.new_state_base[ml_state as usize] + ml_rest;

            let of_bits = ctx.of_dtable.num_bits[of_state as usize];
            let of_rest = stream_read_bits(src, of_bits as u32, &mut bit_offset) as u16;
            of_state = ctx.of_dtable.new_state_base[of_state as usize] + of_rest;
        }
    }

    if bit_offset != 0 {
        return Err(DecompressError::Corruption);
    }

    Ok(sequences)
}

fn decode_seq_table(
    table: &mut FseDtable,
    input: &mut IStream,
    part: SeqPart,
    mode: SeqMode,
) -> Result<()> {
    let default_distributions: [&[i16]; 3] = [
        &SEQ_LITERAL_LENGTH_DEFAULT_DIST,
        &SEQ_OFFSET_DEFAULT_DIST,
        &SEQ_MATCH_LENGTH_DEFAULT_DIST,
    ];
    let default_accuracies: [u8; 3] = [6, 5, 6];
    let max_accuracies: [u8; 3] = [9, 8, 9];

    let idx = part as usize;

    if mode != SeqMode::Repeat {
        table.free();
    }

    match mode {
        SeqMode::Predefined => {
            let dist = default_distributions[idx];
            let accuracy_log = default_accuracies[idx];
            *table = fse_init_dtable(dist, accuracy_log)?;
        }
        SeqMode::Rle => {
            let data = input.get_read_slice(1)?;
            *table = fse_init_dtable_rle(data[0]);
        }
        SeqMode::Fse => {
            *table = fse_decode_header(input, max_accuracies[idx])?;
        }
        SeqMode::Repeat => {
            if table.is_empty() {
                return Err(DecompressError::Corruption);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sequence execution
// ---------------------------------------------------------------------------

fn execute_sequences(
    ctx: &mut FrameContext,
    out: &mut OStream,
    literals: &[u8],
    sequences: &[SequenceCommand],
) -> Result<()> {
    let mut lit_pos: usize = 0;
    let mut total_output = ctx.current_total_output;

    for seq in sequences {
        // Copy literals
        let lit_len = seq.literal_length as usize;
        if lit_pos + lit_len > literals.len() {
            return Err(DecompressError::Corruption);
        }
        {
            let dst = out.get_write_slice(lit_len)?;
            dst.copy_from_slice(&literals[lit_pos..lit_pos + lit_len]);
        }
        lit_pos += lit_len;
        total_output += lit_len;

        // Compute offset
        let offset = compute_offset(seq, &mut ctx.previous_offsets)?;

        // Execute match copy
        let match_length = seq.match_length as usize;
        execute_match_copy(ctx, offset, match_length, total_output, out)?;
        total_output += match_length;
    }

    // Copy leftover literals
    let remaining_lits = literals.len() - lit_pos;
    if remaining_lits > 0 {
        let dst = out.get_write_slice(remaining_lits)?;
        dst.copy_from_slice(&literals[lit_pos..]);
        total_output += remaining_lits;
    }

    ctx.current_total_output = total_output;
    Ok(())
}

fn compute_offset(
    seq: &SequenceCommand,
    offset_hist: &mut [u64; 3],
) -> Result<usize> {
    let offset: usize;

    if seq.offset <= 3 {
        let mut idx = seq.offset - 1;
        if seq.literal_length == 0 {
            idx += 1;
        }

        if idx == 0 {
            offset = offset_hist[0] as usize;
        } else {
            offset = if idx < 3 {
                offset_hist[idx as usize] as usize
            } else {
                (offset_hist[0] as usize).wrapping_sub(1)
            };

            if idx > 1 {
                offset_hist[2] = offset_hist[1];
            }
            offset_hist[1] = offset_hist[0];
            offset_hist[0] = offset as u64;
        }
    } else {
        offset = (seq.offset - 3) as usize;
        offset_hist[2] = offset_hist[1];
        offset_hist[1] = offset_hist[0];
        offset_hist[0] = offset as u64;
    }

    Ok(offset)
}

fn execute_match_copy(
    ctx: &FrameContext,
    offset: usize,
    mut match_length: usize,
    total_output: usize,
    out: &mut OStream,
) -> Result<()> {
    let _write_start = out.pos;

    // Ensure we have room
    if match_length > out.remaining() {
        return Err(DecompressError::OutputTooSmall);
    }

    if total_output <= ctx.header.window_size as usize {
        if offset > total_output + ctx.dict_content.len() {
            return Err(DecompressError::Corruption);
        }

        if offset > total_output {
            let dict_copy = std::cmp::min(offset - total_output, match_length);
            let dict_offset = ctx.dict_content.len() - (offset - total_output);

            let src_slice = &ctx.dict_content[dict_offset..dict_offset + dict_copy];
            let dst = out.get_write_slice(dict_copy)?;
            dst.copy_from_slice(src_slice);
            match_length -= dict_copy;
        }
    } else if offset > ctx.header.window_size as usize {
        return Err(DecompressError::Corruption);
    }

    // Byte-by-byte copy because match_length may exceed offset
    let cur_pos = out.pos;
    for j in 0..match_length {
        let src_pos = cur_pos + j - offset;
        let val = out.buf_mut()[src_pos];
        out.buf_mut()[cur_pos + j] = val;
    }
    out.pos += match_length;

    Ok(())
}

// ---------------------------------------------------------------------------
// Huffman decompression primitives
// ---------------------------------------------------------------------------

fn huf_decode_symbol(
    dtable: &HufDtable,
    state: &mut u16,
    src: &[u8],
    offset: &mut i64,
) -> u8 {
    let symb = dtable.symbols[*state as usize];
    let bits = dtable.num_bits[*state as usize];
    let rest = stream_read_bits(src, bits as u32, offset) as u16;
    *state = ((*state << bits) + rest) & (((1u16) << dtable.max_bits) - 1);
    symb
}

fn huf_init_state(
    dtable: &HufDtable,
    state: &mut u16,
    src: &[u8],
    offset: &mut i64,
) {
    *state = stream_read_bits(src, dtable.max_bits as u32, offset) as u16;
}

fn huf_decompress_1stream(
    dtable: &HufDtable,
    out: &mut OStream,
    input: &mut IStream,
) -> Result<usize> {
    let len = input.remaining_bytes();
    if len == 0 {
        return Err(DecompressError::InputTooSmall);
    }
    let src = input.get_read_slice(len)?;

    let padding = 8 - highest_set_bit(src[len - 1] as u64);
    let mut bit_offset = (len as i64) * 8 - padding as i64;

    let mut state: u16 = 0;
    huf_init_state(dtable, &mut state, src, &mut bit_offset);

    let mut symbols_written = 0usize;
    while bit_offset > -(dtable.max_bits as i64) {
        out.write_byte(huf_decode_symbol(dtable, &mut state, src, &mut bit_offset))?;
        symbols_written += 1;
    }

    if bit_offset != -(dtable.max_bits as i64) {
        return Err(DecompressError::Corruption);
    }

    Ok(symbols_written)
}

fn huf_decompress_4stream(
    dtable: &HufDtable,
    out: &mut OStream,
    input: &mut IStream,
) -> Result<usize> {
    let csize1 = input.read_bits(16)? as usize;
    let csize2 = input.read_bits(16)? as usize;
    let csize3 = input.read_bits(16)? as usize;

    let mut in1 = input.sub_stream(csize1)?;
    let mut in2 = input.sub_stream(csize2)?;
    let mut in3 = input.sub_stream(csize3)?;
    let remaining = input.remaining_bytes();
    let mut in4 = input.sub_stream(remaining)?;

    let mut total_output = 0usize;
    total_output += huf_decompress_1stream(dtable, out, &mut in1)?;
    total_output += huf_decompress_1stream(dtable, out, &mut in2)?;
    total_output += huf_decompress_1stream(dtable, out, &mut in3)?;
    total_output += huf_decompress_1stream(dtable, out, &mut in4)?;

    Ok(total_output)
}

// ---------------------------------------------------------------------------
// Huffman table initialization
// ---------------------------------------------------------------------------

fn huf_init_dtable(bits: &[u8], num_symbs: usize) -> Result<HufDtable> {
    if num_symbs > HUF_MAX_SYMBS {
        return Err(DecompressError::TooManySymbols);
    }

    let mut max_bits: u8 = 0;
    let mut rank_count = [0u16; HUF_MAX_BITS as usize + 1];

    for i in 0..num_symbs {
        if bits[i] > HUF_MAX_BITS {
            return Err(DecompressError::HuffmanDepthTooLarge);
        }
        max_bits = max_bits.max(bits[i]);
        rank_count[bits[i] as usize] += 1;
    }

    let table_size = 1usize << max_bits;
    let mut symbols = vec![0u8; table_size];
    let mut num_bits_table = vec![0u8; table_size];

    let mut rank_idx = vec![0u32; HUF_MAX_BITS as usize + 1];
    rank_idx[max_bits as usize] = 0;
    for i in (1..=max_bits as usize).rev() {
        rank_idx[i - 1] = rank_idx[i] + rank_count[i] as u32 * (1u32 << (max_bits as u32 - i as u32));
        let start = rank_idx[i] as usize;
        let end = rank_idx[i - 1] as usize;
        num_bits_table[start..end].iter_mut().for_each(|b| *b = i as u8);
    }

    if rank_idx[0] as usize != table_size {
        return Err(DecompressError::Corruption);
    }

    for i in 0..num_symbs {
        if bits[i] != 0 {
            let code = rank_idx[bits[i] as usize] as usize;
            let len = 1usize << (max_bits - bits[i]);
            symbols[code..code + len].iter_mut().for_each(|b| *b = i as u8);
            rank_idx[bits[i] as usize] += len as u32;
        }
    }

    Ok(HufDtable {
        symbols,
        num_bits: num_bits_table,
        max_bits,
    })
}

fn huf_init_dtable_using_weights(weights: &[u8], num_symbs: usize) -> Result<HufDtable> {
    if num_symbs + 1 > HUF_MAX_SYMBS {
        return Err(DecompressError::TooManySymbols);
    }

    let mut bits = [0u8; HUF_MAX_SYMBS];

    let mut weight_sum: u64 = 0;
    for i in 0..num_symbs {
        if weights[i] > HUF_MAX_BITS {
            return Err(DecompressError::Corruption);
        }
        weight_sum += if weights[i] > 0 {
            1u64 << (weights[i] - 1)
        } else {
            0
        };
    }

    let max_bits = highest_set_bit(weight_sum) + 1;
    let left_over = (1u64 << max_bits) - weight_sum;
    if left_over & (left_over - 1) != 0 {
        return Err(DecompressError::Corruption);
    }

    let last_weight = highest_set_bit(left_over) + 1;

    for i in 0..num_symbs {
        bits[i] = if weights[i] > 0 {
            (max_bits + 1 - weights[i] as i32) as u8
        } else {
            0
        };
    }
    bits[num_symbs] = (max_bits + 1 - last_weight) as u8;

    huf_init_dtable(&bits, num_symbs + 1)
}

// ---------------------------------------------------------------------------
// FSE primitives
// ---------------------------------------------------------------------------

fn fse_decompress_interleaved2(
    dtable: &FseDtable,
    out: &mut OStream,
    input: &mut IStream,
) -> Result<usize> {
    let len = input.remaining_bytes();
    if len == 0 {
        return Err(DecompressError::InputTooSmall);
    }
    let src = input.get_read_slice(len)?;

    let padding = 8 - highest_set_bit(src[len - 1] as u64);
    let mut offset = (len as i64) * 8 - padding as i64;

    let mut state1: u16 = stream_read_bits(src, dtable.accuracy_log as u32, &mut offset) as u16;
    let mut state2: u16 = stream_read_bits(src, dtable.accuracy_log as u32, &mut offset) as u16;

    let mut symbols_written = 0usize;
    loop {
        // Decode from state1
        let symb1 = dtable.symbols[state1 as usize];
        let bits1 = dtable.num_bits[state1 as usize];
        let rest1 = stream_read_bits(src, bits1 as u32, &mut offset) as u16;
        state1 = dtable.new_state_base[state1 as usize] + rest1;

        out.write_byte(symb1)?;
        symbols_written += 1;

        if offset < 0 {
            out.write_byte(dtable.symbols[state2 as usize])?;
            symbols_written += 1;
            break;
        }

        // Decode from state2
        let symb2 = dtable.symbols[state2 as usize];
        let bits2 = dtable.num_bits[state2 as usize];
        let rest2 = stream_read_bits(src, bits2 as u32, &mut offset) as u16;
        state2 = dtable.new_state_base[state2 as usize] + rest2;

        out.write_byte(symb2)?;
        symbols_written += 1;

        if offset < 0 {
            out.write_byte(dtable.symbols[state1 as usize])?;
            symbols_written += 1;
            break;
        }
    }

    Ok(symbols_written)
}

fn fse_init_dtable(norm_freqs: &[i16], accuracy_log: u8) -> Result<FseDtable> {
    if accuracy_log > FSE_MAX_ACCURACY_LOG {
        return Err(DecompressError::FseAccuracyTooLarge);
    }
    let num_symbs = norm_freqs.len();
    if num_symbs > FSE_MAX_SYMBS {
        return Err(DecompressError::TooManySymbols);
    }

    let size = 1usize << accuracy_log;
    let mut symbols = vec![0u8; size];
    let mut num_bits = vec![0u8; size];
    let mut new_state_base = vec![0u16; size];

    let mut state_desc = vec![0u16; FSE_MAX_SYMBS];

    // Place low-probability symbols at the top
    let mut high_threshold = size;
    for s in 0..num_symbs {
        if norm_freqs[s] == -1 {
            high_threshold -= 1;
            symbols[high_threshold] = s as u8;
            state_desc[s] = 1;
        }
    }

    // Spread remaining symbols
    let step = (size >> 1) + (size >> 3) + 3;
    let mask = size - 1;
    let mut pos: usize = 0;
    for s in 0..num_symbs {
        if norm_freqs[s] <= 0 {
            continue;
        }
        state_desc[s] = norm_freqs[s] as u16;

        for _ in 0..norm_freqs[s] {
            symbols[pos] = s as u8;
            loop {
                pos = (pos + step) & mask;
                if pos < high_threshold {
                    break;
                }
            }
        }
    }
    if pos != 0 {
        return Err(DecompressError::Corruption);
    }

    // Fill baseline and num_bits
    for i in 0..size {
        let symbol = symbols[i] as usize;
        let next_state_desc = state_desc[symbol];
        state_desc[symbol] += 1;
        num_bits[i] = (accuracy_log as i32 - highest_set_bit(next_state_desc as u64)) as u8;
        new_state_base[i] = ((next_state_desc as u32) << num_bits[i]) as u16 - size as u16;
    }

    Ok(FseDtable {
        symbols,
        num_bits,
        new_state_base,
        accuracy_log,
    })
}

fn fse_decode_header(input: &mut IStream, max_accuracy_log: u8) -> Result<FseDtable> {
    if max_accuracy_log > FSE_MAX_ACCURACY_LOG {
        return Err(DecompressError::FseAccuracyTooLarge);
    }

    let accuracy_log = 5 + input.read_bits(4)? as u8;
    if accuracy_log > max_accuracy_log {
        return Err(DecompressError::FseAccuracyTooLarge);
    }

    let mut remaining: i32 = 1 << accuracy_log;
    let mut frequencies = [0i16; FSE_MAX_SYMBS];
    let mut symb = 0usize;

    while remaining > 0 && symb < FSE_MAX_SYMBS {
        let bits = highest_set_bit((remaining + 1) as u64) + 1;
        let val = input.read_bits(bits as u32)? as u16;

        let lower_mask: u16 = ((1u16) << (bits as u16 - 1)) - 1;
        let threshold: u16 = ((1u16) << bits as u16) - 1 - (remaining as u16 + 1);

        let final_val;
        if (val & lower_mask) < threshold {
            input.rewind_bits(1)?;
            final_val = val & lower_mask;
        } else if val > lower_mask {
            final_val = val - threshold;
        } else {
            final_val = val;
        }

        let proba = final_val as i16 - 1;
        remaining -= if proba < 0 { -proba as i32 } else { proba as i32 };

        frequencies[symb] = proba;
        symb += 1;

        if proba == 0 {
            let mut repeat = input.read_bits(2)? as usize;
            loop {
                for _ in 0..repeat {
                    if symb >= FSE_MAX_SYMBS {
                        break;
                    }
                    frequencies[symb] = 0;
                    symb += 1;
                }
                if repeat == 3 {
                    repeat = input.read_bits(2)? as usize;
                } else {
                    break;
                }
            }
        }
    }

    input.align()?;

    if remaining != 0 || symb >= FSE_MAX_SYMBS {
        return Err(DecompressError::Corruption);
    }

    fse_init_dtable(&frequencies[..symb], accuracy_log)
}

fn fse_init_dtable_rle(symb: u8) -> FseDtable {
    FseDtable {
        symbols: vec![symb],
        num_bits: vec![0],
        new_state_base: vec![0],
        accuracy_log: 0,
    }
}

// ---------------------------------------------------------------------------
// Dictionary parsing
// ---------------------------------------------------------------------------

/// Parse a provided dictionary blob for use in decompression.
pub fn parse_dictionary(src: &[u8]) -> Result<Dictionary> {
    if src.len() < 8 {
        return Err(DecompressError::DictionaryTooSmall);
    }

    let mut input = IStream::new(src);
    let magic_number = input.read_bits(32)? as u32;

    if magic_number != 0xEC30A437 {
        // Raw content dict
        input.rewind_bits(32)?;
        let content = input.get_read_slice(input.remaining_bytes())?.to_vec();
        return Ok(Dictionary {
            content,
            ..Default::default()
        });
    }

    let dictionary_id = input.read_bits(32)? as u32;

    let literals_dtable = decode_huf_table(&mut input)?;

    let mut of_dtable = FseDtable::default();
    decode_seq_table(&mut of_dtable, &mut input, SeqPart::Offset, SeqMode::Fse)?;

    let mut ml_dtable = FseDtable::default();
    decode_seq_table(&mut ml_dtable, &mut input, SeqPart::MatchLength, SeqMode::Fse)?;

    let mut ll_dtable = FseDtable::default();
    decode_seq_table(&mut ll_dtable, &mut input, SeqPart::LiteralLength, SeqMode::Fse)?;

    let prev0 = input.read_bits(32)? as u64;
    let prev1 = input.read_bits(32)? as u64;
    let prev2 = input.read_bits(32)? as u64;

    for &off in &[prev0, prev1, prev2] {
        if off > src.len() as u64 {
            return Err(DecompressError::DictionaryCorrupted);
        }
    }

    let content = input.get_read_slice(input.remaining_bytes())?.to_vec();

    Ok(Dictionary {
        literals_dtable,
        ll_dtable,
        ml_dtable,
        of_dtable,
        content,
        previous_offsets: [prev0, prev1, prev2],
        dictionary_id,
    })
}

/// Apply dictionary to frame context.
fn frame_context_apply_dict(
    ctx: &mut FrameContext,
    dict: &Dictionary,
) -> Result<()> {
    if dict.content.is_empty() {
        return Ok(());
    }

    if ctx.header.dictionary_id != 0 && ctx.header.dictionary_id != dict.dictionary_id {
        return Err(DecompressError::WrongDictionary);
    }

    ctx.dict_content = dict.content.clone();

    if dict.dictionary_id != 0 {
        ctx.literals_dtable = dict.literals_dtable.clone();
        ctx.ll_dtable = dict.ll_dtable.clone();
        ctx.of_dtable = dict.of_dtable.clone();
        ctx.ml_dtable = dict.ml_dtable.clone();
        ctx.previous_offsets = dict.previous_offsets;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_highest_set_bit() {
        assert_eq!(highest_set_bit(0), -1);
        assert_eq!(highest_set_bit(1), 0);
        assert_eq!(highest_set_bit(2), 1);
        assert_eq!(highest_set_bit(255), 7);
        assert_eq!(highest_set_bit(256), 8);
    }

    #[test]
    fn test_read_bits_le_basic() {
        let data = [0b10110100u8, 0b11001010u8];
        // Read 4 bits from bit 0: should be 0b0100 = 4
        let val = read_bits_le(&data, 4, 0, 0);
        assert_eq!(val, 0b0100);
    }

    #[test]
    fn test_istream_read_bits() {
        let data = [0x28, 0xB5, 0x2F, 0xFD];
        let mut s = IStream::new(&data);
        let magic = s.read_bits(32).unwrap();
        assert_eq!(magic as u32, ZSTD_MAGIC_NUMBER);
    }

    #[test]
    fn test_parse_frame_header_single_segment() {
        // Minimal valid frame header: descriptor byte with single_segment + fcs=1 byte
        // descriptor: FCS_flag=0, single_segment=1, reserved=0, checksum=0, dict_id=0
        // = 0b00_1_0_0_0_00 = 0x20
        // FCS: 1 byte value, say 42
        let data = [0x20, 42];
        let mut s = IStream::new(&data);
        let header = parse_frame_header(&mut s).unwrap();
        assert!(header.single_segment_flag);
        assert_eq!(header.frame_content_size, 42);
        assert_eq!(header.window_size, 42);
    }
}
