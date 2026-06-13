use crate::files::is_text_file;
use regex::RegexBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_RESULTS: usize = 500;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

fn walk_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_dir() {
            walk_files(&path, out);
        } else if ft.is_file() && is_text_file(&path) {
            out.push(path);
        }
    }
}

fn grep(root: &str, pattern: &regex::Regex) -> Vec<Hit> {
    let mut files = vec![];
    walk_files(Path::new(root), &mut files);
    let mut hits = vec![];
    'outer: for path in files {
        if fs::metadata(&path).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else { continue };
        for (i, line) in content.lines().enumerate() {
            if let Some(m) = pattern.find(line) {
                hits.push(Hit {
                    path: path.to_string_lossy().into_owned(),
                    line: i + 1,
                    text: line.chars().take(400).collect(),
                    start: m.start(),
                    end: m.end().min(400),
                });
                if hits.len() >= MAX_RESULTS {
                    break 'outer;
                }
            }
        }
    }
    hits
}

/// Literal full-text search across the folder. Smartcase: case-insensitive
/// unless the query contains an uppercase letter.
#[tauri::command]
pub fn search_text(root: String, query: String) -> Result<Vec<Hit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let case_insensitive = !query.chars().any(|c| c.is_uppercase());
    let pattern = RegexBuilder::new(&regex::escape(&query))
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(grep(&root, &pattern))
}

/// Find every line in the folder that wikilinks to `target` (a note name
/// without extension): [[target]], [[target|label]], [[target#heading]].
#[tauri::command]
pub fn find_backlinks(root: String, target: String) -> Result<Vec<Hit>, String> {
    if target.trim().is_empty() {
        return Ok(vec![]);
    }
    let pattern = RegexBuilder::new(&format!(
        r"\[\[{}\s*([|#][^\]]*)?\]\]",
        regex::escape(target.trim())
    ))
    .case_insensitive(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(grep(&root, &pattern))
}
