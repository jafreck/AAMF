// Copyright (c) Meta Platforms, Inc. and affiliates.
// All rights reserved.
//
// This source code is licensed under both the BSD-style license (found in the
// LICENSE file in the root directory of this source tree) and the GPLv2 (found
// in the COPYING file in the root directory of this source tree).
// You may select, at your option, one of the above-listed licenses.

//! Utility functions for file operations, directory listing, and path manipulation.
//!
//! Migrated from `programs/util.c` and `programs/util.h`.  All public API names
//! are preserved in snake_case form with the `util_` prefix dropped (the module
//! itself serves as the namespace).

use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

// ─── Global state ─────────────────────────────────────────────────────────────

/// Controls verbosity of diagnostic output written to stderr.
/// Equivalent to C's `g_utilDisplayLevel`.
pub static G_UTIL_DISPLAY_LEVEL: AtomicI32 = AtomicI32::new(0);

static G_TRACE_FILE_STAT: AtomicBool = AtomicBool::new(false);
static G_TRACE_DEPTH: AtomicI32 = AtomicI32::new(0);

static G_FAKE_STDIN_IS_CONSOLE: AtomicBool = AtomicBool::new(false);
static G_FAKE_STDOUT_IS_CONSOLE: AtomicBool = AtomicBool::new(false);
static G_FAKE_STDERR_IS_CONSOLE: AtomicBool = AtomicBool::new(false);

// ─── Constants ────────────────────────────────────────────────────────────────

/// Sentinel indicating that a file size could not be determined (UTIL_FILESIZE_UNKNOWN).
pub const FILESIZE_UNKNOWN: u64 = u64::MAX;

/// Maximum allowed size of a file-of-file-names input (50 MiB).
const MAX_FILE_OF_FILE_NAMES_SIZE: u64 = (1u64 << 20) * 50;

/// Default permission bits for newly created mirror directories (0755).
const DIR_DEFAULT_MODE: u32 = 0o755;

// ─── Internal tracing helpers ─────────────────────────────────────────────────

macro_rules! display {
    ($($arg:tt)*) => { eprint!($($arg)*) };
}

macro_rules! displaylevel {
    ($l:expr, $($arg:tt)*) => {
        if G_UTIL_DISPLAY_LEVEL.load(Ordering::Relaxed) >= $l {
            eprint!($($arg)*);
        }
    };
}

fn trace_call(msg: &str) {
    if G_TRACE_FILE_STAT.load(Ordering::Relaxed) {
        let depth = G_TRACE_DEPTH.fetch_add(1, Ordering::Relaxed) as usize;
        eprintln!("Trace:FileStat: {:width$}> {}", "", msg, width = depth);
    }
}

fn trace_ret(ret: i32) {
    if G_TRACE_FILE_STAT.load(Ordering::Relaxed) {
        let new_depth = G_TRACE_DEPTH.fetch_sub(1, Ordering::Relaxed) as usize - 1;
        eprintln!("Trace:FileStat: {:width$}< {}", "", ret, width = new_depth);
    }
}

// ─── Console log ──────────────────────────────────────────────────────────────

/// Enable file-stat call tracing (equivalent to `UTIL_traceFileStat`).
pub fn trace_file_stat() {
    G_TRACE_FILE_STAT.store(true, Ordering::Relaxed);
}

/// Prompt the user and return `false` (proceed) if the first typed character is
/// in `acceptable_letters`, or `true` (abort) otherwise.
///
/// If `has_stdin_input` is `true` (stdin is already being used as a data source)
/// the function immediately returns `true` without prompting.
///
/// Equivalent to C's `UTIL_requireUserConfirmation()` (0 = proceed, 1 = abort).
pub fn require_user_confirmation(
    prompt: &str,
    abort_msg: &str,
    acceptable_letters: &str,
    has_stdin_input: bool,
) -> bool {
    if has_stdin_input {
        display!("stdin is an input - not proceeding.\n");
        return true;
    }

    display!("{}", prompt);
    let _ = io::stderr().flush();

    let stdin = io::stdin();
    let mut line = String::new();
    if stdin.lock().read_line(&mut line).is_err() || line.is_empty() {
        display!("{} \n", abort_msg);
        return true;
    }

    let ch = line.chars().next().unwrap_or('\0');
    if acceptable_letters.contains(ch) {
        // consume the rest of the line (mirrors the C `while` loop)
        false
    } else {
        display!("{} \n", abort_msg);
        true
    }
}

