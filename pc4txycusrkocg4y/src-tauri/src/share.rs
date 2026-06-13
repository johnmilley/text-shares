//! Folder sharing: publish a static export (export.rs) of a folder to a
//! GitHub Pages repo, one unguessable slug directory per share. Uses the
//! system `git` and an authenticated `gh` CLI — no tokens stored here.

use crate::export::{export_site, CommentsCfg, ExportStats};
use crate::themes::config_dir;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serializes all shares-repo mutations (startup cleanup vs. dialog actions).
static REPO_LOCK: Mutex<()> = Mutex::new(());

/// Take the shares lock, tolerating a poisoned mutex. Every share op returns
/// `Result` and the lock guards only filesystem/git side effects (which are
/// re-synced from the remote on each call via `sync_repo`), so if an earlier
/// op panicked while holding the lock there's no broken in-memory invariant to
/// protect — recover the guard instead of letting `unwrap()` cascade the panic
/// into every later share attempt (was the "PoisonError" the dialog reported).
fn repo_lock() -> std::sync::MutexGuard<'static, ()> {
    REPO_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

const REPO_NAME: &str = "text-shares";

#[derive(Serialize, Deserialize, Clone)]
pub struct ShareEntry {
    pub folder: String, // absolute path of the shared folder
    pub slug: String,
    pub repo: String, // "owner/text-shares"
    pub url: String,
    pub created: u64,            // unix seconds
    pub expires: Option<u64>,    // None = never
    /// giscus wiring when reader comments are enabled for this share
    #[serde(default)]
    pub comments: Option<CommentsCfg>,
}

#[derive(Serialize, Deserialize, Default)]
struct Registry {
    #[serde(default)]
    shares: Vec<ShareEntry>,
}

#[derive(Serialize)]
pub struct ShareResult {
    pub share: ShareEntry,
    pub pushed: bool, // false = repo already had identical content
    pub pages: usize,
    pub skipped: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn gen_slug() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    (0..16).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

// ---------------------------------------------------------------- registry

fn registry_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("shares.toml"))
}

fn load_registry() -> Result<Registry, String> {
    match fs::read_to_string(registry_path()?) {
        Ok(src) => toml::from_str(&src).map_err(|e| e.to_string()),
        Err(_) => Ok(Registry::default()),
    }
}

fn save_registry(reg: &Registry) -> Result<(), String> {
    let path = registry_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let src = toml::to_string_pretty(reg).map_err(|e| e.to_string())?;
    // atomic, like files.rs::write_file — a crash mid-write loses nothing
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, src).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- subprocess

fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "{program} {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn ensure_tools() -> Result<(), String> {
    run("git", &["--version"], None)
        .map_err(|_| "git is not installed (sharing needs it)".to_string())?;
    run("gh", &["--version"], None)
        .map_err(|_| "the GitHub CLI (gh) is not installed (sharing needs it)".to_string())?;
    run("gh", &["auth", "status"], None)
        .map_err(|_| "GitHub CLI is not signed in — run `gh auth login` in a terminal".to_string())?;
    Ok(())
}

fn repo_dir() -> Result<PathBuf, String> {
    Ok(dirs::data_dir().ok_or("no data directory")?.join("text/shares-repo"))
}

/// Make sure the shares repo exists on GitHub and as a healthy local clone
/// with Pages enabled. Returns (local path, owner login).
fn ensure_repo() -> Result<(PathBuf, String), String> {
    ensure_tools()?;
    let owner = run("gh", &["api", "user", "-q", ".login"], None)?;
    let full = format!("{owner}/{REPO_NAME}");

    if run("gh", &["repo", "view", &full], None).is_err() {
        run(
            "gh",
            &["repo", "create", REPO_NAME, "--public", "--description", "Shared note exports"],
            None,
        )?;
    }

    let local = repo_dir()?;
    let healthy = local.is_dir()
        && run("git", &["rev-parse", "--git-dir"], Some(&local)).is_ok();
    if !healthy {
        if local.exists() {
            fs::remove_dir_all(&local).map_err(|e| e.to_string())?;
        }
        if let Some(parent) = local.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        run(
            "git",
            &[
                "clone",
                &format!("https://github.com/{full}.git"),
                &local.to_string_lossy(),
            ],
            None,
        )?;
    }
    // repo-local identity so commits work without global git config
    run("git", &["config", "user.name", "text"], Some(&local))?;
    run("git", &["config", "user.email", "text@localhost"], Some(&local))?;

    // brand-new repo: seed a first commit so main exists to push onto
    if run("git", &["rev-parse", "HEAD"], Some(&local)).is_err() {
        fs::write(local.join(".nojekyll"), "").map_err(|e| e.to_string())?;
        fs::write(
            local.join("README.md"),
            "Static note exports published by [text](https://github.com/).\n",
        )
        .map_err(|e| e.to_string())?;
        run("git", &["add", "-A"], Some(&local))?;
        run("git", &["commit", "-m", "init"], Some(&local))?;
        run("git", &["branch", "-M", "main"], Some(&local))?;
        run("git", &["push", "-u", "origin", "main"], Some(&local))?;
    } else if !local.join(".nojekyll").exists() {
        fs::write(local.join(".nojekyll"), "").map_err(|e| e.to_string())?;
    }

    // enable Pages from main; 409 = already enabled
    if let Err(e) = run(
        "gh",
        &[
            "api", "-X", "POST",
            &format!("repos/{full}/pages"),
            "-f", "source[branch]=main",
            "-f", "source[path]=/",
        ],
        None,
    ) {
        if !e.contains("409") && !e.to_lowercase().contains("already") {
            return Err(format!("could not enable GitHub Pages: {e}"));
        }
    }
    Ok((local, owner))
}

