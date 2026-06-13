use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// One watcher per watched root, so windows showing different folders don't
/// steal each other's watcher. Re-watching a root replaces its entry (the
/// dropped watcher's debounce thread exits on its own).
#[derive(Default)]
pub struct WatcherState(pub Mutex<HashMap<String, RecommendedWatcher>>);

/// Watch a notes root and emit a debounced "fs:changed" event with the
/// affected paths — broadcast to every window; each frontend ignores paths
/// outside its own root. Used to refresh the tree and detect external edits
/// to the open file (e.g. Dropbox sync).
#[tauri::command]
pub fn watch_root(
    app: AppHandle,
    state: State<'_, WatcherState>,
    root: String,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Vec<String>>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            // Access events fire when files are merely *read* — forwarding
            // them makes opening a file look like an external change, which
            // re-opens it, which reads it again: an endless reload loop.
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.ends_with(".text-tmp"))
                .collect();
            if !paths.is_empty() {
                let _ = tx.send(paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state.0.lock().unwrap().insert(root, watcher);

    std::thread::spawn(move || {
        // Debounce: collect events for 300ms after the first one, then emit.
        while let Ok(first) = rx.recv() {
            let mut paths = first;
            let deadline = std::time::Instant::now() + Duration::from_millis(300);
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(more) => paths.extend(more),
                    Err(_) => break,
                }
            }
            paths.sort();
            paths.dedup();
            let _ = app.emit("fs:changed", paths);
        }
    });

    Ok(())
}
