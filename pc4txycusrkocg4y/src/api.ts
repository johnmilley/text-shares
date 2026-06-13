import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  mtime: number;
  children: Entry[] | null;
}

export interface FileContent {
  content: string;
  mtime: number;
}

export interface WriteResult {
  mtime: number;
  conflict: boolean;
}

export interface Hit {
  path: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  css: string | null;
}

export interface Config {
  theme: string;
  font_size: number;
  ui_font_size: number;
  editor_font: string;
  editor_margin: number;
  line_numbers: boolean;
  highlight_line: boolean;
  vim_mode: boolean;
  root: string | null;
  recent_roots: string[];
  pinned_roots: string[];
  daily_dir: string;
  image_dir: string;
  sidebar_width: number;
  keys: Record<string, string>;
}

export interface ImageContent {
  base64: string;
  mtime: number;
}

export const listTree = (root: string) => invoke<Entry[]>("list_tree", { root });
export const readFile = (path: string) => invoke<FileContent>("read_file", { path });
export const readImage = (path: string) => invoke<ImageContent>("read_image", { path });
export const writeFile = (path: string, content: string, expectedMtime: number | null) =>
  invoke<WriteResult>("write_file", { path, content, expectedMtime });
export const statMtime = (path: string) => invoke<number>("stat_mtime", { path });
export const createFile = (path: string) => invoke<void>("create_file", { path });
export const createDir = (path: string) => invoke<void>("create_dir", { path });
export const renamePath = (from: string, to: string) => invoke<void>("rename_path", { from, to });
export const copyPath = (src: string, destDir: string) =>
  invoke<string>("copy_path", { src, destDir });
export const overwriteBase64 = (path: string, base64: string) =>
  invoke<void>("overwrite_base64", { path, base64 });
export const importFile = (src: string, destDir: string) =>
  invoke<string>("import_file", { src, destDir });
export const writeBase64 = (destDir: string, name: string, base64: string) =>
  invoke<string>("write_base64", { destDir, name, base64 });
export const trashPath = (path: string) => invoke<void>("trash_path", { path });
export const searchText = (root: string, query: string) =>
  invoke<Hit[]>("search_text", { root, query });
export const findBacklinks = (root: string, target: string) =>
  invoke<Hit[]>("find_backlinks", { root, target });
export interface CommentsCfg {
  repo: string;
  repo_id: string;
  category: string;
  category_id: string;
}

export interface ShareEntry {
  folder: string;
  slug: string;
  repo: string;
  url: string;
  created: number; // unix seconds
  expires: number | null;
  comments: CommentsCfg | null;
}

export interface ShareStatus {
  entry: ShareEntry | null;
  orphans: ShareEntry[];
}

export interface ShareResult {
  share: ShareEntry;
  pushed: boolean;
  pages: number;
  skipped: string[];
}

export const shareStatus = (folder: string) => invoke<ShareStatus>("share_status", { folder });
export const createShare = (folder: string, expiresDays: number | null, comments: boolean) =>
  invoke<ShareResult>("create_share", { folder, expiresDays, comments });
export const updateShare = (folder: string) => invoke<ShareResult>("update_share", { folder });
export const destroyShare = (folder: string) => invoke<void>("destroy_share", { folder });
export const cleanupShares = () => invoke<string[]>("cleanup_expired_shares");

export interface WindowInit {
  root: string | null;
  file: string | null;
}

export const openWindow = (root: string | null, file: string | null) =>
  invoke<void>("open_window", { root, file });
export const windowInitParams = () => invoke<WindowInit | null>("window_init_params");

export interface TaskItem {
  text: string;
  done: boolean;
  line: number;
}

export interface NoteMeta {
  path: string;
  rel: string;
  name: string;
  mtime: number;
  tags: string[];
  fields: Record<string, string>;
  tasks: TaskItem[];
}

/** Note metadata (frontmatter, tags, tasks) for dataview query blocks. */
export const collectNotes = (root: string) => invoke<NoteMeta[]>("collect_notes", { root });

/** Markdown → preview HTML (wikilinks/embeds left for the app to resolve). */
export const renderPreview = (text: string) => invoke<string>("render_preview", { text });

export const listThemes = () => invoke<Theme[]>("list_themes");
export const themesDirPath = () => invoke<string>("themes_dir_path");
export const loadConfig = () => invoke<Config>("load_config");
export const saveConfig = (config: Config) => invoke<void>("save_config", { config });
export const watchRoot = (root: string) => invoke<void>("watch_root", { root });