/// Bring the local clone up to date with the remote before mutating it.
fn sync_repo(local: &Path) -> Result<(), String> {
    run("git", &["fetch", "origin"], Some(local))?;
    run("git", &["reset", "--hard", "origin/main"], Some(local))?;
    run("git", &["clean", "-fd"], Some(local))?;
    Ok(())
}

/// Stage everything; commit + push only when content actually changed.
/// Returns false when the repo already matched (the "no-op update" signal).
fn publish(local: &Path, message: &str) -> Result<bool, String> {
    run("git", &["add", "-A"], Some(local))?;
    if run("git", &["status", "--porcelain"], Some(local))?.is_empty() {
        return Ok(false);
    }
    run("git", &["commit", "-m", message], Some(local))?;
    if let Err(first) = run("git", &["push", "origin", "main"], Some(local)) {
        // remote moved (another machine?) — rebase our commit once and retry
        run("git", &["fetch", "origin"], Some(local))
            .and_then(|_| run("git", &["rebase", "origin/main"], Some(local)))
            .and_then(|_| run("git", &["push", "origin", "main"], Some(local)))
            .map_err(|_| first)?;
    }
    Ok(true)
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct ShareStatus {
    pub entry: Option<ShareEntry>,
    /// registry entries whose folders no longer exist (orphaned by renames)
    pub orphans: Vec<ShareEntry>,
}

#[tauri::command]
pub fn share_status(folder: String) -> Result<ShareStatus, String> {
    let reg = load_registry()?;
    let entry = reg.shares.iter().find(|s| s.folder == folder).cloned();
    let orphans = reg
        .shares
        .iter()
        .filter(|s| !Path::new(&s.folder).is_dir())
        .cloned()
        .collect();
    Ok(ShareStatus { entry, orphans })
}

/// Wire up giscus comments for the shares repo: turn Discussions on and look
/// up the ids giscus needs. The giscus GitHub App itself has to be installed
/// once by the user (we can't do that via the API) — the dialog explains.
fn setup_comments(full: &str) -> Result<CommentsCfg, String> {
    run(
        "gh",
        &["api", "-X", "PATCH", &format!("repos/{full}"), "-F", "has_discussions=true"],
        None,
    )
    .map_err(|e| format!("could not enable GitHub Discussions: {e}"))?;
    let (owner, name) = full.split_once('/').ok_or("bad repo name")?;
    let query = format!(
        "query{{repository(owner:\"{owner}\",name:\"{name}\"){{id discussionCategories(first:25){{nodes{{id name}}}}}}}}"
    );
    let out = run("gh", &["api", "graphql", "-f", &format!("query={query}")], None)?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let repo = &v["data"]["repository"];
    let repo_id = repo["id"].as_str().ok_or("no repository id from GitHub")?.to_string();
    let nodes = repo["discussionCategories"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let cat = nodes
        .iter()
        .find(|n| n["name"] == "Announcements")
        .or_else(|| nodes.iter().find(|n| n["name"] == "General"))
        .or_else(|| nodes.first())
        .ok_or("the shares repo has no discussion categories yet — open its Discussions tab once on GitHub")?;
    Ok(CommentsCfg {
        repo: full.to_string(),
        repo_id,
        category: cat["name"].as_str().unwrap_or("General").to_string(),
        category_id: cat["id"].as_str().ok_or("no category id from GitHub")?.to_string(),
    })
}

fn export_into(
    folder: &Path,
    local: &Path,
    slug: &str,
    comments: Option<&CommentsCfg>,
) -> Result<ExportStats, String> {
    let dest = local.join(slug);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    let stats = export_site(folder, &dest, comments);
    if stats.is_err() {
        let _ = fs::remove_dir_all(&dest); // don't leave a half-written share
    }
    stats
}

fn create_share_impl(
    folder: String,
    expires_days: Option<u32>,
    comments: bool,
) -> Result<ShareResult, String> {
    let src = Path::new(&folder);
    if !src.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }
    let _guard = repo_lock();
    let reg = load_registry()?;
    if reg.shares.iter().any(|s| s.folder == folder) {
        return Err("this folder is already shared — use update instead".into());
    }
    let (local, owner) = ensure_repo()?;
    let comments_cfg = if comments {
        Some(setup_comments(&format!("{owner}/{REPO_NAME}"))?)
    } else {
        None
    };
    sync_repo(&local)?;
    let slug = gen_slug();
    let stats = export_into(src, &local, &slug, comments_cfg.as_ref())?;
    let pushed = publish(&local, &format!("share {slug}"))?;
    let entry = ShareEntry {
        folder: folder.clone(),
        slug: slug.clone(),
        repo: format!("{owner}/{REPO_NAME}"),
        url: format!("https://{owner}.github.io/{REPO_NAME}/{slug}/"),
        created: now(),
        expires: expires_days.map(|d| now() + u64::from(d) * 86_400),
        comments: comments_cfg,
    };
    let mut reg = load_registry()?;
    reg.shares.push(entry.clone());
    save_registry(&reg)?;
    Ok(ShareResult { share: entry, pushed, pages: stats.pages, skipped: stats.skipped })
}

fn update_share_impl(folder: String) -> Result<ShareResult, String> {
    let src = Path::new(&folder);
    if !src.is_dir() {
        return Err(format!("{folder} no longer exists"));
    }
    let _guard = repo_lock();
    let reg = load_registry()?;
    let entry = reg
        .shares
        .iter()
        .find(|s| s.folder == folder)
        .cloned()
        .ok_or("this folder is not shared")?;
    let (local, _) = ensure_repo()?;
    sync_repo(&local)?;
    let stats = export_into(src, &local, &entry.slug, entry.comments.as_ref())?;
    let pushed = publish(&local, &format!("update {}", entry.slug))?;
    Ok(ShareResult { share: entry, pushed, pages: stats.pages, skipped: stats.skipped })
}

fn destroy_share_impl(folder: String) -> Result<(), String> {
    let _guard = repo_lock();
    let reg = load_registry()?;
    let entry = reg
        .shares
        .iter()
        .find(|s| s.folder == folder)
        .cloned()
        .ok_or("this folder is not shared")?;
    let (local, _) = ensure_repo()?;
    sync_repo(&local)?;
    let dir = local.join(&entry.slug);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    publish(&local, &format!("remove {}", entry.slug))?;
    let mut reg = load_registry()?;
    reg.shares.retain(|s| s.folder != folder);
    save_registry(&reg)
}

fn cleanup_expired_impl() -> Result<Vec<String>, String> {
    let reg = load_registry()?;
    let cutoff = now();
    let expired: Vec<ShareEntry> = reg
        .shares
        .iter()
        .filter(|s| s.expires.is_some_and(|e| e <= cutoff))
        .cloned()
        .collect();
    if expired.is_empty() {
        return Ok(vec![]);
    }
    let _guard = repo_lock();
    let (local, _) = ensure_repo()?;
    sync_repo(&local)?;
    for s in &expired {
        let dir = local.join(&s.slug);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
    }
    publish(&local, "remove expired shares")?;
    let mut reg = load_registry()?;
    reg.shares.retain(|s| !s.expires.is_some_and(|e| e <= cutoff));
    save_registry(&reg)?;
    Ok(expired.into_iter().map(|s| s.folder).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real network + real GitHub account: run explicitly with
    /// `cargo test real_share_roundtrip -- --ignored --nocapture`.
    #[test]
    #[ignore = "creates and destroys a real share on the user's GitHub"]
    fn real_share_roundtrip() {
        let dir = std::env::temp_dir().join("text-share-roundtrip");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("hello.md"), "# Hello\n\nshared from a test\n").unwrap();
        let folder = dir.to_string_lossy().into_owned();

        // tolerate a leftover entry from an earlier aborted run
        let _ = destroy_share_impl(folder.clone());

        let created = create_share_impl(folder.clone(), Some(1), false).expect("create");
        println!("created: {}", created.share.url);
        assert!(created.pushed);
        assert!(created.pages >= 1);
        assert!(created.share.url.contains(&created.share.slug));

        let again = update_share_impl(folder.clone()).expect("update");
        assert!(!again.pushed, "unchanged update should be a no-op");

        fs::write(dir.join("hello.md"), "# Hello\n\nedited\n").unwrap();
        let edited = update_share_impl(folder.clone()).expect("update after edit");
        assert!(edited.pushed);

        destroy_share_impl(folder.clone()).expect("destroy");
        let reg = load_registry().unwrap();
        assert!(!reg.shares.iter().any(|s| s.folder == folder));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[tauri::command]
pub async fn create_share(
    folder: String,
    expires_days: Option<u32>,
    comments: bool,
) -> Result<ShareResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_share_impl(folder, expires_days, comments))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_share(folder: String) -> Result<ShareResult, String> {
    tauri::async_runtime::spawn_blocking(move || update_share_impl(folder))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn destroy_share(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || destroy_share_impl(folder))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cleanup_expired_shares() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(cleanup_expired_impl)
        .await
        .map_err(|e| e.to_string())?
}