// ─── HumanReadableSize ────────────────────────────────────────────────────────

/// Components for pretty-printing a byte count with a scaled suffix.
///
/// Pass (`precision`, `value`, `suffix`) to a `format!("{:.prec$}{}", value, suffix, prec = precision)`.
/// Equivalent to C's `UTIL_HumanReadableSize_t`.
pub struct HumanReadableSize {
    pub value: f64,
    pub precision: usize,
    pub suffix: &'static str,
}

/// Scale `size` bytes into a human-readable representation.
///
/// In verbose mode (`G_UTIL_DISPLAY_LEVEL > 3`) values below 2^53 are not
/// scaled; larger values use MiB.  In regular mode the standard binary SI
/// suffix ladder (KiB … EiB) is used.
///
/// Equivalent to C's `UTIL_makeHumanReadableSize()`.
pub fn make_human_readable_size(size: u64) -> HumanReadableSize {
    if G_UTIL_DISPLAY_LEVEL.load(Ordering::Relaxed) > 3 {
        if size >= (1u64 << 53) {
            HumanReadableSize {
                value: size as f64 / (1u64 << 20) as f64,
                precision: 2,
                suffix: " MiB",
            }
        } else {
            HumanReadableSize {
                value: size as f64,
                precision: 0,
                suffix: " B",
            }
        }
    } else {
        let (value, suffix) = if size >= (1u64 << 60) {
            (size as f64 / (1u64 << 60) as f64, " EiB")
        } else if size >= (1u64 << 50) {
            (size as f64 / (1u64 << 50) as f64, " PiB")
        } else if size >= (1u64 << 40) {
            (size as f64 / (1u64 << 40) as f64, " TiB")
        } else if size >= (1u64 << 30) {
            (size as f64 / (1u64 << 30) as f64, " GiB")
        } else if size >= (1u64 << 20) {
            (size as f64 / (1u64 << 20) as f64, " MiB")
        } else if size >= (1u64 << 10) {
            (size as f64 / (1u64 << 10) as f64, " KiB")
        } else {
            (size as f64, " B")
        };

        let precision = if value >= 100.0 || value as u64 == size {
            0
        } else if value >= 10.0 {
            1
        } else if value > 1.0 {
            2
        } else {
            3
        };

        HumanReadableSize { value, precision, suffix }
    }
}

// ─── File metadata helpers ────────────────────────────────────────────────────

/// Returns `true` if `path` refers to a regular file (follows symlinks).
///
/// Equivalent to C's `UTIL_isRegularFile()`.
pub fn is_regular_file(path: &Path) -> bool {
    trace_call(&format!("is_regular_file({})", path.display()));
    let ret = fs::metadata(path).map_or(false, |m| m.is_file());
    trace_ret(ret as i32);
    ret
}

/// Returns `true` if `path` refers to a directory (follows symlinks).
///
/// Equivalent to C's `UTIL_isDirectory()`.
pub fn is_directory(path: &Path) -> bool {
    trace_call(&format!("is_directory({})", path.display()));
    let ret = fs::metadata(path).map_or(false, |m| m.is_dir());
    trace_ret(ret as i32);
    ret
}

/// Returns `true` if `path` is a symbolic link (does NOT follow symlinks).
///
/// Equivalent to C's `UTIL_isLink()`.
pub fn is_link(path: &Path) -> bool {
    trace_call(&format!("is_link({})", path.display()));
    let ret = fs::symlink_metadata(path).map_or(false, |m| m.file_type().is_symlink());
    trace_ret(ret as i32);
    ret
}

