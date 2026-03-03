// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under both the BSD-style license (found in the
// LICENSE file in the root directory of this source tree) and the GPLv2 (found
// in the COPYING file in the root directory of this source tree).
// You may select, at your option, one of the above-listed licenses.

//! Common utility functions used in examples.
//!
//! This module provides file I/O helpers that mirror the "or die" pattern
//! from the C original: on failure they print to stderr and exit with a
//! specific error code.

use std::fs;
use std::io::{self, Read, Write};
use std::process;

/// Error codes returned by utility functions, matching the C enum values.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommonErrorCode {
    Fsize = 1,
    Fopen = 2,
    Fclose = 3,
    Fread = 4,
    Fwrite = 5,
    LoadFile = 6,
    SaveFile = 7,
    Malloc = 8,
    LargeFile = 9,
}

/// Check that a condition holds. If it doesn't, print a message to stderr and exit.
///
/// Mirrors the C `CHECK` macro. Uses `file!()` and `line!()` to report location.
#[macro_export]
macro_rules! check {
    ($cond:expr, $($arg:tt)*) => {
        if !($cond) {
            eprintln!(
                "{}:{} CHECK({}) failed: {}",
                file!(),
                line!(),
                stringify!($cond),
                format!($($arg)*)
            );
            std::process::exit(1);
        }
    };
    ($cond:expr) => {
        if !($cond) {
            eprintln!(
                "{}:{} CHECK({}) failed",
                file!(),
                line!(),
                stringify!($cond),
            );
            std::process::exit(1);
        }
    };
}

/// Get the size of a given file path.
///
/// On failure, prints an error to stderr and exits with `CommonErrorCode::Fsize`.
/// Also exits with `CommonErrorCode::LargeFile` if the file size cannot fit in `usize`.
pub fn fsize_or_die(filename: &str) -> usize {
    let metadata = match fs::metadata(filename) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("{}: {}", filename, e);
            process::exit(CommonErrorCode::Fsize as i32);
        }
    };

    let file_size = metadata.len();

    // Check that the file size fits in usize (relevant on 32-bit platforms).
    let size = file_size as usize;
    if file_size != size as u64 {
        eprintln!("{} : filesize too large", filename);
        process::exit(CommonErrorCode::LargeFile as i32);
    }

    size
}

/// Open a file for reading or writing.
///
/// The `instruction` parameter mirrors the C `fopen` mode string:
/// - `"rb"` opens for reading
/// - `"wb"` opens for writing (creates/truncates)
///
/// On failure, prints an error to stderr and exits with `CommonErrorCode::Fopen`.
pub fn fopen_or_die(filename: &str, instruction: &str) -> fs::File {
    let result = match instruction {
        "rb" | "r" => fs::File::open(filename),
        "wb" | "w" => fs::File::create(filename),
        other => {
            // Best-effort: treat anything starting with 'r' as read, 'w' as write
            if other.starts_with('r') {
                fs::File::open(filename)
            } else if other.starts_with('w') {
                fs::File::create(filename)
            } else {
                eprintln!("{}: unsupported mode '{}'", filename, other);
                process::exit(CommonErrorCode::Fopen as i32);
            }
        }
    };

    match result {
        Ok(f) => f,
        Err(e) => {
            eprintln!("{}: {}", filename, e);
            process::exit(CommonErrorCode::Fopen as i32);
        }
    }
}

/// Close a file.
///
/// In Rust, files are closed when dropped, and errors during drop are ignored.
/// This function explicitly syncs and drops the file, exiting on sync failure
/// to preserve the "or die" semantics of the C original.
pub fn fclose_or_die(file: fs::File) {
    if let Err(e) = file.sync_all() {
        eprintln!("fclose: {}", e);
        process::exit(CommonErrorCode::Fclose as i32);
    }
    // File is dropped here; any further close error is not observable in Rust.
}

/// Read up to `size_to_read` bytes from a file into a buffer.
///
/// Returns the number of bytes actually read. On error (other than EOF),
/// prints to stderr and exits with `CommonErrorCode::Fread`.
pub fn fread_or_die(buffer: &mut [u8], size_to_read: usize, file: &mut fs::File) -> usize {
    let buf = if size_to_read < buffer.len() {
        &mut buffer[..size_to_read]
    } else {
        buffer
    };

    match file.read(buf) {
        Ok(n) => n,
        Err(ref e) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
        Err(e) => {
            eprintln!("fread: {}", e);
            process::exit(CommonErrorCode::Fread as i32);
        }
    }
}

/// Write `size_to_write` bytes from a buffer to a file.
///
/// Returns the number of bytes written. On error, prints to stderr and exits
/// with `CommonErrorCode::Fwrite`.
pub fn fwrite_or_die(buffer: &[u8], size_to_write: usize, file: &mut fs::File) -> usize {
    let data = &buffer[..size_to_write];
    match file.write_all(data) {
        Ok(()) => size_to_write,
        Err(e) => {
            eprintln!("fwrite: {}", e);
            process::exit(CommonErrorCode::Fwrite as i32);
        }
    }
}

/// Allocate a buffer of the given size.
///
/// In Rust, allocation failure normally causes a panic/abort. This function
/// mirrors the C behavior by returning a `Vec<u8>` of the requested size,
/// initialized to zero.
///
/// Note: Rust's allocator will abort on OOM by default, so the explicit
/// error path from the C original (print + exit) is not directly reachable.
/// We keep the function for API parity.
pub fn malloc_or_die(size: usize) -> Vec<u8> {
    vec![0u8; size]
}

/// Load a file into a provided buffer.
///
/// Returns the number of bytes read (i.e. the file size).
/// On failure, prints an error to stderr and exits.
pub fn load_file_or_die(file_name: &str, buffer: &mut [u8]) -> usize {
    let file_size = fsize_or_die(file_name);
    check!(
        file_size <= buffer.len(),
        "File too large!"
    );

    let mut in_file = fopen_or_die(file_name, "rb");
    let read_size = match in_file.read(&mut buffer[..file_size]) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("fread: {} : {}", file_name, e);
            process::exit(CommonErrorCode::Fread as i32);
        }
    };
    if read_size != file_size {
        eprintln!("fread: {} : unexpected short read", file_name);
        process::exit(CommonErrorCode::Fread as i32);
    }
    // File closed on drop (read-only, can't fail meaningfully)
    file_size
}

/// Allocate a buffer and load the entire file into it.
///
/// Returns a `Vec<u8>` containing the file contents. The length of the
/// returned vector equals the file size.
pub fn malloc_and_load_file_or_die(file_name: &str) -> Vec<u8> {
    let file_size = fsize_or_die(file_name);
    let mut buffer = malloc_or_die(file_size);
    load_file_or_die(file_name, &mut buffer);
    buffer
}

/// Save a buffer to a file.
///
/// On failure, prints an error to stderr and exits.
pub fn save_file_or_die(file_name: &str, buff: &[u8]) {
    let mut o_file = fopen_or_die(file_name, "wb");
    match o_file.write_all(buff) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("fwrite: {} : {}", file_name, e);
            process::exit(CommonErrorCode::Fwrite as i32);
        }
    }
    if let Err(e) = o_file.sync_all() {
        eprintln!("{}: {}", file_name, e);
        process::exit(CommonErrorCode::Fclose as i32);
    }
    // File is dropped/closed here
}
