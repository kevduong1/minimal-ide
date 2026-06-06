//! Plain filesystem operations for the file explorer and editor.
//!
//! All commands run their blocking I/O on the blocking thread pool so large
//! files never stall the async runtime (which also serves terminal IPC).

use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    text: String,
    binary: bool,
    truncated: bool,
}

/// Files larger than this are truncated (on a char boundary) before being
/// sent to the webview. Workspace search (search.rs) skips such files
/// entirely so its notion of "searchable" matches the editor's "editable".
pub(crate) const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

/// Number of leading bytes inspected for NUL to classify a file as binary.
pub(crate) const BINARY_SNIFF_BYTES: usize = 8000;

#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_dir_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_dir_impl(path: &str) -> Result<Vec<DirEntry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let entry_path = entry.path();
        // metadata() follows symlinks; broken links count as files.
        let is_dir = std::fs::metadata(&entry_path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_file_impl(path: &str) -> Result<FileContent, String> {
    // Read at most MAX_TEXT_BYTES + 1 so huge files are never fully loaded;
    // the extra byte tells us whether truncation happened.
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    let truncated = buf.len() > MAX_TEXT_BYTES;
    if truncated {
        buf.truncate(MAX_TEXT_BYTES);
    }

    if buf.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileContent {
            text: String::new(),
            binary: true,
            truncated: false,
        });
    }

    match String::from_utf8(buf) {
        Ok(text) => Ok(FileContent {
            text,
            binary: false,
            truncated,
        }),
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let bytes = e.into_bytes();
            if truncated && bytes.len() - valid < 4 {
                // The 5 MB cut split a multi-byte character: drop the partial
                // tail and keep the (truncated) text.
                let text = String::from_utf8(bytes[..valid].to_vec())
                    .map_err(|e| e.to_string())?;
                Ok(FileContent {
                    text,
                    binary: false,
                    truncated: true,
                })
            } else {
                // Genuinely non-UTF-8 content. Do NOT lossy-decode: editing a
                // lossy view and saving it would silently corrupt the file.
                Ok(FileContent {
                    text: String::new(),
                    binary: true,
                    truncated: false,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn fs_write_file(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file_impl(&path, &text))
        .await
        .map_err(|e| e.to_string())?
}

/// Atomic save: write a temp file in the same directory, then rename over the
/// target, so a crash or full disk mid-write can never truncate the file.
fn write_file_impl(path: &str, text: &str) -> Result<(), String> {
    // Write through symlinks rather than replacing the link itself.
    let target: PathBuf = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let dir = target
        .parent()
        .ok_or_else(|| "invalid path: no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(".{file_name}.vibe-studio.tmp"));

    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // Preserve the original file's permissions (fresh temp files get defaults).
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