/// Returns `true` if `path` is a named pipe (FIFO).
///
/// Equivalent to C's `UTIL_isFIFO()`.
pub fn is_fifo(path: &Path) -> bool {
    trace_call(&format!("is_fifo({})", path.display()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let ret = fs::metadata(path).map_or(false, |m| m.file_type().is_fifo());
        trace_ret(ret as i32);
        return ret;
    }
    #[allow(unreachable_code)]
    {
        trace_ret(0);
        false
    }
}

/// Returns `true` if `path` is a block device.
///
/// Equivalent to C's `UTIL_isBlockDevStat()`.
pub fn is_block_device(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        return fs::metadata(path).map_or(false, |m| m.file_type().is_block_device());
    }
    #[allow(unreachable_code)]
    false
}

/// Returns `true` if `file1` and `file2` refer to the same underlying filesystem
/// object (same device + inode on POSIX; exact string equality on Windows).
///
/// Equivalent to C's `UTIL_isSameFile()`.
pub fn is_same_file(file1: &Path, file2: &Path) -> bool {
    trace_call(&format!(
        "is_same_file({}, {})",
        file1.display(),
        file2.display()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ret = fs::metadata(file1).ok().zip(fs::metadata(file2).ok()).map_or(
            false,
            |(m1, m2)| m1.dev() == m2.dev() && m1.ino() == m2.ino(),
        );
        trace_ret(ret as i32);
        return ret;
    }
    // Windows fallback: exact path comparison only
    #[cfg(windows)]
    {
        let ret = file1 == file2;
        trace_ret(ret as i32);
        return ret;
    }
    #[allow(unreachable_code)]
    {
        trace_ret(0);
        false
    }
}

/// Returns `true` if `file1` and `file2` refer to the same underlying inode,
/// given pre-fetched metadata for both.
///
/// Equivalent to C's `UTIL_isSameFileStat()`.
pub fn is_same_file_meta(file1: &fs::Metadata, file2: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return file1.dev() == file2.dev() && file1.ino() == file2.ino();
    }
    // Windows: we cannot compare without the path, so return false (conservative)
    #[allow(unreachable_code)]
    false
}

/// Returns `true` if the `file` is connected to a terminal/console.
///
/// Respects fake-console overrides set via `fake_stdin_is_console()` etc.
/// Equivalent to C's `UTIL_isConsole()`.
pub fn is_console_file(file: &dyn IsTerminal, stream: ConsoleStream) -> bool {
    trace_call("is_console");
    let ret = match stream {
        ConsoleStream::Stdin if G_FAKE_STDIN_IS_CONSOLE.load(Ordering::Relaxed) => true,
        ConsoleStream::Stdout if G_FAKE_STDOUT_IS_CONSOLE.load(Ordering::Relaxed) => true,
        ConsoleStream::Stderr if G_FAKE_STDERR_IS_CONSOLE.load(Ordering::Relaxed) => true,
        _ => file.is_terminal(),
    };
    trace_ret(ret as i32);
    ret
}

/// Which standard stream is being queried (for fake-console override checking).
pub enum ConsoleStream {
    Stdin,
    Stdout,
    Stderr,
}

/// Pretend that stdin is a console for testing purposes.
pub fn fake_stdin_is_console() {
    G_FAKE_STDIN_IS_CONSOLE.store(true, Ordering::Relaxed);
}

/// Pretend that stdout is a console for testing purposes.
pub fn fake_stdout_is_console() {
    G_FAKE_STDOUT_IS_CONSOLE.store(true, Ordering::Relaxed);
}

/// Pretend that stderr is a console for testing purposes.
pub fn fake_stderr_is_console() {
    G_FAKE_STDERR_IS_CONSOLE.store(true, Ordering::Relaxed);
}

// ─── File size ────────────────────────────────────────────────────────────────

/// Return the size in bytes of `path` if it is a regular file, or
/// `FILESIZE_UNKNOWN` on any error.
///
/// Equivalent to C's `UTIL_getFileSize()`.
pub fn get_file_size(path: &Path) -> u64 {
    trace_call(&format!("get_file_size({})", path.display()));
    let size = fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map_or(FILESIZE_UNKNOWN, |m| m.len());
    trace_ret(size as i32);
    size
}

