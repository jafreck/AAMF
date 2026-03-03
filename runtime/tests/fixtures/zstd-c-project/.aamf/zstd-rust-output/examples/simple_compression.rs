// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under both the BSD-style license (found in the
// LICENSE file in the root directory of this source tree) and the GPLv2 (found
// in the COPYING file in the root directory of this source tree).
// You may select, at your option, one of the above-listed licenses.

//! Simple one-shot compression example using the zstd API.
//!
//! Usage: `simple_compression FILE`
//!
//! Compresses FILE to FILE.zst using `compress` at level 1.

#[path = "common.rs"]
#[allow(dead_code)]
mod common;

use common::{malloc_and_load_file_or_die, malloc_or_die, save_file_or_die};
use std::env;
use zstd_rust_output::{compress, compress_bound};

/// Compress a file and write the result to `oname`.
///
/// Mirrors the C `compress_orDie` function: loads the input file, allocates
/// a destination buffer sized via `compress_bound`, compresses at level 1,
/// and saves the compressed output.
fn compress_or_die(fname: &str, oname: &str) {
    let f_buff = malloc_and_load_file_or_die(fname);
    let f_size = f_buff.len();
    let c_buff_size = compress_bound(f_size);
    let mut c_buff = malloc_or_die(c_buff_size);

    // Compress at level 1.
    // If you are doing many compressions, you may want to reuse the context.
    // See the multiple_simple_compression example.
    let c_size = check_zstd!(compress(&mut c_buff[..c_buff_size], &f_buff, 1));

    save_file_or_die(oname, &c_buff[..c_size]);

    println!("{:>25} : {:6} -> {:7} - {} ", fname, f_size, c_size, oname);
}

/// Create the output filename by appending ".zst".
fn create_out_filename(filename: &str) -> String {
    format!("{}.zst", filename)
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

    let in_filename = &args[1];
    let out_filename = create_out_filename(in_filename);
    compress_or_die(in_filename, &out_filename);
}
