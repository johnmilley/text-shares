use crate::themes::config_dir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;

/// Comment header written at the top of config.toml on every save, so the
/// file documents itself (the serializer alone would strip comments).
const HEADER: &str = r#"# text — config
#
# Ctrl+, opens the settings panel, which manages this file. It also stays
# hand-editable ("open config.toml" in settings) and applies when saved.
# Values:
#
#   theme         a file stem from the themes folder (~/.config/text/themes);
#                 the "theme" key below opens a picker with all of them
#   font_size     editor text size      (fixed keys: Ctrl+= / Ctrl+-)
#   ui_font_size  sidebar/dialog size   (fixed keys: Ctrl+Shift+= / Ctrl+Shift+-,
#                 Ctrl+0 resets both)
#   editor_font   CSS font stack for the editor; "" uses the theme's font.
#                 The "editor_font" key (Ctrl+Shift+E) opens a curated picker.
#   editor_margin horizontal space (px) between the editor text and the
#                 window edge. Small by default so wide data fits; size the
#                 window to taste. Zen mode centers a column regardless.
#   line_numbers  show a line-number gutter in the editor (off by default)
#   highlight_line subtly tint the cursor's line (on by default)
#   vim_mode      modal editing via codemirror-vim
#   root          last opened notes folder (managed by the app)
#   recent_roots  folder-switcher history (managed by the app)
#   pinned_roots  folders kept at the top of the switcher (pin/unpin there)
#   daily_dir     daily notes folder, relative to the root
#                 (notes are created as daily_dir/YYYY/MM/YYYY-MM-DD.md)
#   image_dir     where dropped/pasted images land, relative to the root
#                 ("" = the root itself)
#
# [keys] rebinds the app shortcuts. Format: modifiers + key, e.g.
# "ctrl+shift+f", "ctrl+,", "alt+d". Modifiers: ctrl, shift, alt.
# The "shortcuts" action (Ctrl+/ by default) shows the full reference.
# Editor keys are fixed: Ctrl+B/I bold/italic, Ctrl+Shift+X strikethrough,
# Ctrl+K link, Ctrl+1..6 headings, Ctrl+Enter follow wikilink.
"#;

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// theme id (file stem in the themes dir)
    pub theme: String,
    pub font_size: u16,
    pub ui_font_size: u16,
    /// editor font stack override; "" = use the theme's editor font
    pub editor_font: String,
    /// horizontal space (px) between the editor text and the window edge
    pub editor_margin: u16,
    /// show a line-number gutter in the editor
    pub line_numbers: bool,
    /// subtly tint the line the cursor is on
    pub highlight_line: bool,
    pub vim_mode: bool,
    /// last opened notes folder
    pub root: Option<String>,
    /// recently opened folders, newest first (for the folder switcher)
    pub recent_roots: Vec<String>,
    /// folders pinned to the top of the folder switcher (managed by the app)
    pub pinned_roots: Vec<String>,
    /// folder for daily notes, relative to the notes root
    pub daily_dir: String,
    /// where dropped/pasted images land, relative to the notes root
    /// ("" = the root itself)
    pub image_dir: String,
    pub sidebar_width: u16,
    /// app-level shortcut overrides: action -> "ctrl+shift+x" style combo
    pub keys: BTreeMap<String, String>,
}

fn default_keys() -> BTreeMap<String, String> {
    [
        ("quick_switch", "ctrl+p"),
        ("new_note", "ctrl+n"),
        ("daily_note", "ctrl+shift+d"),
        ("open_folder", "ctrl+o"),
        ("switch_folder", "ctrl+shift+o"),
        ("search", "ctrl+shift+f"),
        ("backlinks", "ctrl+shift+b"),
        ("theme", "ctrl+shift+t"),
        ("editor_font", "ctrl+shift+e"),
        ("share", "ctrl+shift+s"),
        ("config", "ctrl+,"),
        ("shortcuts", "ctrl+/"),
        ("toggle_sidebar", "ctrl+\\"),
        ("new_tab", "ctrl+t"),
        ("close_tab", "ctrl+w"),
        ("next_tab", "ctrl+tab"),
        ("prev_tab", "ctrl+shift+tab"),
        ("new_window", "ctrl+shift+n"),
        ("split", "ctrl+shift+\\"),
        ("preview", "ctrl+shift+m"),
        ("focus_tree", "ctrl+e"),
        ("calendar", "ctrl+shift+c"),
        ("zen", "alt+z"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// (action, old default, new default): stored combos still equal to a
/// retired default move to the new one on load, so rebound defaults don't
/// strand users on stale keys (their own custom combos are left alone).
const KEY_MIGRATIONS: &[(&str, &str, &str)] = &[
    ("daily_note", "ctrl+t", "ctrl+shift+d"),
    ("new_tab", "ctrl+shift+n", "ctrl+t"),
    ("new_window", "ctrl+alt+n", "ctrl+shift+n"),
];

impl Default for Config {
    fn default() -> Self {
        Config {
            theme: "text-dark".into(),
            font_size: 15,
            ui_font_size: 13,
            editor_font: "".into(),
            editor_margin: 24,
            line_numbers: false,
            highlight_line: true,
            vim_mode: false,
            root: None,
            recent_roots: vec![],
            pinned_roots: vec![],
            daily_dir: "daily".into(),
            image_dir: "".into(),
            sidebar_width: 240,
            keys: default_keys(),
        }
    }
}

#[tauri::command]
pub fn load_config() -> Result<Config, String> {
    let path = config_dir()?.join("config.toml");
    let mut config: Config = match fs::read_to_string(&path) {
        Ok(src) => toml::from_str(&src).map_err(|e| e.to_string())?,
        Err(_) => Config::default(),
    };
    for (action, old, new) in KEY_MIGRATIONS {
        if config.keys.get(*action).is_some_and(|c| c == old) {
            config.keys.insert((*action).to_string(), (*new).to_string());
        }
    }
    Ok(config)
}

#[tauri::command]
pub fn save_config(config: Config) -> Result<(), String> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let src = toml::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(dir.join("config.toml"), format!("{HEADER}\n{src}")).map_err(|e| e.to_string())
}