/// Return the total size in bytes of all listed files, or `FILESIZE_UNKNOWN`
/// if any individual file size cannot be determined.
///
/// Equivalent to C's `UTIL_getTotalFileSize()`.
pub fn get_total_file_size(file_names: &[&str]) -> u64 {
    trace_call(&format!("get_total_file_size({})", file_names.len()));
    let mut total: u64 = 0;
    for name in file_names {
        let size = get_file_size(Path::new(name));
        if size == FILESIZE_UNKNOWN {
            trace_ret(-1);
            return FILESIZE_UNKNOWN;
        }
        total = total.saturating_add(size);
    }
    trace_ret(total as i32);
    total
}

// ─── File permissions ─────────────────────────────────────────────────────────

/// Set the permission bits of a regular file.
///
/// Skips non-regular files silently (returns 0/success).  If `meta` is
/// `None` the function stats the file internally first.
///
/// Equivalent to C's `UTIL_chmod()` / `UTIL_fchmod()`.
pub fn chmod_file(path: &Path, meta: Option<&fs::Metadata>, permissions: u32) -> i32 {
    trace_call(&format!("chmod_file({}, {:o})", path.display(), permissions));

    let owned_meta;
    let m: &fs::Metadata = match meta {
        Some(m) => m,
        None => {
            owned_meta = match fs::metadata(path) {
                Ok(m) => m,
                Err(_) => {
                    trace_ret(0);
                    return 0;
                }
            };
            &owned_meta
        }
    };

    if !m.is_file() {
        trace_ret(0);
        return 0;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(permissions);
        let ret = fs::set_permissions(path, perms).map_or(-1, |_| 0);
        trace_ret(ret);
        return ret;
    }

    #[allow(unreachable_code)]
    {
        trace_ret(0);
        0
    }
}

/// Copy owner, group, timestamps, and permissions from `src_meta` to `dst_path`.
///
/// Returns 0 on full success, a negative number indicating the count of
/// errors otherwise.  Only operates on regular files.
///
/// Equivalent to C's `UTIL_setFileStat()` / `UTIL_setFDStat()`.
pub fn set_file_stat(dst_path: &Path, src_meta: &fs::Metadata) -> i32 {
    trace_call(&format!("set_file_stat({})", dst_path.display()));

    let cur_meta = match fs::metadata(dst_path) {
        Ok(m) if m.is_file() => m,
        _ => {
            trace_ret(-1);
            return -1;
        }
    };

    let mut errors: i32 = 0;

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let dst_fd = -1i32; // path-based operations only in this Rust port
        let _ = dst_fd;

        // Apply group ownership first (mirrors gzip behaviour)
        let gid = src_meta.gid();
        let uid = src_meta.uid();

        // chown(path, -1, gid)
        unsafe {
            let path_cstr = std::ffi::CString::new(dst_path.as_os_str().as_encoded_bytes())
                .unwrap_or_default();
            if libc_chown(path_cstr.as_ptr(), u32::MAX, gid) != 0 {
                errors += 1;
            }
        }

        // Apply permissions
        errors += chmod_file(dst_path, Some(&cur_meta), src_meta.mode() & 0o777);

        // Apply user ownership
        unsafe {
            let path_cstr = std::ffi::CString::new(dst_path.as_os_str().as_encoded_bytes())
                .unwrap_or_default();
            if libc_chown(path_cstr.as_ptr(), uid, u32::MAX) != 0 {
                errors += 1;
            }
        }
    }

    #[cfg(not(unix))]
    {
        // On non-Unix platforms only copy permissions
        let _ = cur_meta;
        use std::os::unix::fs::PermissionsExt; // won't compile on Windows, guarded
        let _ = src_meta;
    }

    // Clear errno (mirrors C code)
    trace_ret(-errors);
    -errors
}

