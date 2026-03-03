// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under both the BSD-style license (found in the
// LICENSE file in the root directory of this source tree) and the GPLv2 (found
// in the COPYING file in the root directory of this source tree).
// You may select, at your option, one of the above-listed licenses.

//! Simple one-shot decompression example using the zstd API.
//!
//! Usage: `simple_decompression FILE`
//!
//! Decompresses FILE in memory and reports the compressed/decompressed sizes.

#[path = "common.rs"]
#[allow(dead_code)]
mod common;

use common::{malloc_and_load_file_or_die, malloc_or_die};
use std::env;
use zstd_rust_output::{decompress, get_frame_content_size, CONTENTSIZE_ERROR, CONTENTSIZE_UNKNOWN};

/// Decompress a file in memory.
///
/// Mirrors the C `decompress` function: loads the compressed file, reads
/// the content size from the frame header, allocates a buffer, and
/// decompresses into it.
fn decompress_file(fname: &str) {
    let c_buff = malloc_and_load_file_or_die(fname);
    let c_size = c_buff.len();

    // Read the content size from the frame header. For simplicity we require
    // that it is always present. By default, zstd will write the content size
    // in the header when it is known. If you can't guarantee that the frame
    // content size is always written into the header, either use streaming
    // decompression, or decompress_bound().
    let r_size = get_frame_content_size(&c_buff);
    check!(r_size != CONTENTSIZE_ERROR, "{}: not compressed by zstd!", fname);
    check!(r_size != CONTENTSIZE_UNKNOWN, "{}: original size unknown!", fname);

    let mut r_buff = malloc_or_die(r_size as usize);

    // Decompress.
    // If you are doing many decompressions, you may want to reuse the context
    // and use decompress_dctx(). If you want to set advanced parameters,
    // use dctx_set_parameter().
    let d_size = check_zstd!(decompress(&mut r_buff[..r_size as usize], &c_buff));
    // When zstd knows the content size, it will error if it doesn't match.
    check!(
        d_size == r_size as usize,
        "Impossible because zstd will check this condition!"
    );

    println!("{:>25} : {:6} -> {:7} ", fname, c_size, r_size);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let exe_name = &args[0];

    if args.len() != 2 {
        println!("wrong arguments");
        println!("usage:");
        println!("{} FILE", exe_name);
        std::process::exit(1);
    }

    decompress_file(&args[1]);

    println!("{} correctly decoded (in memory). ", args[1]);
}
