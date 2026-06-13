use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Extensions treated as editable text. Anything else is left out of the
/// tree so binaries, images, and sync droppings never show up.
pub const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "txt", "text", "json", "yaml", "yml", "toml", "ini", "cfg",
    "conf", "csv", "tsv", "log", "tex", "bib", "org", "rst", "adoc", "html", "htm", "css",
    "js", "ts", "jsx", "tsx", "py", "rs", "sh", "bash", "zsh", "fish", "c", "h", "cpp",
    "hpp", "go", "rb", "lua", "sql", "xml", "svg", "env", "gitignore", "fountain",
];

pub fn is_text_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => TEXT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        // extensionless files like LICENSE, TODO, Makefile-ish notes
        None => true,
    }
}

/// Image formats the viewer can display. Shown in the tree but never
/// searched or opened as text.
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "tif",
];

pub fn is_image_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Audio formats the built-in player can handle. Shown in the tree but
/// never searched or opened as text.
pub const AUDIO_EXTENSIONS: &[&str] =
    &["mp3", "wav", "ogg", "oga", "m4a", "flac", "opus", "aac", "weba"];

pub fn is_audio_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Video formats the built-in player can handle (playback uses the system's
/// media stack — no codecs are bundled). Shown in the tree, never searched.
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "ogv"];

pub fn is_video_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// PDF documents — shown in the tree and rendered by the in-app viewer.
pub fn is_pdf_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some(ext) if ext.eq_ignore_ascii_case("pdf")
    )
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub mtime: u64,
    pub children: Option<Vec<Entry>>,
}

fn walk(dir: &Path, depth: usize) -> Result<Vec<Entry>, String> {
    if depth > 32 {
        return Ok(vec![]);
    }
    let mut dirs: Vec<Entry> = vec![];
    let mut files: Vec<Entry> = vec![];
    let read = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for item in read.flatten() {
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let Ok(ft) = item.file_type() else { continue };
        let mtime = mtime_of(&path).unwrap_or(0);
        if ft.is_dir() {
            dirs.push(Entry {
                children: Some(walk(&path, depth + 1)?),
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                mtime,
            });
        } else if ft.is_file()
            && (is_text_file(&path)
                || is_image_file(&path)
                || is_audio_file(&path)
                || is_video_file(&path)
                || is_pdf_file(&path))
        {
            files.push(Entry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                mtime,
                children: None,
            });
        }
    }
    let sort = |v: &mut Vec<Entry>| {
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    };
    sort(&mut dirs);
    sort(&mut files);
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub fn list_tree(root: String) -> Result<Vec<Entry>, String> {
    walk(Path::new(&root), 0)
}

pub fn mtime_of(path: &Path) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let t = meta.modified().map_err(|e| e.to_string())?;
    Ok(t.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64)
}

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub mtime: u64,
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let p = Path::new(&path);
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("{} is not valid UTF-8 text", p.display()))?;
    Ok(FileContent { content, mtime: mtime_of(p)? })
}

#[derive(Serialize)]
pub struct ImageContent {
    pub base64: String,
    pub mtime: u64,
}

#[tauri::command]
pub fn read_image(path: String) -> Result<ImageContent, String> {
    use base64::Engine;
    let p = Path::new(&path);
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(ImageContent {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mtime: mtime_of(p)?,
    })
}

#[derive(Serialize)]
pub struct WriteResult {
    pub mtime: u64,
    pub conflict: bool,
}

/// Atomic save: write to a temp file in the same directory, then rename over
/// the target, so Dropbox never syncs a half-written note. If the file on
/// disk is newer than what the editor last saw, refuse and report a conflict.
#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    expected_mtime: Option<u64>,
) -> Result<WriteResult, String> {
    let p = PathBuf::from(&path);
    if let (Some(expected), Ok(on_disk)) = (expected_mtime, mtime_of(&p)) {
        if on_disk != expected {
            return Ok(WriteResult { mtime: on_disk, conflict: true });
        }
    }
    let dir = p.parent().ok_or("path has no parent directory")?;
    let tmp = dir.join(format!(
        ".{}.text-tmp",
        p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
    ));
    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(WriteResult { mtime: mtime_of(&p)?, conflict: false })
}

#[tauri::command]
pub fn stat_mtime(path: String) -> Result<u64, String> {
    mtime_of(Path::new(&path))
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(p, b"").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(Path::new(&path)).map_err(|e| e.to_string())
}

/// First free path for `name` in `dir`: name.png, name-1.png, name-2.png…
fn dedup_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Copy an outside file (drag-drop) into `dest_dir`, deduplicating the name.
/// Returns the final path.
#[tauri::command]
pub fn import_file(src: String, dest_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&src);
    let name = src
        .file_name()
        .ok_or("source has no file name")?
        .to_string_lossy()
        .into_owned();
    let dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dedup_path(&dir, &name);
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Write base64 bytes (clipboard image paste) into `dest_dir` as `name`,
/// deduplicating. Returns the final path.
#[tauri::command]
pub fn write_base64(dest_dir: String, name: String, base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dedup_path(&dir, &name);
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Free path for `name` in `dir`, inserting " copy" (then " copy 2"…) before
/// the extension when the name is taken — for duplicate / paste in the tree.
fn copy_dest(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let first = dir.join(format!("{stem} copy{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} copy {n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn copy_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for item in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_recursive(&item.path(), &dest.join(item.file_name()))?;
        }
    } else {
        fs::copy(src, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a file or folder into `dest_dir` ("paste"/"duplicate" in the tree),
/// appending " copy" to the name when it would collide. Returns the new path.
#[tauri::command]
pub fn copy_path(src: String, dest_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&src);
    let name = src
        .file_name()
        .ok_or("source has no file name")?
        .to_string_lossy()
        .into_owned();
    let dir = PathBuf::from(&dest_dir);
    if src.is_dir() && (dir == src || dir.starts_with(&src)) {
        return Err("cannot copy a folder into itself".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = copy_dest(&dir, &name);
    copy_recursive(&src, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Overwrite `path` with base64 bytes (image editing tools).
#[tauri::command]
pub fn overwrite_base64(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| e.to_string())?;
    fs::write(Path::new(&path), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(Path::new(&path)).map_err(|e| e.to_string())
}