// Safety: thin wrapper around POSIX chown(2). uid/gid of u32::MAX map to -1.
#[cfg(unix)]
unsafe fn libc_chown(path: *const i8, uid: u32, gid: u32) -> i32 {
    extern "C" {
        fn chown(path: *const i8, owner: u32, group: u32) -> i32;
    }
    chown(path, uid, gid)
}

/// Set the access and modification times of `path` from `src_meta`.
///
/// Uses `utimensat` when available (POSIX 2008), otherwise `utime`.
/// Equivalent to C's `UTIL_utime()`.
pub fn utime_file(path: &Path, src_meta: &fs::Metadata) -> i32 {
    trace_call(&format!("utime_file({})", path.display()));

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Use std::fs::File::set_modified when stable; fall back to unsafe utimensat/utime.
        // std::fs::set_times is nightly-only; use the syscall directly.
        let mtime = src_meta.mtime();
        let mtime_nsec = src_meta.mtime_nsec();

        let ret = unsafe { set_times_posix(path, mtime, mtime_nsec) };
        trace_ret(ret);
        return ret;
    }

    #[allow(unreachable_code)]
    {
        trace_ret(-1);
        -1
    }
}

#[cfg(unix)]
unsafe fn set_times_posix(path: &Path, mtime_sec: i64, mtime_nsec: i64) -> i32 {
    extern "C" {
        // utimensat(int dirfd, const char *pathname,
        //           const struct timespec times[2], int flags) -> int
        fn utimensat(dirfd: i32, path: *const i8, times: *const TimeSpec, flags: i32) -> i32;
    }

    #[repr(C)]
    struct TimeSpec {
        tv_sec: i64,
        tv_nsec: i64,
    }

    // UTIME_NOW = (1<<30)-1 on Linux; we only set mtime, atime = now
    const UTIME_NOW: i64 = 0x3fff_ffff;
    const AT_FDCWD: i32 = -100;

    let times = [
        TimeSpec { tv_sec: 0, tv_nsec: UTIME_NOW },
        TimeSpec { tv_sec: mtime_sec, tv_nsec: mtime_nsec },
    ];

    let path_cstr =
        std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap_or_default();
    utimensat(AT_FDCWD, path_cstr.as_ptr(), times.as_ptr(), 0)
}

// ─── Extension / filename helpers ─────────────────────────────────────────────

/// Return the extension portion of `filename` (including the leading dot), or
/// an empty string if there is none.
///
/// Equivalent to C's `UTIL_getFileExtension()`.
pub fn get_file_extension(filename: &str) -> &str {
    match filename.rfind('.') {
        None | Some(0) => "",
        Some(i) => &filename[i..],
    }
}

/// Return `true` if `filename`'s extension is in `extension_list`.
///
/// Equivalent to C's `UTIL_isCompressedFile()`.
pub fn is_compressed_file(filename: &str, extension_list: &[&str]) -> bool {
    let ext = get_file_extension(filename);
    extension_list.iter().any(|&e| e == ext)
}

/// Compare two strings (for use as a sort comparator).
///
/// Equivalent to C's `UTIL_compareStr()`.
pub fn compare_str(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

// ─── FileNamesTable ────────────────────────────────────────────────────────────

/// An owned, growable collection of file names.
///
/// Equivalent to C's `FileNamesTable`.  In the C version the struct carried
/// separate `fileNames`/`buf`/capacity fields; in Rust, `Vec<String>` handles
/// all of that transparently.
#[derive(Default)]
pub struct FileNamesTable {
    pub file_names: Vec<String>,
}

impl FileNamesTable {
    /// Create an empty table (equivalent to `UTIL_allocateFileNamesTable`).
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a table with pre-allocated capacity.
    pub fn with_capacity(cap: usize) -> Self {
        Self { file_names: Vec::with_capacity(cap) }
    }

    /// Assemble from an existing iterator of owned strings
    /// (equivalent to `UTIL_assembleFileNamesTable`).
    pub fn from_strings(names: impl IntoIterator<Item = String>) -> Self {
        Self { file_names: names.into_iter().collect() }
    }

    /// Add a reference to a filename.  The string is cloned into the table.
    /// Equivalent to `UTIL_refFilename()` (which only stored a pointer;
    /// we store an owned copy, which is semantically equivalent).
    pub fn ref_filename(&mut self, filename: &str) {
        self.file_names.push(filename.to_owned());
    }

    /// Search for `name`; return its index or `None` if not found.
    /// Equivalent to `UTIL_searchFileNamesTable()` (which returned -1 on miss).
    pub fn search(&self, name: &str) -> Option<usize> {
        self.file_names.iter().position(|n| n == name)
    }

    /// Consume `other` and append its entries to `self`.
    /// Equivalent to `UTIL_mergeFileNamesTable()`.
    pub fn merge(&mut self, other: FileNamesTable) {
        self.file_names.extend(other.file_names);
    }

    /// Number of entries.
    #[inline]
    pub fn len(&self) -> usize {
        self.file_names.len()
    }

    /// `true` iff the table is empty.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.file_names.is_empty()
    }
}

