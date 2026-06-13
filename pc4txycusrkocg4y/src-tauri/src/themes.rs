use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// Bundled themes, written into the user themes dir on first run so every
/// theme is an editable file on disk. (name, toml source)
const BUNDLED: &[(&str, &str)] = &[
    ("text-dark", include_str!("../themes/text-dark.toml")),
    ("text-light", include_str!("../themes/text-light.toml")),
    ("night-owl", include_str!("../themes/night-owl.toml")),
    ("monokai-calm", include_str!("../themes/monokai-calm.toml")),
    ("rosewater", include_str!("../themes/rosewater.toml")),
    ("fjord", include_str!("../themes/fjord.toml")),
    ("solarized-light", include_str!("../themes/solarized-light.toml")),
    ("sepia", include_str!("../themes/sepia.toml")),
    ("nord", include_str!("../themes/nord.toml")),
    ("everforest", include_str!("../themes/everforest.toml")),
    ("zenburn", include_str!("../themes/zenburn.toml")),
    ("catppuccin-mocha", include_str!("../themes/catppuccin-mocha.toml")),
    ("catppuccin-macchiato", include_str!("../themes/catppuccin-macchiato.toml")),
    ("catppuccin-frappe", include_str!("../themes/catppuccin-frappe.toml")),
    ("catppuccin-latte", include_str!("../themes/catppuccin-latte.toml")),
    ("solarized-dark", include_str!("../themes/solarized-dark.toml")),
    ("dracula", include_str!("../themes/dracula.toml")),
    ("gruvbox", include_str!("../themes/gruvbox.toml")),
    ("github-light", include_str!("../themes/github-light.toml")),
    ("tokyo-night", include_str!("../themes/tokyo-night.toml")),
    ("oceanic-next", include_str!("../themes/oceanic-next.toml")),
    ("ayu-mirage", include_str!("../themes/ayu-mirage.toml")),
    ("cobalt2", include_str!("../themes/cobalt2.toml")),
    ("midnight", include_str!("../themes/midnight.toml")),
    ("dawn", include_str!("../themes/dawn.toml")),
    ("classic-paper", include_str!("../themes/classic-paper.toml")),
    ("dark-academia", include_str!("../themes/dark-academia.toml")),
    ("ia-writer", include_str!("../themes/ia-writer.toml")),
    ("terminal-amber", include_str!("../themes/terminal-amber.toml")),
    ("cyberpunk-green", include_str!("../themes/cyberpunk-green.toml")),
    ("gruvbox-light", include_str!("../themes/gruvbox-light.toml")),
    ("everforest-light", include_str!("../themes/everforest-light.toml")),
    ("nord-light", include_str!("../themes/nord-light.toml")),
    ("tokyo-day", include_str!("../themes/tokyo-day.toml")),
    ("one-light", include_str!("../themes/one-light.toml")),
];

pub fn config_dir() -> Result<PathBuf, String> {
    Ok(dirs::config_dir().ok_or("no config directory")?.join("text"))
}

fn themes_dir() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("themes"))
}

#[derive(Deserialize)]
struct ThemeFile {
    name: String,
    #[serde(default)]
    dark: bool,
    #[serde(default)]
    colors: BTreeMap<String, String>,
    #[serde(default)]
    fonts: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub dark: bool,
    pub colors: BTreeMap<String, String>,
    pub fonts: BTreeMap<String, String>,
    /// contents of an optional sibling <id>.css escape-hatch file
    pub css: Option<String>,
}

fn seed_bundled(dir: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for (id, src) in BUNDLED {
        let path = dir.join(format!("{id}.toml"));
        if !path.exists() {
            fs::write(&path, src).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// All themes from ~/.config/text/themes/*.toml, seeding the bundled set
/// first. A sibling <id>.css file is attached verbatim if present.
#[tauri::command]
pub fn list_themes() -> Result<Vec<Theme>, String> {
    let dir = themes_dir()?;
    seed_bundled(&dir)?;
    let mut themes = vec![];
    for item in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        let id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let src = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed: ThemeFile = match toml::from_str(&src) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("theme {id}: {e}");
                continue;
            }
        };
        let css = fs::read_to_string(dir.join(format!("{id}.css"))).ok();
        themes.push(Theme {
            id,
            name: parsed.name,
            dark: parsed.dark,
            colors: parsed.colors,
            fonts: parsed.fonts,
            css,
        });
    }
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(themes)
}

#[tauri::command]
pub fn themes_dir_path() -> Result<String, String> {
    let dir = themes_dir()?;
    seed_bundled(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}
