//! Note metadata for the in-editor `dataview` query blocks: one pass over
//! the folder's notes collecting frontmatter fields, #tags, and task items.
//! The query language itself lives in the frontend (src/dataview.ts).

use regex::Regex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct TaskItem {
    pub text: String,
    pub done: bool,
    pub line: u32, // 1-based
}

#[derive(Serialize)]
pub struct NoteMeta {
    pub path: String, // absolute
    pub rel: String,  // relative to the root, '/'-separated
    pub name: String, // file stem (wikilink target)
    pub mtime: u64,
    pub tags: Vec<String>, // without '#', lowercase
    pub fields: BTreeMap<String, String>, // frontmatter scalars
    pub tasks: Vec<TaskItem>,
}

fn is_md(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdown")
}

fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[\s(\[{])#([\p{L}\p{N}/_-]*\p{L}[\p{L}\p{N}/_-]*)").unwrap()
    })
}

fn task_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$").unwrap())
}

fn parse_note(text: &str) -> (BTreeMap<String, String>, Vec<String>, Vec<TaskItem>) {
    let mut fields = BTreeMap::new();
    let mut tags: Vec<String> = vec![];
    let mut tasks = vec![];

    let mut lines = text.lines().enumerate().peekable();
    // frontmatter: flat `key: value` scalars only
    if lines.peek().map(|(_, l)| l.trim()) == Some("---") {
        lines.next();
        for (_, line) in lines.by_ref() {
            let t = line.trim();
            if t == "---" || t == "..." {
                break;
            }
            if let Some((k, v)) = t.split_once(':') {
                let key = k.trim().to_lowercase();
                let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
                if !key.is_empty() && !key.contains(' ') {
                    // frontmatter tags count as tags too
                    if key == "tags" {
                        for tag in val.split([',', ' ']) {
                            let tag = tag.trim().trim_start_matches('#').to_lowercase();
                            if !tag.is_empty() {
                                tags.push(tag);
                            }
                        }
                    }
                    fields.insert(key, val);
                }
            }
        }
    }

    let mut fence: Option<&str> = None;
    for (i, line) in lines {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) {
                fence = None;
            }
            continue; // no tags/tasks inside code blocks
        }
        if t.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if t.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        for cap in tag_re().captures_iter(line) {
            let tag = cap[1].to_lowercase();
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        if let Some(cap) = task_re().captures(line) {
            tasks.push(TaskItem {
                text: cap[2].trim().to_string(),
                done: &cap[1] != " ",
                line: (i + 1) as u32,
            });
        }
    }
    (fields, tags, tasks)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<NoteMeta>) {
    if depth > 32 {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_dir() {
            walk(root, &path, depth + 1, out);
            continue;
        }
        if !ft.is_file() || !is_md(&name) {
            continue;
        }
        let meta = item.metadata().ok();
        if meta.as_ref().map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let (fields, tags, tasks) = parse_note(&text);
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        let stem = match name.rfind('.') {
            Some(i) if i > 0 => name[..i].to_string(),
            _ => name.clone(),
        };
        out.push(NoteMeta {
            path: path.to_string_lossy().into_owned(),
            rel,
            name: stem,
            mtime: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            tags,
            fields,
            tasks,
        });
    }
}

#[tauri::command]
pub async fn collect_notes(root: String) -> Result<Vec<NoteMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = vec![];
        walk(Path::new(&root), Path::new(&root), 0, &mut out);
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_tags_tasks() {
        let (fields, tags, tasks) = parse_note(
            "---\nstatus: draft\ntags: physics, week-1\n---\n# T\n\nbody #lecture\n\n- [ ] read ch. 2\n- [x] slides\n\n```\n#not-a-tag\n- [ ] not a task\n```\n",
        );
        assert_eq!(fields.get("status").map(String::as_str), Some("draft"));
        assert!(tags.contains(&"physics".into()) && tags.contains(&"lecture".into()));
        assert!(!tags.contains(&"not-a-tag".into()));
        assert_eq!(tasks.len(), 2);
        assert!(!tasks[0].done && tasks[1].done);
        assert_eq!(tasks[0].text, "read ch. 2");
    }
}