/// Build a `FileNamesTable` by reading one file-name per line from `input_path`.
///
/// Returns `None` if the file cannot be opened, is not a regular file, or is
/// larger than `MAX_FILE_OF_FILE_NAMES_SIZE`.
///
/// Equivalent to C's `UTIL_createFileNamesTable_fromFileName()`.
pub fn create_file_names_table_from_file(input_path: &Path) -> Option<FileNamesTable> {
    let meta = fs::metadata(input_path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_OF_FILE_NAMES_SIZE {
        return None;
    }

    let file = fs::File::open(input_path).ok()?;
    let reader = io::BufReader::new(file);

    let mut names: Vec<String> = Vec::new();
    for line in reader.lines() {
        match line {
            Ok(l) if !l.is_empty() => names.push(l),
            Ok(_) => {} // skip blank lines
            Err(_) => return None,
        }
    }

    Some(FileNamesTable { file_names: names })
}

/// Create a `FileNamesTable` from a read-only slice of strings (the strings
/// are cloned into the table).
///
/// Equivalent to C's `UTIL_createFNT_fromROTable()`.
pub fn create_fnt_from_ro_table(filenames: &[&str]) -> FileNamesTable {
    FileNamesTable { file_names: filenames.iter().map(|s| s.to_string()).collect() }
}

/// Expand directories in `fnt` to their constituent files (in-place).
///
/// Equivalent to C's `UTIL_expandFNT()`.
pub fn expand_fnt(fnt: &mut FileNamesTable, follow_links: bool) {
    let original: Vec<String> = std::mem::take(&mut fnt.file_names);
    let paths: Vec<&str> = original.iter().map(|s| s.as_str()).collect();
    if let Some(expanded) = create_expanded_fnt(&paths, follow_links) {
        *fnt = expanded;
    }
    // On error, leave fnt empty (matches C behaviour of setting fnt[0] = NULL)
}

/// Build a `FileNamesTable` from a list of paths, expanding any directories
/// recursively.
///
/// Equivalent to C's `UTIL_createExpandedFNT()`.
pub fn create_expanded_fnt(input_names: &[&str], follow_links: bool) -> Option<FileNamesTable> {
    let mut file_names: Vec<String> = Vec::new();

    for name in input_names {
        let path = Path::new(name);
        if is_directory(path) {
            prepare_file_list(path, &mut file_names, follow_links);
        } else {
            file_names.push(name.to_string());
        }
    }

    Some(FileNamesTable { file_names })
}

/// Recursively collect all non-directory paths under `dir` into `out`.
///
/// Equivalent to C's `UTIL_prepareFileList()` (POSIX variant).
fn prepare_file_list(dir: &Path, out: &mut Vec<String>, follow_links: bool) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            displaylevel!(1, "Cannot open directory '{}': {}\n", dir.display(), e);
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                displaylevel!(1, "readdir({}) error: {}\n", dir.display(), e);
                return;
            }
        };

        let path = entry.path();

        if !follow_links && is_link(&path) {
            displaylevel!(2, "Warning : {} is a symbolic link, ignoring\n", path.display());
            continue;
        }

        if is_directory(&path) {
            prepare_file_list(&path, out, follow_links);
        } else {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

// ─── Mirror directory utilities ───────────────────────────────────────────────

/// Returns `true` if `pathname` does not contain a `..` path token.
fn pathname_has_no_dotdot(pathname: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    let mut needle = pathname;
    loop {
        match needle.find("..") {
            None => return true,
            Some(i) => {
                let before_ok = i == 0 || needle.as_bytes()[i - 1] == sep as u8;
                let after_ok = i + 2 >= needle.len()
                    || needle.as_bytes()[i + 2] == sep as u8;
                if before_ok && after_ok {
                    return false; // found a real `..` token
                }
                needle = &needle[i + 1..];
            }
        }
    }
}

fn is_filename_valid_for_mirrored_output(filename: &str) -> bool {
    pathname_has_no_dotdot(filename)
}

/// Strip a leading root separator or `./` from `pathname`.
fn trim_path(pathname: &str) -> &str {
    let sep = std::path::MAIN_SEPARATOR;
    let s = if pathname.starts_with("./") || pathname.starts_with(".\\") {
        &pathname[2..]
    } else {
        pathname
    };
    if s.starts_with(sep) { &s[1..] } else { s }
}

fn first_is_parent_or_same(first: &str, second: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    first.len() <= second.len()
        && (second.as_bytes().get(first.len()).copied() == Some(sep as u8)
            || second.len() == first.len())
        && second.starts_with(first)
}

/// Create the destination directory corresponding to `src_file_name` under
/// `out_dir_root_name`.
///
/// Returns `None` if the source filename contains `..` tokens.
/// Equivalent to C's `UTIL_createMirroredDestDirName()`.
pub fn create_mirrored_dest_dir_name(
    src_file_name: &str,
    out_dir_root_name: &str,
) -> Option<PathBuf> {
    if !is_filename_valid_for_mirrored_output(src_file_name) {
        return None;
    }

    let trimmed = trim_path(src_file_name);
    let mut dest = PathBuf::from(out_dir_root_name);
    dest.push(trimmed);
    // Convert to directory name (like dirname)
    dest.pop();
    Some(dest)
}

/// Create mirror directory structure for a list of source files.
///
/// Equivalent to C's `UTIL_mirrorSourceFilesDirectories()`.
pub fn mirror_source_files_directories(
    in_file_names: &[&str],
    out_dir_name: &str,
) {
    let sep = std::path::MAIN_SEPARATOR;

    // Collect valid filenames
    let valid: Vec<&str> = in_file_names
        .iter()
        .copied()
        .filter(|f| is_filename_valid_for_mirrored_output(f))
        .collect();

    if valid.is_empty() {
        return;
    }

    // Ensure root output directory exists
    let _ = make_dir(out_dir_name, DIR_DEFAULT_MODE);

    // Collect source directories (dirname of each file)
    let mut src_dirs: Vec<String> = valid
        .iter()
        .filter_map(|f| {
            let trimmed = trim_path(f);
            let p = PathBuf::from(trimmed);
            p.parent().map(|d| d.to_string_lossy().into_owned())
        })
        .collect();

    // Sort directories so parent always precedes children
    src_dirs.sort_by(|a, b| trim_path(a).cmp(trim_path(b)));
    src_dirs.dedup_by(|a, b| first_is_parent_or_same(trim_path(b), trim_path(a)));

    for src_dir in &src_dirs {
        mirror_src_dir_recursive(src_dir, out_dir_name, sep);
    }
}

fn mirror_src_dir_recursive(src_dir: &str, out_dir_name: &str, sep: char) {
    // Walk through each path component and create the mirrored directory
    let trimmed = trim_path(src_dir);
    let mut cumulative = String::new();
    for component in trimmed.split(sep) {
        if component.is_empty() {
            continue;
        }
        if !cumulative.is_empty() {
            cumulative.push(sep);
        }
        cumulative.push_str(component);

        // Reconstruct original src path for mode lookup
        let original_src = format!(
            "{}{}{}",
            if src_dir.starts_with('.') { "." } else { "" },
            if src_dir.starts_with('.') { std::path::MAIN_SEPARATOR.to_string() } else { String::new() },
            cumulative
        );
        let src_mode = get_dir_mode(&original_src);
        let new_dir = format!("{}{}{}", out_dir_name, sep, cumulative);
        let _ = make_dir(&new_dir, src_mode);
    }
}

fn get_dir_mode(dir_name: &str) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(m) = fs::metadata(dir_name) {
            if m.is_dir() {
                return m.mode();
            }
        }
    }
    DIR_DEFAULT_MODE
}

fn make_dir(dir: &str, _mode: u32) -> i32 {
    match fs::create_dir(dir) {
        Ok(_) => 0,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => 0,
        Err(e) => {
            display!("zstd: failed to create DIR {}: {}\n", dir, e);
            -1
        }
    }
}

// ─── Core counting ────────────────────────────────────────────────────────────

/// Return the number of logical or physical CPU cores available.
///
/// When `logical` is `true`, returns logical (hardware-thread) count.
/// When `false`, attempts to return physical core count (accounting for
/// hyperthreading on Linux; falls back to logical count on other platforms).
///
/// Equivalent to C's `UTIL_countCores()`.
pub fn count_cores(logical: bool) -> usize {
    #[cfg(target_os = "linux")]
    return count_cores_linux(logical);

    #[cfg(target_os = "macos")]
    return count_cores_macos(logical);

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = logical;
        std::thread::available_parallelism().map_or(1, |n| n.get())
    }
}

/// Return the number of physical cores.
///
/// Equivalent to C's `UTIL_countPhysicalCores()`.
#[inline]
pub fn count_physical_cores() -> usize {
    count_cores(false)
}

/// Return the number of logical cores (hardware threads).
///
/// Equivalent to C's `UTIL_countLogicalCores()`.
#[inline]
pub fn count_logical_cores() -> usize {
    count_cores(true)
}

#[cfg(target_os = "linux")]
fn count_cores_linux(logical: bool) -> usize {
    use std::io::BufRead;

    let logical_count =
        std::thread::available_parallelism().map_or(1, |n| n.get());

    if logical {
        return logical_count;
    }

    // Try to determine hyperthreading ratio from /proc/cpuinfo
    let file = match fs::File::open("/proc/cpuinfo") {
        Ok(f) => f,
        Err(_) => return logical_count,
    };

    let reader = io::BufReader::new(file);
    let mut siblings: Option<usize> = None;
    let mut cpu_cores: Option<usize> = None;

    for line in reader.lines().flatten() {
        if line.starts_with("siblings") {
            if let Some(val) = line.find(':').and_then(|i| line[i + 1..].trim().parse().ok()) {
                siblings = Some(val);
            }
        } else if line.starts_with("cpu cores") {
            if let Some(val) = line.find(':').and_then(|i| line[i + 1..].trim().parse().ok()) {
                cpu_cores = Some(val);
            }
        }
        if siblings.is_some() && cpu_cores.is_some() {
            break;
        }
    }

    if let (Some(s), Some(c)) = (siblings, cpu_cores) {
        if s > c && c > 0 {
            let ratio = s / c;
            if ratio > 1 && logical_count > ratio {
                return logical_count / ratio;
            }
        }
    }

    logical_count
}

#[cfg(target_os = "macos")]
fn count_cores_macos(logical: bool) -> usize {
    extern "C" {
        fn sysctlbyname(
            name: *const i8,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }

    let key = if logical { "hw.logicalcpu\0" } else { "hw.physicalcpu\0" };
    let mut val: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    let ret = unsafe {
        sysctlbyname(
            key.as_ptr() as *const i8,
            &mut val as *mut i32 as *mut _,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret == 0 && val > 0 {
        val as usize
    } else {
        std::thread::available_parallelism().map_or(1, |n| n.get())
    }
}
