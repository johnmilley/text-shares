import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { EditorState } from "@codemirror/state";
import * as api from "./api";
import "./fonts";
import { Editor, type NoteRef } from "./editor";
import { applyTheme, setEditorFont, setEditorMargin, setFontSize, setUiFontSize } from "./theme";
import { closeModal, confirmBox, infoBox, pick, type PickerItem, promptText } from "./modal";
import { openSettings } from "./settings";
import { openShareDialog } from "./share";
import { bumpPdfZoom, closePdfDoc, initPdfView, isPdfFile, openPdfDoc, resetPdfZoom } from "./pdf";
import {
  invalidateImage,
  isAudioFile,
  isVideoFile,
  isViewableImage,
  loadAudio,
  loadImage,
} from "./images";
import { comboCandidates } from "./keys";
import { openCalendar } from "./calendar";
import { initPreview, previewOn, refreshPreview, schedulePreview, setPreview } from "./preview";
import { DEMO_FILE, DEMO_NOTE } from "./demo";
import type { NoteMeta } from "./api";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

// ---------------------------------------------------------------- state

let config: api.Config;
let themes: api.Theme[] = [];
let root: string | null = null;
let tree: api.Entry[] = [];
let allFiles: { rel: string; path: string; conflicted: boolean }[] = [];
let notes: NoteRef[] = [];

let currentPath: string | null = null;
let currentMtime: number | null = null;
let viewingImage = false;
let viewingAudio = false;
let viewingPdf = false;
let tableMode = true; // csv/tsv files open as a table until toggled off
let dirty = false;
let saving = false;
let autosaveTimer: number | undefined;
let searchTimer: number | undefined;

let editor: Editor;

// localStorage is shared between windows — only the main window persists
// its session (tabs, last file); spawned windows are ephemeral.
const isMain = getCurrentWindow().label === "main";

const isMac = /Mac/i.test(navigator.platform);

/** Editor state stashed when a text-file tab is backgrounded. */
interface TabSnap {
  path: string;
  mtime: number; // disk mtime the snapshot was taken at (-1 = unknown)
  dirty: boolean; // snapshot holds unsaved edits (save failed/conflicted)
  state: EditorState;
  scrollTop: number;
}

/** A backgrounded tab's split-pane file + editor state (mirrors TabSnap). */
interface Pane2Snap {
  path: string;
  mtime: number | null;
  dirty: boolean;
  state: EditorState;
  scrollTop: number;
}

interface Tab {
  path: string | null; // null = empty tab (welcome screen)
  back: string[]; // per-tab nav history (Alt+← / Alt+→)
  fwd: string[];
  snap?: TabSnap;
  // each tab carries its own secondary layout: a split pane (mode + the file
  // shown there) and whether the markdown preview is open. Restored when the
  // tab comes back to the foreground.
  split: "off" | "v" | "h";
  pane2?: Pane2Snap;
  previewOn: boolean;
}

const blankTab = (path: string | null = null): Tab => ({
  path,
  back: [],
  fwd: [],
  split: "off",
  previewOn: false,
});

let tabs: Tab[] = [blankTab()];
let active = 0;
const tab = () => tabs[active];

// split pane: a second, text-only editor beside (or below) the main pane.
// Tabs and media views always belong to pane 1; pane 2 is for referencing
// or editing one other note alongside. `split`/`pane2*`/preview below are the
// *currently displayed* secondary state; each tab stashes its own copy on
// switch (stashSecondary) and restores it on return (restoreSecondary).
let split: "off" | "v" | "h" = "off";
let focusedPane: 1 | 2 = 1;
let editor2: Editor | null = null;
let pane2Path: string | null = null;
let pane2Mtime: number | null = null;
let pane2Dirty = false;
let pane2Saving = false;
let pane2SaveTimer: number | undefined;

const expanded = new Set<string>(
  JSON.parse(localStorage.getItem("text.expanded") ?? "[]"),
);

// ---------------------------------------------------------------- helpers

const rel = (path: string) =>
  root && path.startsWith(root) ? path.slice(root.length).replace(/^\//, "") : path;

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

const isNote = (name: string) => /\.(md|markdown|mdown)$/i.test(name);

// Faint filetype glyphs in the tree (à la VS Code / Scrivener) — just enough
// to tell notes from images/pdfs/code at a glance. Inner markup per category;
// the wrapping <svg> and the muted colour come from renderEntry/CSS.
const ICON_PATHS: Record<string, string> = {
  note: '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3" stroke-linejoin="round"/><path d="M6 8h5M6 10.5h5" stroke-linecap="round"/>',
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="6.5" r="1"/><path d="M3 11l3-2.5 2.5 2 2-1.5L13 11" stroke-linejoin="round"/>',
  pdf: '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3" stroke-linejoin="round"/><path d="M6 11.5h4" stroke-linecap="round"/>',
  audio: '<path d="M6 10V4l6-1.2v6" /><circle cx="4.5" cy="10.5" r="1.6"/><circle cx="10.5" cy="8.8" r="1.6"/>',
  video: '<rect x="2.5" y="4" width="11" height="8" rx="1"/><path d="M7 6.5l3 1.5-3 1.5z" stroke-linejoin="round"/>',
  code: '<path d="M6 5.5L3 8l3 2.5M10 5.5L13 8l-3 2.5" stroke-linecap="round" stroke-linejoin="round"/>',
  file: '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3" stroke-linejoin="round"/>',
};

function fileIconKind(name: string): keyof typeof ICON_PATHS {
  if (isNote(name)) return "note";
  if (isPdfFile(name)) return "pdf";
  if (isViewableImage(name) || /\.svg$/i.test(name)) return "image";
  if (isAudioFile(name)) return "audio";
  if (isVideoFile(name)) return "video";
  if (/\.(js|ts|jsx|tsx|py|rs|go|c|h|cpp|java|rb|sh|css|html?|json|toml|ya?ml|sql|lua|php)$/i.test(name))
    return "code";
  return "file";
}

function fileIcon(name: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tree-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.2");
  svg.innerHTML = ICON_PATHS[fileIconKind(name)];
  return svg;
}

const isTable = (name: string) => /\.(csv|tsv)$/i.test(name);

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function flatten(entries: api.Entry[]) {
  allFiles = [];
  notes = [];
  const walk = (items: api.Entry[]) => {
    for (const item of items) {
      if (item.is_dir) {
        if (item.children) walk(item.children);
      } else {
        allFiles.push({
          rel: rel(item.path),
          path: item.path,
          conflicted: /conflicted copy/i.test(item.name),
        });
        if (isNote(item.name)) notes.push({ name: stem(item.name), path: item.path });
      }
    }
  };
  walk(entries);
}

// ---------------------------------------------------------------- issue bar

// the status bar at the bottom of the editor — only visible when something
// needs attention (save conflicts, failed operations, missing files)

const issueBar = $("#status");
const issueText = $("#status-text");
const issueActions = $("#status-actions");

function showIssue(text: string, actions: { label: string; run: () => void }[]) {
  issueText.textContent = text;
  issueActions.replaceChildren(
    ...actions.map(({ label, run }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        hideIssue();
        run();
      });
      return b;
    }),
  );
  issueBar.hidden = false;
}

const hideIssue = () => {
  issueBar.hidden = true;
};

// ---------------------------------------------------------------- title / table chip

const tableShown = () => !$("#table-view").hidden;

function updateStatus() {
  const shown = focusedPane === 2 && pane2Path ? pane2Path : currentPath;
  const title = shown ? `text — ${rel(shown)}` : "text";
  document.title = title;
  $("#titlebar-title").textContent = title;
  const tableBtn = $("#btn-table");
  tableBtn.hidden = !currentPath || !isTable(currentPath);
  tableBtn.textContent = tableShown() ? "edit as text" : "view as table";
  // unsaved-edits dot on the active tab, without rebuilding the tab bar
  document.querySelector("#tabs .tab.current")?.classList.toggle("dirty", dirty);
}

// ---------------------------------------------------------------- file tree

const treeEl = $("#tree");
const entryByPath = new Map<string, api.Entry>();
const rowByPath = new Map<string, HTMLElement>();

function renderTree() {
  entryByPath.clear();
  rowByPath.clear();
  treeEl.replaceChildren(...tree.map((e) => renderEntry(e, 0)));
}

function renderEntry(entry: api.Entry, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "tree-row" + (entry.is_dir ? " dir" : "");
  row.style.paddingLeft = `${10 + depth * 14}px`;
  row.dataset.path = entry.path;
  if (entry.path === currentPath) row.classList.add("current");
  entryByPath.set(entry.path, entry);
  rowByPath.set(entry.path, row);

  if (!entry.is_dir) row.appendChild(fileIcon(entry.name));

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = entry.is_dir
    ? (expanded.has(entry.path) ? "▾ " : "▸ ") + entry.name
    : isNote(entry.name)
      ? stem(entry.name)
      : entry.name;
  row.appendChild(label);
  if (!entry.is_dir && /conflicted copy/i.test(entry.name)) {
    row.classList.add("conflicted");
    row.title = "Dropbox conflicted copy";
  }

  const wrap = document.createElement("div");
  wrap.appendChild(row);

  if (entry.is_dir && expanded.has(entry.path) && entry.children) {
    for (const child of entry.children) wrap.appendChild(renderEntry(child, depth + 1));
  }
  return wrap;
}

/** Mark the open file in the tree without rebuilding it. */
function setCurrentRow(path: string | null) {
  for (const [p, row] of rowByPath) row.classList.toggle("current", p === path);
}

function entryAt(e: Event): api.Entry | undefined {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
  return row?.dataset.path ? entryByPath.get(row.dataset.path) : undefined;
}

// Activate rows on mousedown, delegated from the container: it reacts a beat
// faster than click and survives the tree being re-rendered mid-press (a
// rebuild between mousedown and mouseup would otherwise swallow the click).
treeEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const entry = entryAt(e);
  if (!entry) return;
  e.preventDefault();
  beginTreeDrag(entry, e); // arms a possible drag; activation below still runs
  if (entry.is_dir) {
    expanded.has(entry.path) ? expanded.delete(entry.path) : expanded.add(entry.path);
    localStorage.setItem("text.expanded", JSON.stringify([...expanded]));
    renderTree();
  } else if (e.ctrlKey || e.metaKey) {
    void newTab(entry.path);
  } else {
    void openFile(entry.path);
  }
});
// middle-click a file → open it in a new tab
treeEl.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const entry = entryAt(e);
  if (entry && !entry.is_dir) {
    e.preventDefault();
    void newTab(entry.path);
  }
});
treeEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showContextMenu(e, entryAt(e));
});

// ------------------------------------------------------ tree keyboard nav
// Ctrl+E focuses the tree; arrows walk the visible rows, Enter opens (and
// returns focus to the editor), Escape bails out. No mouse required.

const persistExpanded = () =>
  localStorage.setItem("text.expanded", JSON.stringify([...expanded]));

/** Row paths in display order (rowByPath fills in render order). */
const visibleTreePaths = () => [...rowByPath.keys()];

let treeSel: string | null = null;

function markTreeSel(path: string | null) {
  treeSel = path;
  for (const [p, row] of rowByPath) row.classList.toggle("kbd-sel", p === path);
  if (path) rowByPath.get(path)?.scrollIntoView({ block: "nearest" });
}

function focusTree() {
  showPane("files");
  const paths = visibleTreePaths();
  if (!paths.length) return;
  markTreeSel(
    treeSel && rowByPath.has(treeSel)
      ? treeSel
      : currentPath && rowByPath.has(currentPath)
        ? currentPath
        : paths[0],
  );
  treeEl.focus();
}

treeEl.addEventListener("keydown", (e) => {
  const paths = visibleTreePaths();
  if (!paths.length) return;
  const i = treeSel ? paths.indexOf(treeSel) : -1;
  const entry = treeSel ? entryByPath.get(treeSel) : undefined;
  const move = (to: number) =>
    markTreeSel(paths[Math.min(Math.max(to, 0), paths.length - 1)]);
  const setExpanded = (path: string, open: boolean) => {
    open ? expanded.add(path) : expanded.delete(path);
    persistExpanded();
    renderTree();
    markTreeSel(treeSel);
  };
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(i + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(i - 1);
      break;
    case "Home":
      e.preventDefault();
      move(0);
      break;
    case "End":
      e.preventDefault();
      move(paths.length - 1);
      break;
    case "ArrowRight":
      e.preventDefault();
      if (!entry) break;
      if (entry.is_dir && !expanded.has(entry.path)) setExpanded(entry.path, true);
      else if (entry.is_dir) move(i + 1); // already open — step inside
      break;
    case "ArrowLeft":
      e.preventDefault();
      if (entry?.is_dir && expanded.has(entry.path)) setExpanded(entry.path, false);
      else if (treeSel) {
        const parent = parentOf(treeSel);
        if (rowByPath.has(parent)) markTreeSel(parent);
      }
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      if (!entry) break;
      if (entry.is_dir) setExpanded(entry.path, !expanded.has(entry.path));
      else void openFile(entry.path); // openFile hands focus to the editor
      break;
    case "Escape":
      e.preventDefault();
      markTreeSel(null);
      editor.focus();
      break;
  }
});
treeEl.addEventListener("blur", () => markTreeSel(null));

// Pointer-based drag to move tree entries between folders (HTML5 drag-and-drop
// is unreliable inside Tauri webviews when native file drop is enabled).
// Armed on every row mousedown; becomes a drag once the pointer travels a bit.
function beginTreeDrag(entry: api.Entry, e: MouseEvent) {
  const startX = e.clientX;
  const startY = e.clientY;
  const wasExpanded = expanded.has(entry.path);
  let ghost: HTMLElement | null = null;
  let target: string | null = null;

  const setTarget = (t: string | null) => {
    document.querySelector(".drop-into")?.classList.remove("drop-into");
    target = t;
    if (t === null) return;
    (t === root ? treeEl : (rowByPath.get(t) ?? treeEl)).classList.add("drop-into");
  };

  // dir under the pointer: a dir row itself, a file row's parent, or the
  // tree background for the root — null when the move would be a no-op
  const targetAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || !root) return null;
    const row = el.closest<HTMLElement>(".tree-row");
    let dest: string | null = null;
    if (row?.dataset.path) {
      const over = entryByPath.get(row.dataset.path);
      if (over) dest = over.is_dir ? over.path : parentOf(over.path);
    } else if (el.closest("#pane-files")) {
      dest = root;
    }
    if (!dest || dest === parentOf(entry.path)) return null;
    if (dest === entry.path || dest.startsWith(entry.path + "/")) return null;
    return dest;
  };

  const move = (ev: MouseEvent) => {
    if (!ghost) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
      // the arming mousedown already toggled a dir — put it back
      if (entry.is_dir && expanded.has(entry.path) !== wasExpanded) {
        wasExpanded ? expanded.add(entry.path) : expanded.delete(entry.path);
        localStorage.setItem("text.expanded", JSON.stringify([...expanded]));
        renderTree();
      }
      ghost = document.createElement("div");
      ghost.id = "drag-ghost";
      ghost.textContent = entry.name;
      document.body.appendChild(ghost);
      document.body.classList.add("tree-dragging");
    }
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY + 8}px`;
    setTarget(targetAt(ev.clientX, ev.clientY));
  };

  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("tree-dragging");
    const dest = target;
    setTarget(null);
    if (ghost && dest) void movePath(entry, dest);
    ghost?.remove();
  };

  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

async function movePath(entry: api.Entry, destDir: string) {
  const to = `${destDir}/${entry.name}`;
  try {
    await api.renamePath(entry.path, to);
    if (currentPath && (currentPath === entry.path || currentPath.startsWith(entry.path + "/"))) {
      currentPath = to + currentPath.slice(entry.path.length);
      rememberFile(currentPath);
    }
    remapTabs(entry.path, to);
    if (expanded.delete(entry.path)) {
      expanded.add(to);
      localStorage.setItem("text.expanded", JSON.stringify([...expanded]));
    }
    await refreshTree();
    setCurrentRow(currentPath);
    updateStatus();
  } catch (err) {
    showIssue(`move failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

/** The last "copy" from the tree context menu, awaiting a paste. */
let copiedEntry: { path: string; name: string } | null = null;

async function pasteInto(destDir: string) {
  if (!copiedEntry) return;
  try {
    await api.copyPath(copiedEntry.path, destDir);
    await refreshTree();
  } catch (err) {
    showIssue(`paste failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

async function duplicateEntry(entry: api.Entry) {
  try {
    await api.copyPath(entry.path, parentOf(entry.path));
    await refreshTree();
  } catch (err) {
    showIssue(`duplicate failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

/** Build and show a context menu at the pointer. */
function openCtxMenu(e: MouseEvent, items: [string, () => void][]) {
  document.getElementById("ctx-menu")?.remove();
  if (!items.length) return;
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  for (const [label, run] of items) {
    const item = document.createElement("div");
    item.textContent = label;
    // mousedown, not click: the document-level close handler below also fires
    // on mousedown and would remove the menu before a click could complete.
    item.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      menu.remove();
      run();
    });
    menu.appendChild(item);
  }
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener("mousedown", close, { once: true }));
}

/** Right-click menu for a tree row, or for the tree background (no entry). */
function showContextMenu(e: MouseEvent, entry: api.Entry | undefined) {
  const items: [string, () => void][] = [];
  const add = (label: string, run: () => void) => items.push([label, run]);
  if (entry) {
    if (entry.is_dir) {
      add("new note inside", () => void newNote(entry.path));
      add("new folder inside", () => void newFolder(entry.path));
      add("generate table of contents", () => void generateToc(entry.path));
      add("share…", () => openShareDialog(entry.path));
    } else {
      add("open in new tab", () => void newTab(entry.path));
      add("open in new window", () => {
        if (root) void api.openWindow(root, entry.path).catch(() => {});
      });
    }
    add("rename", () => void renameEntry(entry));
    add("copy", () => (copiedEntry = { path: entry.path, name: entry.name }));
    add("duplicate", () => void duplicateEntry(entry));
    if (copiedEntry) {
      const dest = entry.is_dir ? entry.path : parentOf(entry.path);
      add(`paste "${copiedEntry.name}"`, () => void pasteInto(dest));
    }
    add("reveal in file manager", () => void revealItemInDir(entry.path));
    add("delete", () => void deleteEntry(entry));
  } else if (root) {
    add("new note", () => void newNote());
    add("new folder", () => void newFolder());
    add("generate table of contents", () => void generateToc(root!));
    add("share this folder…", shareRoot);
    if (copiedEntry) add(`paste "${copiedEntry.name}"`, () => void pasteInto(root!));
  }
  openCtxMenu(e, items);
}

/** Write "TOC.md" into `dir`, a nested list of wikilinks to everything
 * inside, and open it. Re-running refreshes the listing. */
async function generateToc(dir: string) {
  if (!root) return;
  const entries = dir === root ? tree : (entryByPath.get(dir)?.children ?? []);
  const title = dir.split("/").pop() ?? "notes";
  const lines: string[] = [`# ${title} — contents`, ""];
  const walk = (items: api.Entry[], depth: number) => {
    for (const item of items) {
      const indent = "  ".repeat(depth);
      if (item.is_dir) {
        lines.push(`${indent}- **${item.name}**`);
        if (item.children) walk(item.children, depth + 1);
      } else if (depth > 0 || item.name !== "TOC.md") {
        lines.push(`${indent}- [[${isNote(item.name) ? stem(item.name) : item.name}]]`);
      }
    }
  };
  walk(entries, 0);
  const path = `${dir}/TOC.md`;
  try {
    await api.createFile(path).catch(() => {}); // may already exist
    await api.writeFile(path, lines.join("\n") + "\n", null);
    await refreshTree();
    await openFile(path);
  } catch (err) {
    showIssue(`TOC failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

// ------------------------------------------------------------- tree sorting

/** Re-order the fetched tree in place. The backend hands us dirs-first,
 * name-ascending; that order stands, except inside the daily-notes folder
 * where date-shaped names (YYYY / MM / YYYY-MM-DD) show latest first. */
function sortTree(entries: api.Entry[], inDaily: boolean) {
  const dailyPath = `${root}/${config.daily_dir}`;
  const dirs = entries.filter((e) => e.is_dir);
  const files = entries.filter((e) => !e.is_dir);
  const datish = (e: api.Entry) => /^\d[\d-]*$/.test(stem(e.name));
  if (inDaily) {
    for (const group of [dirs, files]) {
      group.sort((a, b) => (datish(a) && datish(b) ? b.name.localeCompare(a.name) : 0));
    }
  }
  entries.length = 0;
  entries.push(...dirs, ...files);
  for (const dir of dirs) {
    if (dir.children) sortTree(dir.children, inDaily || dir.path === dailyPath);
  }
}

let treeFingerprint = "";

async function refreshTree() {
  if (!root) return;
  tree = await api.listTree(root);
  sortTree(tree, false);
  flatten(tree);
  // Skip the DOM rebuild when nothing structural changed (autosaves trip the
  // fs watcher constantly); rebuilding mid-interaction eats mouse presses.
  // mtime is excluded — it changes on every save; a reorder it causes under
  // "newest" still shows up as a position change.
  const fingerprint = JSON.stringify(tree, (k, v) => (k === "mtime" ? undefined : v));
  if (fingerprint === treeFingerprint) return;
  treeFingerprint = fingerprint;
  renderTree();
}

// ---------------------------------------------------------------- nav history

// history is per tab, like a browser: each tab remembers where it has been,
// and switching tabs doesn't record anything

let navigating = false; // suppresses recordNav during back/fwd and tab switches

/** Push the file being left onto the active tab's back stack (unless this
 * open *is* a back/forward jump or a tab switch). */
function recordNav(opening: string) {
  if (navigating || !currentPath || currentPath === opening) return;
  const t = tab();
  t.back.push(currentPath);
  if (t.back.length > 100) t.back.shift();
  t.fwd.length = 0;
}

/** Pop the nearest still-existing path; deleted/moved files are skipped. */
function popExisting(stack: string[]): string | undefined {
  let path: string | undefined;
  while ((path = stack.pop()) && !allFiles.some((f) => f.path === path)) {}
  return path;
}

function navigate(from: string[], to: string[]) {
  const path = popExisting(from);
  if (!path) return;
  if (currentPath) to.push(currentPath);
  if (focusedPane !== 1) setFocusedPane(1); // history belongs to pane 1
  navigating = true;
  void openFile(path).finally(() => (navigating = false));
}

const goBack = () => navigate(tab().back, tab().fwd);
const goForward = () => navigate(tab().fwd, tab().back);

// ---------------------------------------------------------------- tabs

const tabName = (path: string) => {
  const name = path.split("/").pop() ?? path;
  return isNote(name) ? stem(name) : name;
};

function renderTabs() {
  $("#tabs").replaceChildren(
    ...tabs.map((t, i) => {
      const el = document.createElement("div");
      el.className = "tab" + (i === active ? " current" : "");
      if (i === active && dirty) el.classList.add("dirty");
      el.dataset.i = String(i);
      if (t.path) el.title = rel(t.path);
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = t.path ? tabName(t.path) : "new tab";
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close tab (Ctrl+W)";
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      close.addEventListener("click", () => void closeTab(i));
      el.append(label, close);
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        beginTabDrag(t, e); // arms a possible drag; the switch still happens
        if (i !== active) void switchTab(i);
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) void closeTab(i);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        tabContextMenu(e, i);
      });
      return el;
    }),
  );
  persistTabs();
}

function persistTabs() {
  if (!isMain) return;
  localStorage.setItem("text.tabs", JSON.stringify(tabs.map((t) => t.path)));
  localStorage.setItem("text.activeTab", String(active));
}

/** Keep the active tab's record in step with what's actually open. */
function syncTab() {
  const t = tab();
  if (t.path !== currentPath) {
    t.path = currentPath;
    t.snap = undefined;
  }
  renderTabs();
}

/** Park the active tab's editor state before switching away from it. The
 * snapshot keeps cursor, scroll, and undo history alive across switches. */
async function stashActiveTab() {
  const t = tab();
  if (dirty) await save(); // a conflict leaves it dirty — the snap carries it
  if (
    currentPath &&
    t.path === currentPath &&
    !viewingImage &&
    !viewingAudio &&
    !viewingPdf
  ) {
    t.snap = { path: currentPath, mtime: currentMtime ?? -1, dirty, ...editor.snapshot() };
  }
  await stashSecondary(t);
}

/** Park the active tab's split + preview state before switching away. Flushes
 * a dirty split pane to disk so a backgrounded tab never holds unsaved edits
 * outside its snapshot. */
async function stashSecondary(t: Tab) {
  t.split = split;
  t.previewOn = previewOn();
  if (split !== "off" && pane2Path && editor2) {
    if (pane2Dirty) await savePane2();
    t.pane2 = {
      path: pane2Path,
      mtime: pane2Mtime,
      dirty: pane2Dirty,
      ...editor2.snapshot(),
    };
  } else {
    t.pane2 = undefined;
  }
}

/** Collapse the live secondary layout to nothing — the clean baseline every
 * `activateTab` starts from. Does not save; callers flush first (stashSecondary
 * on switch, an explicit savePane2 on close). */
function teardownSecondary() {
  window.clearTimeout(pane2SaveTimer);
  split = "off";
  pane2Path = null;
  pane2Mtime = null;
  pane2Dirty = false;
  $("#pane2").hidden = true;
  $("#content").classList.remove("split-h");
  setPreview(false);
  setFocusedPane(1);
}

/** Bring back a tab's split + preview after its pane-1 content is live. */
async function restoreSecondary(t: Tab) {
  setPreview(t.previewOn); // renders against the now-current pane-1 note
  if (t.split === "off") return;
  split = t.split;
  $("#content").classList.toggle("split-h", t.split === "h");
  $("#pane2").hidden = false;
  ensureEditor2();
  if (t.pane2) await restorePane2Snap(t.pane2);
  else emptyPane2();
  // the tab always drives pane 1; the user clicks into pane 2 to edit there
}

/** Restore a split-pane snapshot, reconciling with the file on disk the same
 * way tryRestoreSnap does for pane 1. */
async function restorePane2Snap(s: Pane2Snap) {
  const onDisk = await api.statMtime(s.path).catch(() => null);
  if (onDisk === null) {
    emptyPane2(); // the file vanished while this tab was backgrounded
    return;
  }
  pane2Path = s.path;
  const name = s.path.split("/").pop() ?? s.path;
  if (!s.dirty && onDisk !== s.mtime) {
    // disk moved on under us and we hold no unsaved edits — take disk
    const file = await api.readFile(s.path);
    pane2Mtime = file.mtime;
    pane2Dirty = false;
    ensureEditor2().openDoc(file.content, name);
  } else {
    pane2Mtime = onDisk;
    pane2Dirty = s.dirty;
    ensureEditor2().restoreSnapshot(s, name);
    if (s.dirty) {
      window.clearTimeout(pane2SaveTimer);
      pane2SaveTimer = window.setTimeout(() => void savePane2(), 900);
    }
  }
  $("#pane2-name").textContent = rel(s.path);
}

/** Restore a stashed snapshot if it still matches the file on disk (or holds
 * unsaved edits, which always win — they're the freshest content). */
async function tryRestoreSnap(t: Tab): Promise<boolean> {
  const s = t.snap;
  if (!s || !t.path || s.path !== t.path) return false;
  const onDisk = await api.statMtime(t.path).catch(() => null);
  if (!s.dirty && (onDisk === null || onDisk !== s.mtime)) return false;
  hideIssue();
  hideImageView();
  hideAudioView();
  hidePdfView();
  editor.restoreSnapshot(s, t.path.split("/").pop()!);
  currentPath = t.path;
  currentMtime = onDisk;
  dirty = s.dirty;
  if (s.dirty) scheduleAutosave();
  if (isTable(t.path) && tableMode) showTableView();
  else hideTableView();
  $("#welcome").style.display = "none";
  rememberFile(t.path);
  setCurrentRow(t.path);
  updateStatus();
  void refreshBacklinks();
  refreshPreview();
  editor.focus();
  return true;
}

/** Make the active tab's content live: restore its snapshot or open from
 * disk. Never records nav history. */
async function activateTab() {
  renderTabs();
  // start from a clean secondary baseline, then restore this tab's own split +
  // preview once its pane-1 content is live (below). Callers that reach here
  // without a stash (closeTab) flush the discarded pane 2 themselves.
  teardownSecondary();
  const t = tab();
  navigating = true;
  try {
    if (!t.path) {
      showEmptyTab();
    } else if (!(await tryRestoreSnap(t))) {
      await openFile(t.path);
      if (currentPath !== t.path) {
        // the file is gone (deleted/moved while backgrounded) — empty the tab
        t.path = null;
        t.snap = undefined;
        showEmptyTab();
        renderTabs();
      }
    }
  } finally {
    navigating = false;
  }
  await restoreSecondary(t);
}

async function switchTab(i: number) {
  if (i === active || !tabs[i]) return;
  await stashActiveTab();
  active = i;
  await activateTab();
}

/** Open a new tab right of the active one, on `path` or empty. */
async function newTab(path?: string) {
  await stashActiveTab();
  tabs.splice(active + 1, 0, blankTab(path ?? null));
  active++;
  await activateTab();
}

async function closeTab(i: number) {
  if (!tabs[i]) return;
  // a failed/conflicted save keeps the tab open — closing would lose edits
  if (i === active && dirty && !(await save()) && dirty) return;
  // flush the active tab's split pane before it's discarded (backgrounded tabs
  // were already flushed when they were stashed)
  if (i === active && split !== "off" && pane2Dirty) await savePane2();
  tabs.splice(i, 1);
  if (!tabs.length) {
    // last tab: every window keeps an empty tab — closing the window is the
    // window button's job, never a surprise side effect of closing a tab
    tabs.push(blankTab());
    active = 0;
    return activateTab();
  }
  if (i < active) {
    active--;
    renderTabs();
  } else if (i === active) {
    active = Math.min(i, tabs.length - 1);
    await activateTab();
  } else {
    renderTabs();
  }
}

async function closeOtherTabs(i: number) {
  const keep = tabs[i];
  if (!keep) return;
  const wasActive = tabs[active] === keep;
  // discarding the active tab with a failed save would lose edits
  if (!wasActive && dirty && !(await save()) && dirty) return;
  if (!wasActive && split !== "off" && pane2Dirty) await savePane2();
  tabs = [keep];
  active = 0;
  if (wasActive) renderTabs();
  else await activateTab();
}

/** Move a tab into its own window (drag-out or the tab's context menu). */
async function detachTab(i: number) {
  const t = tabs[i];
  if (!t || !root) return;
  if (i === active && dirty && !(await save()) && dirty) return;
  // moving the only tab out of a spawned window would leave it empty
  const emptiesSpawned = !isMain && tabs.length === 1;
  try {
    await api.openWindow(root, t.path);
  } catch (err) {
    return showIssue(`new window failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
  if (emptiesSpawned) return void getCurrentWindow().close();
  await closeTab(i);
}

function newWindow() {
  if (!root) return;
  api.openWindow(root, null).catch((err) => {
    showIssue(`new window failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  });
}

/** Rewrite tab and split-pane paths after `from` moved to `to`. */
function remapTabs(from: string, to: string) {
  const remap = (p: string | null) =>
    p && (p === from || p.startsWith(from + "/")) ? to + p.slice(from.length) : p;
  for (const t of tabs) {
    t.path = remap(t.path);
    if (t.snap) t.snap.path = remap(t.snap.path)!;
    if (t.pane2) t.pane2.path = remap(t.pane2.path)!;
  }
  pane2Path = remap(pane2Path);
  if (pane2Path) $("#pane2-name").textContent = rel(pane2Path);
  renderTabs();
}

function tabContextMenu(e: MouseEvent, i: number) {
  const items: [string, () => void][] = [["close tab", () => void closeTab(i)]];
  if (tabs.length > 1) items.push(["close other tabs", () => void closeOtherTabs(i)]);
  items.push(["move to new window", () => void detachTab(i)]);
  openCtxMenu(e, items);
}

/** Pointer-based tab drag: within the tab strip it reorders; released
 * anywhere outside the window it detaches the tab into a new window. */
function beginTabDrag(t: Tab, e: MouseEvent) {
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let dropAt: number | null = null;

  const clearMarkers = () => {
    document.querySelector(".tab.drop-before")?.classList.remove("drop-before");
    $("#tabbar").classList.remove("drop-end");
  };

  // insertion index under the pointer, or null when off the tab strip
  const indexAt = (x: number, y: number): number | null => {
    const bar = $("#tabbar").getBoundingClientRect();
    if (y < bar.top - 24 || y > bar.bottom + 24) return null;
    for (const el of document.querySelectorAll<HTMLElement>("#tabs .tab")) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) return Number(el.dataset.i);
    }
    return tabs.length;
  };

  const move = (ev: MouseEvent) => {
    if (!ghost) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
      ghost = document.createElement("div");
      ghost.id = "drag-ghost";
      ghost.textContent = t.path ? tabName(t.path) : "new tab";
      document.body.appendChild(ghost);
      document.body.classList.add("tree-dragging");
    }
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY + 8}px`;
    clearMarkers();
    dropAt = indexAt(ev.clientX, ev.clientY);
    if (dropAt === null) return;
    if (dropAt >= tabs.length) $("#tabbar").classList.add("drop-end");
    else
      document
        .querySelector(`#tabs .tab[data-i="${dropAt}"]`)
        ?.classList.add("drop-before");
  };

  const up = (ev: MouseEvent) => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("tree-dragging");
    clearMarkers();
    const dragged = !!ghost;
    ghost?.remove();
    if (!dragged) return;
    const i = tabs.indexOf(t);
    if (i < 0) return;
    // mouse events keep arriving while the button is held, so coordinates
    // outside the viewport mean the tab was dropped outside the window
    const outside =
      ev.clientX < 0 ||
      ev.clientY < 0 ||
      ev.clientX > window.innerWidth ||
      ev.clientY > window.innerHeight;
    if (outside) return void detachTab(i);
    if (dropAt !== null) reorderTab(i, dropAt);
  };

  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function reorderTab(from: number, to: number) {
  if (to === from || to === from + 1) return; // dropping onto itself
  const current = tabs[active];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to > from ? to - 1 : to, 0, moved);
  active = tabs.indexOf(current);
  renderTabs();
}

// ---------------------------------------------------------------- split pane

function setFocusedPane(n: 1 | 2) {
  if (n === 2 && split === "off") n = 1;
  focusedPane = n;
  $("#pane2").classList.toggle("pane-focused", n === 2);
  setCurrentRow(n === 2 ? pane2Path : currentPath);
  updateStatus();
}

function ensureEditor2(): Editor {
  if (editor2) return editor2;
  editor2 = new Editor($("#editor2-host"), {
    onDocChanged: () => {
      pane2Dirty = true;
      window.clearTimeout(pane2SaveTimer);
      pane2SaveTimer = window.setTimeout(() => void savePane2(), 900);
    },
    onStatus: () => {},
    onSave: () => void savePane2(),
    getNotes: () => notes,
    openWikilink, // focus is in pane 2 when clicked, so it routes back here
    openExternal: (url) => void openUrl(url),
    resolveImage: imageResolver(() => pane2Path),
    importImageBlob,
    onNavBack: () => {},
    onNavForward: () => {},
    dataview: dataviewHost,
  });
  editor2.setVim(config.vim_mode);
  editor2.setLineNumbers(config.line_numbers);
  editor2.setHighlightLine(config.highlight_line);
  return editor2;
}

async function cycleSplit() {
  await setSplit(split === "off" ? "v" : split === "v" ? "h" : "off");
}

async function setSplit(mode: "off" | "v" | "h") {
  if (mode === split) return;
  if (mode === "off") {
    if (pane2Dirty) await savePane2();
    split = "off";
    $("#pane2").hidden = true;
    $("#content").classList.remove("split-h");
    setFocusedPane(1);
    editor.focus();
    return;
  }
  const opening = split === "off";
  split = mode;
  $("#content").classList.toggle("split-h", mode === "h");
  $("#pane2").hidden = false;
  ensureEditor2();
  if (opening) {
    // focus the new pane so the next tree click / quick switch lands here
    setFocusedPane(2);
    editor2!.focus();
  }
}

/** Open a text file in the split pane (full editing + autosave). */
async function openInPane2(path: string) {
  if (path === currentPath) {
    // already open in the main pane — don't edit one file in two views
    setFocusedPane(1);
    editor.focus();
    return;
  }
  if (pane2Dirty) await savePane2();
  hideIssue();
  try {
    const file = await api.readFile(path);
    pane2Path = path;
    pane2Mtime = file.mtime;
    pane2Dirty = false;
    ensureEditor2().openDoc(file.content, path.split("/").pop() ?? path);
    $("#pane2-name").textContent = rel(path);
    setFocusedPane(2);
    editor2!.focus();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

async function savePane2(): Promise<boolean> {
  if (!pane2Path || pane2Saving || !editor2) return true;
  pane2Saving = true;
  try {
    const result = await api.writeFile(pane2Path, editor2.text, pane2Mtime);
    if (result.conflict) {
      showIssue("the split-pane file changed on disk while you were editing it", [
        {
          label: "overwrite with mine",
          run: () => {
            pane2Mtime = null;
            void savePane2();
          },
        },
        { label: "reload from disk", run: () => void reloadPane2() },
      ]);
      return false;
    }
    pane2Mtime = result.mtime;
    pane2Dirty = false;
    if (pane2Path === configFilePath) await applyConfigFromDisk();
    return true;
  } catch (err) {
    showIssue(`save failed (split pane): ${err}`, [{ label: "ok", run: hideIssue }]);
    return false;
  } finally {
    pane2Saving = false;
  }
}

async function reloadPane2() {
  if (!pane2Path || !editor2) return;
  const file = await api.readFile(pane2Path);
  pane2Mtime = file.mtime;
  pane2Dirty = false;
  editor2.replaceContent(file.content);
}

function emptyPane2() {
  pane2Path = null;
  pane2Mtime = null;
  pane2Dirty = false;
  editor2?.openDoc("", "untitled.md");
  $("#pane2-name").textContent = "empty — open a file here";
}

/** External change handling for the split pane (mirrors the main pane). */
async function pane2FsChanged() {
  if (!pane2Path || !editor2) return;
  let onDisk: number | null;
  try {
    onDisk = await api.statMtime(pane2Path);
  } catch {
    showIssue("the split-pane file was deleted or moved on disk", [
      {
        label: "keep my copy (re-save)",
        run: () => {
          pane2Mtime = null;
          void savePane2();
        },
      },
      { label: "close it", run: emptyPane2 },
    ]);
    return;
  }
  if (pane2Mtime !== null && onDisk === pane2Mtime) return;
  if (!pane2Dirty) await reloadPane2();
  else
    showIssue("the split-pane file changed on disk and you have unsaved edits", [
      {
        label: "keep mine (overwrites)",
        run: () => {
          pane2Mtime = null;
          void savePane2();
        },
      },
      { label: "take theirs", run: () => void reloadPane2() },
    ]);
}

// ---------------------------------------------------------------- open/save

/** Only the main window owns the cross-launch "last file" fallback. */
function rememberFile(path: string) {
  if (isMain) localStorage.setItem("text.lastFile", path);
}

async function openFile(path: string) {
  // video never opens in-app — straight handoff to the system player (no
  // tab, no pane focus change, nothing in the editor moves)
  if (isVideoFile(path)) return openVideo(path);
  if (split !== "off") {
    // a file already showing in the split pane: focus it instead of opening
    // the same document in two editors
    if (path === pane2Path) {
      setFocusedPane(2);
      editor2?.focus();
      return;
    }
    // text files land in whichever pane has focus; media always in pane 1
    if (
      focusedPane === 2 &&
      !isViewableImage(path) &&
      !isAudioFile(path) &&
      !isPdfFile(path)
    ) {
      return openInPane2(path);
    }
    if (focusedPane !== 1) setFocusedPane(1);
  }
  if (isViewableImage(path)) return openImage(path);
  if (isAudioFile(path)) return openAudio(path);
  if (isPdfFile(path)) return openPdf(path);
  if (currentPath && dirty) await save();
  hideIssue();
  try {
    const file = await api.readFile(path);
    recordNav(path);
    currentPath = path;
    currentMtime = file.mtime;
    dirty = false;
    hideImageView();
    hideAudioView();
    hidePdfView();
    editor.openDoc(file.content, path.split("/").pop() ?? path);
    if (isTable(path) && tableMode) showTableView();
    else hideTableView();
    $("#welcome").style.display = "none";
    rememberFile(path);
    setCurrentRow(path);
    syncTab();
    updateStatus();
    void refreshBacklinks();
    refreshPreview();
    editor.focus();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

async function openImage(path: string) {
  if (currentPath && dirty && !viewingImage && !viewingAudio && !viewingPdf)
    await save();
  hideIssue();
  try {
    const src = await loadImage(path);
    recordNav(path);
    currentPath = path;
    // tracked so watcher events that aren't real edits don't reload the view
    currentMtime = await api.statMtime(path).catch(() => null);
    dirty = false;
    viewingImage = true;
    hideTableView();
    hideAudioView();
    hidePdfView();
    resetImageTools();
    const img = $<HTMLImageElement>("#image-view img");
    img.src = src;
    $("#image-view").hidden = false;
    $("#welcome").style.display = "none";
    rememberFile(path);
    setCurrentRow(path);
    syncTab();
    updateStatus();
    void refreshBacklinks();
    refreshPreview();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

function hideImageView() {
  viewingImage = false;
  $("#image-view").hidden = true;
}

async function openAudio(path: string) {
  if (currentPath && dirty && !viewingImage && !viewingAudio && !viewingPdf)
    await save();
  hideIssue();
  try {
    const mtime = await api.statMtime(path); // also confirms the file exists
    recordNav(path);
    currentPath = path;
    currentMtime = mtime;
    dirty = false;
    viewingAudio = true;
    hideTableView();
    hideImageView();
    hidePdfView();
    $("#audio-name").textContent = path.split("/").pop() ?? path;
    const audio = $<HTMLAudioElement>("#audio-view audio");
    audio.onerror = () => {
      const code = audio.error ? ` (media error ${audio.error.code})` : "";
      const hint = isMac ? "" : " — a GStreamer codec for this format may be missing";
      showIssue(`playback failed${code}${hint}`, [
        { label: "open in system player", run: () => void openPath(path) },
      ]);
    };
    audio.src = await loadAudio(path);
    $("#audio-view").hidden = false;
    $("#welcome").style.display = "none";
    rememberFile(path);
    setCurrentRow(path);
    syncTab();
    updateStatus();
    void refreshBacklinks();
    refreshPreview();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

function hideAudioView() {
  viewingAudio = false;
  const audio = $<HTMLAudioElement>("#audio-view audio");
  audio.pause();
  $("#audio-view").hidden = true;
}

/** Video goes straight to the system player. In-app playback on Linux is
 * software-decoded (WebKitGTK has no hardware path on this stack) and
 * GStreamer demuxer bugs can abort the whole web process, window and all. */
async function openVideo(path: string) {
  try {
    await api.statMtime(path); // confirms the file exists
    await openPath(path);
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

async function openPdf(path: string) {
  if (currentPath && dirty && !viewingImage && !viewingAudio && !viewingPdf)
    await save();
  hideIssue();
  try {
    const mtime = await api.statMtime(path); // also confirms the file exists
    await openPdfDoc(path);
    recordNav(path);
    currentPath = path;
    currentMtime = mtime;
    dirty = false;
    viewingPdf = true;
    hideTableView();
    hideImageView();
    hideAudioView();
    $("#welcome").style.display = "none";
    rememberFile(path);
    setCurrentRow(path);
    syncTab();
    updateStatus();
    void refreshBacklinks();
    refreshPreview();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

function hidePdfView() {
  viewingPdf = false;
  closePdfDoc();
}

// ---------------------------------------------------------------- image tools

let imgRotation = 0; // degrees, multiples of 90
let imgScale = 1;
let imgPanX = 0; // screen-px pan offset, only meaningful while zoomed in
let imgPanY = 0;

function imageEdited() {
  return imgRotation % 360 !== 0 || imgScale !== 1;
}

function resetImageTools() {
  imgRotation = 0;
  imgScale = 1;
  imgPanX = imgPanY = 0;
  applyImageTools();
}

function applyImageTools() {
  const img = $<HTMLImageElement>("#image-view img");
  // panning only applies while zoomed in; collapse it back otherwise
  if (imgScale <= 1) imgPanX = imgPanY = 0;
  // translate is in screen space so it goes before rotate/scale
  const parts: string[] = [];
  if (imgPanX || imgPanY) parts.push(`translate(${imgPanX}px, ${imgPanY}px)`);
  if (imgRotation) parts.push(`rotate(${imgRotation}deg)`);
  if (imgScale !== 1) parts.push(`scale(${imgScale})`);
  img.style.transform = parts.join(" ");
  img.classList.toggle("pannable", imgScale > 1);
  $("#img-scale").textContent = `${Math.round(imgScale * 100)}%`;
  const edited = imageEdited();
  $("#img-reset").hidden = !edited;
  $("#img-save-copy").hidden = !edited;
  // canvas can only re-encode png/jpeg faithfully — other formats get a copy
  const overwritable = /\.(png|jpe?g)$/i.test(currentPath ?? "");
  $("#img-overwrite").hidden = !edited || !overwritable;
}

/** Render the current rotation/scale to base64 in the file's own format
 * (or PNG for formats canvas can't encode). Returns [base64, extension]. */
function renderEditedImage(): [string, string] {
  const img = $<HTMLImageElement>("#image-view img");
  const w = Math.max(1, Math.round(img.naturalWidth * imgScale));
  const h = Math.max(1, Math.round(img.naturalHeight * imgScale));
  const swap = imgRotation % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((imgRotation * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  const jpeg = /\.jpe?g$/i.test(currentPath ?? "");
  const url = canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92);
  return [url.split(",", 2)[1], jpeg ? "jpg" : "png"];
}

async function saveImageCopy() {
  if (!currentPath) return;
  try {
    const [b64, ext] = renderEditedImage();
    const name = currentPath.split("/").pop()!;
    const saved = await api.writeBase64(
      parentOf(currentPath),
      `${stem(name)} edited.${ext}`,
      b64,
    );
    await refreshTree();
    await openImage(saved);
  } catch (err) {
    showIssue(`save failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

async function overwriteImage() {
  if (!currentPath) return;
  const path = currentPath;
  const ok = await confirmBox(
    `overwrite "${path.split("/").pop()}" with the edited version?`,
    "Overwrite",
  );
  if (!ok) return;
  try {
    const [b64] = renderEditedImage();
    await api.overwriteBase64(path, b64);
    invalidateImage(path);
    await openImage(path);
  } catch (err) {
    showIssue(`overwrite failed: ${err}`, [{ label: "ok", run: hideIssue }]);
  }
}

// ---------------------------------------------------------------- table view

/** Parse comma/tab-separated text, honoring quoted fields. */
function parseDsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else inQuotes = false;
    } else if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      (row = []), (field = "");
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const TABLE_MAX_ROWS = 2000;

function renderTableView() {
  if (!currentPath) return;
  const rows = parseDsv(editor.text, /\.tsv$/i.test(currentPath) ? "\t" : ",");
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const table = document.createElement("table");
  for (const [i, r] of rows.slice(0, TABLE_MAX_ROWS).entries()) {
    const tr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement(i === 0 ? "th" : "td");
      cell.textContent = r[c] ?? "";
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }
  const view = $("#table-view");
  view.replaceChildren(table);
  if (rows.length > TABLE_MAX_ROWS) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = `showing the first ${TABLE_MAX_ROWS} of ${rows.length} rows — switch to text for the rest`;
    view.prepend(note);
  }
}

function showTableView() {
  renderTableView();
  $("#table-view").hidden = false;
}

function hideTableView() {
  $("#table-view").hidden = true;
}

async function save(): Promise<boolean> {
  if (!currentPath || saving || viewingImage || viewingAudio || viewingPdf)
    return true;
  saving = true;
  try {
    const result = await api.writeFile(currentPath, editor.text, currentMtime);
    if (result.conflict) {
      const path = currentPath;
      showIssue("this file changed on disk while you were editing it", [
        {
          label: "overwrite with mine",
          run: () => {
            currentMtime = null;
            void save();
          },
        },
        {
          label: "reload from disk",
          run: () => {
            dirty = false;
            void openFile(path);
          },
        },
      ]);
      return false;
    }
    currentMtime = result.mtime;
    dirty = false;
    if (currentPath === configFilePath) await applyConfigFromDisk();
    updateStatus();
    return true;
  } catch (err) {
    showIssue(`save failed: ${err}`, [{ label: "ok", run: hideIssue }]);
    return false;
  } finally {
    saving = false;
  }
}

function scheduleAutosave() {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void save(), 900);
}

// ---------------------------------------------------------------- external changes

async function onFsChanged(paths: string[]) {
  await refreshTree();
  invalidateNotesMeta();
  for (const p of paths) invalidateImage(p);
  if (pane2Path && paths.includes(pane2Path)) await pane2FsChanged();
  if (!currentPath || !paths.includes(currentPath)) return;
  if (viewingImage || viewingAudio || viewingPdf) {
    const kind = viewingAudio ? "audio file" : viewingPdf ? "PDF" : "image";
    const reopen = viewingAudio ? openAudio : viewingPdf ? openPdf : openImage;
    let onDisk: number;
    try {
      onDisk = await api.statMtime(currentPath);
    } catch {
      showIssue(`this ${kind} was deleted or moved on disk`, [
        { label: "close it", run: closeCurrent },
      ]);
      return;
    }
    // only a real content change reloads the view — spurious events would
    // reset the image tools / restart playback / lose the reading position
    if (currentMtime !== null && onDisk === currentMtime) return;
    await reopen(currentPath);
    return;
  }
  let onDisk: number;
  try {
    onDisk = await api.statMtime(currentPath);
  } catch {
    // the open file was deleted or moved externally
    showIssue("this file was deleted or moved on disk", [
      { label: "keep my copy (re-save)", run: () => ((currentMtime = null), void save()) },
      { label: "close it", run: closeCurrent },
    ]);
    return;
  }
  if (currentMtime !== null && onDisk === currentMtime) return;
  if (!dirty) {
    const file = await api.readFile(currentPath);
    currentMtime = file.mtime;
    editor.replaceContent(file.content);
    updateStatus();
  } else {
    const path = currentPath;
    showIssue("this file changed on disk and you have unsaved edits", [
      {
        label: "keep mine (overwrites)",
        run: () => ((currentMtime = null), void save()),
      },
      {
        label: "take theirs",
        run: () => {
          dirty = false;
          void openFile(path);
        },
      },
    ]);
  }
}

/** Clear the live views without touching the tab record. */
function showEmptyTab() {
  currentPath = null;
  currentMtime = null;
  dirty = false;
  hideImageView();
  hideAudioView();
  hidePdfView();
  hideTableView();
  editor.openDoc("", "untitled.md");
  $("#welcome").style.display = "";
  setCurrentRow(null);
  updateStatus();
  refreshPreview();
}

/** Close the open file: the active tab becomes an empty tab. */
function closeCurrent() {
  showEmptyTab();
  const t = tab();
  t.path = null;
  t.snap = undefined;
  renderTabs();
}

// ---------------------------------------------------------------- create/rename/delete

async function newNote(dir?: string) {
  if (!root) return;
  const name = await promptText("new note name", "");
  if (!name) return;
  const file = name.includes(".") ? name : `${name}.md`;
  const path = `${dir ?? root}/${file}`;
  try {
    await api.createFile(path);
    await refreshTree();
    await openFile(path);
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

async function newFolder(dir?: string) {
  if (!root) return;
  const name = await promptText("new folder name", "");
  if (!name) return;
  await api.createDir(`${dir ?? root}/${name}`);
  await refreshTree();
}

async function renameEntry(entry: api.Entry) {
  const name = await promptText("rename to", entry.name);
  if (!name || name === entry.name) return;
  const parent = entry.path.slice(0, entry.path.length - entry.name.length);
  const to = parent + name;
  try {
    await api.renamePath(entry.path, to);
    if (currentPath && (currentPath === entry.path || currentPath.startsWith(entry.path + "/"))) {
      currentPath = to + currentPath.slice(entry.path.length);
      rememberFile(currentPath);
    }
    remapTabs(entry.path, to);
    await refreshTree();
    setCurrentRow(currentPath);
    updateStatus();
  } catch (err) {
    showIssue(String(err), [{ label: "ok", run: hideIssue }]);
  }
}

async function deleteEntry(entry: api.Entry) {
  const ok = await confirmBox(`move "${entry.name}" to trash?`, "Trash it");
  if (!ok) return;
  await api.trashPath(entry.path);
  if (currentPath?.startsWith(entry.path)) closeCurrent();
  if (pane2Path?.startsWith(entry.path)) emptyPane2();
  await refreshTree();
}

// ---------------------------------------------------------------- switcher / wikilinks

async function quickSwitch() {
  if (!root) return;
  const chosen = await pick(
    allFiles.map((f) => ({ label: f.rel, value: f.path })),
    {
      placeholder: "open note…",
      freeTextHint: "new note",
      onFreeText: (text) => void createAndOpen(text),
    },
  );
  if (chosen) void openFile(chosen.value);
}

async function createAndOpen(name: string) {
  if (!root) return;
  const file = name.includes(".") ? name : `${name}.md`;
  const path = `${root}/${file}`;
  try {
    await api.createFile(path);
  } catch {
    // already exists — just open it
  }
  await refreshTree();
  await openFile(path);
}

function openWikilink(target: string) {
  const hit = notes.find((n) => n.name.toLowerCase() === target.toLowerCase());
  if (hit) return void openFile(hit.path);
  // non-note targets like [[photo.png]] — match by file name
  const file = allFiles.find(
    (f) => f.path.split("/").pop()!.toLowerCase() === target.toLowerCase(),
  );
  if (file) return void openFile(file.path);
  void createAndOpen(target);
}

// ---------------------------------------------------------------- image embeds

/** Collapse `.` and `..` segments so relative links match tree paths. */
function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (abs ? "/" : "") + parts.join("/");
}

/** Resolve an embed target to an img src: URLs pass through; local paths are
 * tried relative to the pane's open file, then the root, then by bare file
 * name. `getBase` supplies the pane's current file (one resolver per pane). */
const imageResolver = (getBase: () => string | null) => async (
  target: string,
): Promise<string | null> => {
  if (/^(https?:|data:)/i.test(target)) return target;
  if (!root) return null;
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // not URI-encoded — use as-is
  }
  const baseFile = getBase();
  const dir = baseFile ? parentOf(baseFile) : root;
  const candidates = t.startsWith("/") ? [t] : [`${dir}/${t}`, `${root}/${t}`];
  for (const c of candidates) {
    const path = normalizePath(c);
    if (allFiles.some((f) => f.path === path)) return loadImage(path).catch(() => null);
  }
  const base = t.split("/").pop()!.toLowerCase();
  const hit = allFiles.find((f) => f.path.split("/").pop()!.toLowerCase() === base);
  if (hit) return loadImage(hit.path).catch(() => null);
  // not in the index (deep tree, fresh file, excluded folder) — try disk anyway
  for (const c of candidates) {
    const src = await loadImage(normalizePath(c)).catch(() => null);
    if (src) return src;
  }
  return null;
};

// ---------------------------------------------------------------- image import

/** Where dropped/pasted images land (config.image_dir, relative to root). */
function imageDestDir(): string {
  const sub = config.image_dir.replace(/^\/+|\/+$/g, "");
  return sub ? `${root}/${sub}` : root!;
}

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",", 2)[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${today()}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Save a pasted clipboard image into the notes folder; returns the file
 * name to embed, or null. */
async function importImageBlob(blob: File): Promise<string | null> {
  if (!root) return null;
  try {
    const ext = (blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/\+.*$/, "");
    const b64 = await blobToBase64(blob);
    const path = await api.writeBase64(imageDestDir(), `pasted-${timestamp()}.${ext}`, b64);
    await refreshTree();
    return path.split("/").pop()!;
  } catch (err) {
    showIssue(`image paste failed: ${err}`, [{ label: "ok", run: hideIssue }]);
    return null;
  }
}

/** Native file drop: copy images into the notes folder and, when dropped on
 * an open note, insert an embed at the drop point. */
async function handleFileDrop(paths: string[], position: { x: number; y: number }) {
  if (!root) return;
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  const overEditor = !!document.elementFromPoint(x, y)?.closest("#editor-host");
  for (const src of paths) {
    const name = src.split("/").pop()!;
    if (!isViewableImage(name) && !/\.svg$/i.test(name)) continue;
    try {
      // already inside the notes folder — embed it without copying
      const path = src.startsWith(root + "/") ? src : await api.importFile(src, imageDestDir());
      await refreshTree();
      if (overEditor && currentPath && isNote(currentPath) && !viewingImage && !tableShown()) {
        editor.insertAt(`![[${path.split("/").pop()!}]]\n`, { x, y });
      }
    } catch (err) {
      showIssue(`import failed: ${err}`, [{ label: "ok", run: hideIssue }]);
    }
  }
}

// ---------------------------------------------------------------- sidebar panes

function showPane(tab: "files" | "search" | "links") {
  for (const b of document.querySelectorAll<HTMLElement>("#sidebar-tabs button")) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  $("#pane-files").classList.toggle("active", tab === "files");
  $("#pane-search").classList.toggle("active", tab === "search");
  $("#pane-links").classList.toggle("active", tab === "links");
  if (tab === "search") $("#search-input").focus();
  if (tab === "links") void refreshBacklinks();
}

function renderHits(container: HTMLElement, hits: api.Hit[], empty: string) {
  if (!hits.length) {
    const div = document.createElement("div");
    div.className = "hit-empty";
    div.textContent = empty;
    container.replaceChildren(div);
    return;
  }
  container.replaceChildren(
    ...hits.map((hit) => {
      const row = document.createElement("div");
      row.className = "hit-row";
      const where = document.createElement("div");
      where.className = "hit-where";
      where.textContent = `${rel(hit.path)}:${hit.line}`;
      const text = document.createElement("div");
      text.className = "hit-text";
      const before = hit.text.slice(0, hit.start);
      const mark = document.createElement("mark");
      mark.textContent = hit.text.slice(hit.start, hit.end);
      text.append(before.length > 80 ? "…" + before.slice(-80) : before, mark,
        hit.text.slice(hit.end));
      row.append(where, text);
      row.addEventListener("click", async () => {
        await openFile(hit.path);
        editor.jumpToLine(hit.line);
      });
      return row;
    }),
  );
}

async function runSearch() {
  if (!root) return;
  const query = $<HTMLInputElement>("#search-input").value;
  if (!query.trim()) {
    $("#search-results").replaceChildren();
    return;
  }
  const hits = await api.searchText(root, query);
  renderHits($("#search-results"), hits, "no matches");
}

async function refreshBacklinks() {
  if (!$("#pane-links").classList.contains("active")) return;
  if (!root || !currentPath || !isNote(currentPath)) {
    $("#backlinks-title").textContent = "no note open";
    $("#backlinks-results").replaceChildren();
    return;
  }
  const name = stem(currentPath.split("/").pop()!);
  $("#backlinks-title").textContent = `links to [[${name}]]`;
  const hits = await api.findBacklinks(root, name);
  renderHits($("#backlinks-results"), hits.filter((h) => h.path !== currentPath),
    "nothing links here yet");
}

// ---------------------------------------------------------------- daily / theme / config

/** Open (creating if needed) the daily note for a YYYY-MM-DD date. */
async function openDailyFor(date: string) {
  if (!root) return;
  // daily/YYYY/MM/YYYY-MM-DD.md (the tree shows latest year/month first)
  const dir = `${root}/${config.daily_dir}/${date.slice(0, 4)}/${date.slice(5, 7)}`;
  const path = `${dir}/${date}.md`;
  try {
    await api.createDir(dir);
    await api.createFile(path);
  } catch {
    // exists — fine
  }
  await refreshTree();
  await openFile(path);
  if (!editor.text) {
    editor.replaceContent(`# ${date}\n\n`);
    editor.jumpToLine(3);
  }
}

const openDaily = () => openDailyFor(today());

/** Month-grid calendar over the daily notes (Ctrl+Shift+C / the sidebar). */
function openDailyCalendar() {
  if (!root) return;
  const dailyRel = config.daily_dir.replace(/^\/+|\/+$/g, "");
  openCalendar({
    hasNote: (date) =>
      allFiles.some(
        (f) => f.rel === `${dailyRel}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`,
      ),
    open: (date) => {
      closeModal();
      void openDailyFor(date);
    },
  });
}

async function pickTheme() {
  themes = await api.listThemes();
  const current = themes.find((t) => t.id === config.theme);
  // light themes first, then dark — so the two groups read separately
  const grouped = [...themes].sort(
    (a, b) => Number(a.dark) - Number(b.dark) || a.name.localeCompare(b.name),
  );
  const chosen = await pick(
    grouped.map((t) => ({
      label: t.name,
      detail: `${t.dark ? "dark" : "light"} · ${t.id}`,
      value: t.id,
    })),
    {
      placeholder: "theme… (type light / dark to filter)",
      // live preview while arrowing / hovering (never on open)
      onHighlight: (item) => {
        const theme = themes.find((t) => t.id === item?.value);
        if (theme) applyTheme(theme);
      },
    },
  );
  if (!chosen) {
    if (current) applyTheme(current); // cancelled — put the theme back
    return;
  }
  const theme = themes.find((t) => t.id === chosen.value);
  if (theme) applyTheme(theme);
  config.theme = chosen.value;
  await api.saveConfig(config);
}

// ---------------------------------------------------------------- editor font

/** A tasteful shortlist of typing fonts. `bundled` families ship with the
 * app (see fonts.ts) and are always available; the rest degrade gracefully
 * when not installed — `probe` is the family name used to detect that. */
const EDITOR_FONTS: { label: string; kind: string; stack: string; probe?: string; bundled?: boolean }[] = [
  { label: "theme default", kind: "", stack: "" },
  { label: "system monospace", kind: "mono", stack: "ui-monospace, monospace" },
  { label: "iA Writer Mono", kind: "mono", stack: "'iA Writer Mono', ui-monospace, monospace", bundled: true },
  { label: "iA Writer Duo", kind: "duospace", stack: "'iA Writer Duo', ui-monospace, monospace", bundled: true },
  { label: "JetBrains Mono", kind: "mono", stack: "'JetBrains Mono', 'JetBrains Mono Variable', ui-monospace, monospace", bundled: true },
  { label: "IBM Plex Mono", kind: "mono", stack: "'IBM Plex Mono', ui-monospace, monospace", bundled: true },
  { label: "Iosevka", kind: "mono", stack: "'Iosevka', 'Iosevka Fixed', ui-monospace, monospace" },
  { label: "Fira Code", kind: "mono", stack: "'Fira Code', 'Fira Code Variable', ui-monospace, monospace", bundled: true },
  { label: "system sans", kind: "sans", stack: "system-ui, sans-serif" },
  {
    label: "iA Writer Quattro",
    kind: "quattro — nearly proportional",
    stack: "'iA Writer Quattro', system-ui, sans-serif",
    bundled: true,
  },
  { label: "Inter", kind: "sans", stack: "'Inter', 'Inter Variable', system-ui, sans-serif", bundled: true },
  { label: "IBM Plex Sans", kind: "sans", stack: "'IBM Plex Sans', system-ui, sans-serif", bundled: true },
  {
    label: "Atkinson Hyperlegible",
    kind: "sans",
    stack: "'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next', system-ui, sans-serif",
    bundled: true,
  },
  { label: "Cantarell", kind: "sans", stack: "'Cantarell', system-ui, sans-serif" },
  {
    label: "Charter",
    kind: "serif",
    stack: "'Charter', 'Bitstream Charter', 'Georgia', 'Liberation Serif', serif",
    probe: "Bitstream Charter",
  },
  {
    label: "Source Serif",
    kind: "serif",
    stack: "'Source Serif 4', 'Source Serif 4 Variable', 'Source Serif Pro', 'Georgia', serif",
    probe: "Source Serif 4",
    bundled: true,
  },
  {
    label: "Literata",
    kind: "serif",
    stack: "'Literata', 'Literata Variable', 'Charter', 'Bitstream Charter', serif",
    bundled: true,
  },
];

async function pickEditorFont() {
  const detail = (f: (typeof EDITOR_FONTS)[number]) => {
    if (!f.kind) return "follows the theme";
    if (f.bundled || f.label.startsWith("system")) return f.kind;
    const have = document.fonts.check(`16px "${f.probe ?? f.label}"`);
    return have ? f.kind : `${f.kind} · not installed, uses fallback`;
  };
  const before = config.editor_font;
  const chosen = await pick(
    EDITOR_FONTS.map((f) => ({ label: f.label, detail: detail(f), value: f.stack })),
    {
      placeholder: "editor font…",
      // live preview while arrowing through the list
      onHighlight: (item) => setEditorFont(item ? item.value : before),
    },
  );
  setEditorFont(chosen ? chosen.value : before);
  if (!chosen) return;
  config.editor_font = chosen.value;
  await api.saveConfig(config);
}

// ---------------------------------------------------------------- zen mode

// fullscreen, chrome hidden, a centered column with a slightly larger font,
// and typewriter scrolling (cursor line stays mid-screen)
let zen = false;

async function toggleZen() {
  zen = !zen;
  document.body.classList.toggle("zen", zen);
  editor.setTypewriter(zen);
  try {
    await getCurrentWindow().setFullscreen(zen);
  } catch {
    // fullscreen unavailable — zen still applies in-window
  }
  editor.focus();
}

// ---------------------------------------------------------------- sharing

/** Share the whole notes folder; individual folders share via the tree's
 * right-click menu. */
function shareRoot() {
  if (root) openShareDialog(root);
}

// ---------------------------------------------------------------- dataview

/** Cached note metadata for dataview blocks; refetched after fs changes. */
let notesMeta: Promise<NoteMeta[]> | null = null;
const dataviewSubs = new Set<() => void>();
let dataviewTimer: number | undefined;

function invalidateNotesMeta() {
  notesMeta = null;
  // fs events arrive in bursts (autosave) — tell the widgets once it settles
  window.clearTimeout(dataviewTimer);
  dataviewTimer = window.setTimeout(() => {
    for (const cb of dataviewSubs) cb();
  }, 500);
}

const dataviewHost = {
  data: () => {
    if (!root) return Promise.resolve([]);
    if (!notesMeta) notesMeta = api.collectNotes(root).catch(() => []);
    return notesMeta;
  },
  onInvalidate: (cb: () => void) => {
    dataviewSubs.add(cb);
    return () => void dataviewSubs.delete(cb);
  },
  openNote: (path: string, line?: number) => {
    void openFile(path).then(() => {
      if (line && currentPath === path) editor.jumpToLine(line);
    });
  },
};

// ---------------------------------------------------------------- preview

/** Open a relative link target ("dir/note.md") clicked in the preview. */
function openRelTarget(target: string) {
  if (!root) return;
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // not URI-encoded — use as-is
  }
  const dir = currentPath ? parentOf(currentPath) : root;
  const candidates = t.startsWith("/") ? [t] : [`${dir}/${t}`, `${root}/${t}`];
  for (const c of candidates) {
    const p = normalizePath(c);
    if (allFiles.some((f) => f.path === p)) return void openFile(p);
  }
  const base = t.split("/").pop()!.toLowerCase();
  const hit = allFiles.find((f) => f.path.split("/").pop()!.toLowerCase() === base);
  if (hit) void openFile(hit.path);
}

const togglePreview = () => setPreview(!previewOn());

// ---------------------------------------------------------------- demo note

/** Write the bundled markdown reference into the folder (once) and open it
 * with the preview beside it — a live side-by-side comparison. */
async function openDemoNote() {
  if (!root) return;
  closeModal(); // settings panel stays open otherwise
  const path = `${root}/${DEMO_FILE}`;
  if (!allFiles.some((f) => f.path === path)) {
    try {
      await api.createFile(path).catch(() => {});
      await api.writeFile(path, DEMO_NOTE, null);
      await refreshTree();
    } catch (err) {
      return showIssue(`could not create the reference note: ${err}`, [
        { label: "ok", run: hideIssue },
      ]);
    }
  }
  await openFile(path);
  setPreview(true);
}

let configFilePath = "";
let configSaveTimer: number | undefined;

function scheduleConfigSave() {
  window.clearTimeout(configSaveTimer);
  configSaveTimer = window.setTimeout(() => void api.saveConfig(config), 400);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function bumpEditorFont(delta: number) {
  config.font_size = clamp(config.font_size + delta, 9, 40);
  setFontSize(config.font_size);
  scheduleConfigSave();
}

function bumpUiFont(delta: number) {
  config.ui_font_size = clamp(config.ui_font_size + delta, 9, 28);
  setUiFontSize(config.ui_font_size);
  scheduleConfigSave();
}

async function applyConfigFromDisk() {
  config = await api.loadConfig();
  rebindKeys();
  setFontSize(config.font_size);
  setUiFontSize(config.ui_font_size);
  setEditorFont(config.editor_font);
  setEditorMargin(config.editor_margin);
  editor.setVim(config.vim_mode);
  editor2?.setVim(config.vim_mode);
  applyEditorView();
  $("#sidebar").style.width = `${config.sidebar_width}px`;
  themes = await api.listThemes();
  const theme = themes.find((t) => t.id === config.theme) ?? themes[0];
  if (theme) applyTheme(theme);
}

async function openConfig() {
  closeModal(); // settings panel stays open otherwise, hiding the editor
  await api.saveConfig(config); // make sure the file exists with current values
  await openFile(configFilePath);
}

/** Line numbers + current-line highlight, applied to both editors. */
function applyEditorView() {
  editor.setLineNumbers(config.line_numbers);
  editor.setHighlightLine(config.highlight_line);
  editor2?.setLineNumbers(config.line_numbers);
  editor2?.setHighlightLine(config.highlight_line);
}

/** The settings panel (Ctrl+,) — a friendly face over config.toml. */
function openSettingsPanel() {
  openSettings({
    config,
    save: scheduleConfigSave,
    applyFontSizes: () => {
      setFontSize(config.font_size);
      setUiFontSize(config.ui_font_size);
    },
    applyMargin: () => setEditorMargin(config.editor_margin),
    applyVim: () => {
      editor.setVim(config.vim_mode);
      editor2?.setVim(config.vim_mode);
    },
    applyEditorView,
    openDemo: () => void openDemoNote(),
    pickTheme: () => void pickTheme(),
    pickFont: () => void pickEditorFont(),
    openConfigFile: () => void openConfig(),
    fontLabel: () =>
      EDITOR_FONTS.find((f) => f.stack === config.editor_font)?.label ??
      (config.editor_font ? "custom" : "theme default"),
    actions: ACTIONS.map(({ id, combo, what }) => ({ id, combo, what })),
    effectiveCombo: (id) => effectiveCombo(ACTIONS.find((a) => a.id === id)!),
    setKey: (id, combo) => {
      if (combo === null) delete config.keys[id];
      else config.keys[id] = combo;
      rebindKeys();
      scheduleConfigSave();
    },
    isOverridden: (id) => {
      const a = ACTIONS.find((x) => x.id === id)!;
      return effectiveCombo(a) !== normalizeCombo(a.combo);
    },
    prettyCombo,
  });
}

// ---------------------------------------------------------------- root folder

/** Point the window at a notes folder. Callers decide what to open next
 * (session restore, a handed-over file, or the first note). */
async function openRoot(path: string) {
  const switching = root !== null && root !== path;
  root = path;
  $("#folder-name").textContent = path.split("/").pop() ?? path;
  if (switching) {
    tabs = [blankTab()];
    active = 0;
    teardownSecondary(); // a new folder starts with no split/preview carried over
    closeCurrent();
  }
  await refreshTree();
  invalidateNotesMeta();
  await api.watchRoot(path);
  const recents = [path, ...config.recent_roots.filter((r) => r !== path)].slice(0, 10);
  if (config.root !== path || recents.join("\n") !== config.recent_roots.join("\n")) {
    config.root = path;
    config.recent_roots = recents;
    await api.saveConfig(config);
  }
}

async function openFirstFile() {
  if (notes.length) await openFile(notes[0].path);
  else if (allFiles.length) await openFile(allFiles[0].path);
}

/** Re-open the main window's tabs from the previous session. */
async function restoreSession() {
  let saved: (string | null)[] = [];
  try {
    saved = JSON.parse(localStorage.getItem("text.tabs") ?? "[]");
  } catch {
    // unreadable — start fresh
  }
  const exists = (p: string) => allFiles.some((f) => f.path === p);
  // drop video tabs from older sessions — restoring one would launch the
  // system player at startup (videos no longer open in-app)
  let paths = saved.filter((p): p is string => !!p && exists(p) && !isVideoFile(p));
  if (!paths.length) {
    const last = localStorage.getItem("text.lastFile");
    paths = last && exists(last) ? [last] : [];
  }
  if (!paths.length) return openFirstFile();
  tabs = paths.map((p) => blankTab(p));
  active = Math.min(
    Math.max(Number(localStorage.getItem("text.activeTab")) || 0, 0),
    tabs.length - 1,
  );
  await activateTab();
}

async function chooseFolder() {
  const chosen = await openDialog({ directory: true, title: "Open notes folder" });
  if (typeof chosen !== "string") return;
  await openRoot(chosen);
  if (!currentPath) await openFirstFile();
}

/** Quick switcher over recently opened folders (personal / work / projects).
 * Pinned folders sort to the top and persist even after they age out of the
 * recent history; each row carries an inline pin/unpin toggle. */
async function switchFolder() {
  const pinned = config.pinned_roots;
  const folderRow = (r: string) => ({
    label: r.split("/").pop() || r,
    detail: r === root ? `${r} (current)` : r,
    value: r,
    actionLabel: pinned.includes(r) ? "unpin" : "pin",
    actionTitle: pinned.includes(r) ? "Remove from pinned" : "Keep at the top of this list",
  });
  // pinned first (in pin order), then recents that aren't already pinned
  const build = (): PickerItem[] => {
    const rows: PickerItem[] = [
      ...config.pinned_roots.map(folderRow),
      ...config.recent_roots.filter((r) => !config.pinned_roots.includes(r)).map(folderRow),
    ];
    rows.push({ label: "browse…", detail: "pick another folder", value: "" });
    return rows;
  };
  const items = build();
  const chosen = await pick(items, {
    placeholder: "switch folder…",
    onAction: (item) => {
      if (!item.value) return;
      const i = config.pinned_roots.indexOf(item.value);
      if (i >= 0) config.pinned_roots.splice(i, 1);
      else config.pinned_roots.push(item.value);
      void api.saveConfig(config);
      // rebuild the rows in place so the picker's re-render reflects the change
      items.splice(0, items.length, ...build());
    },
  });
  if (!chosen) return;
  if (!chosen.value) return void chooseFolder();
  if (chosen.value !== root) {
    await openRoot(chosen.value);
    if (!currentPath) await openFirstFile();
  }
}

// ---------------------------------------------------------------- keybindings

/** App-level actions, their default combos, and help descriptions. The
 * effective combo comes from config.toml's [keys] (documented there). */
const ACTIONS: { id: string; combo: string; what: string; run: () => void }[] = [
  { id: "quick_switch", combo: "ctrl+p", what: "quick switch / new note", run: () => void quickSwitch() },
  { id: "new_note", combo: "ctrl+n", what: "new note", run: () => void newNote() },
  { id: "daily_note", combo: "ctrl+shift+d", what: "today's daily note", run: () => void openDaily() },
  { id: "open_folder", combo: "ctrl+o", what: "open folder…", run: () => void chooseFolder() },
  { id: "switch_folder", combo: "ctrl+shift+o", what: "switch between recent folders", run: () => void switchFolder() },
  { id: "search", combo: "ctrl+shift+f", what: "search everywhere", run: () => showPane("search") },
  { id: "backlinks", combo: "ctrl+shift+b", what: "backlinks", run: () => showPane("links") },
  { id: "theme", combo: "ctrl+shift+t", what: "switch theme", run: () => void pickTheme() },
  { id: "editor_font", combo: "ctrl+shift+e", what: "editor font", run: () => void pickEditorFont() },
  { id: "share", combo: "ctrl+shift+s", what: "share folder as a website", run: shareRoot },
  { id: "config", combo: "ctrl+,", what: "settings", run: () => openSettingsPanel() },
  { id: "shortcuts", combo: "ctrl+/", what: "this list", run: () => showShortcuts() },
  { id: "toggle_sidebar", combo: "ctrl+\\", what: "toggle sidebar", run: () => toggleSidebar() },
  { id: "new_tab", combo: "ctrl+t", what: "new tab", run: () => void newTab() },
  { id: "close_tab", combo: "ctrl+w", what: "close tab", run: () => void closeTab(active) },
  { id: "next_tab", combo: "ctrl+tab", what: "next tab", run: () => void switchTab((active + 1) % tabs.length) },
  { id: "prev_tab", combo: "ctrl+shift+tab", what: "previous tab", run: () => void switchTab((active + tabs.length - 1) % tabs.length) },
  { id: "new_window", combo: "ctrl+shift+n", what: "new window", run: newWindow },
  { id: "split", combo: "ctrl+shift+\\", what: "split editor (vertical → horizontal → off)", run: () => void cycleSplit() },
  { id: "preview", combo: "ctrl+shift+m", what: "markdown preview (rendered, beside the editor)", run: togglePreview },
  { id: "focus_tree", combo: "ctrl+e", what: "focus file tree (arrows move, enter opens, esc returns)", run: focusTree },
  { id: "calendar", combo: "ctrl+shift+c", what: "daily-note calendar", run: openDailyCalendar },
  { id: "zen", combo: "alt+z", what: "zen mode (fullscreen, typewriter) — also F11", run: () => void toggleZen() },
];

/** Normalize "Ctrl + Shift+F" → "ctrl+shift+f" with canonical modifier order. */
function normalizeCombo(binding: string): string | null {
  let key = "";
  const mods = { ctrl: false, shift: false, alt: false };
  for (const part of binding.toLowerCase().split("+")) {
    const p = part.trim();
    if (!p) continue;
    if (p === "ctrl" || p === "cmd" || p === "meta" || p === "mod") mods.ctrl = true;
    else if (p === "shift") mods.shift = true;
    else if (p === "alt") mods.alt = true;
    else key = p;
  }
  if (binding.endsWith("+") && !key) key = "+"; // the literal plus key
  if (!key) return null;
  return `${mods.ctrl ? "ctrl+" : ""}${mods.shift ? "shift+" : ""}${mods.alt ? "alt+" : ""}${key}`;
}

const effectiveCombo = (a: (typeof ACTIONS)[number]) =>
  normalizeCombo(config?.keys?.[a.id] ?? a.combo) ?? normalizeCombo(a.combo)!;

let boundKeys = new Map<string, () => void>();

function rebindKeys() {
  boundKeys = new Map(ACTIONS.map((a) => [effectiveCombo(a), a.run]));
}

const prettyCombo = (combo: string) =>
  combo
    .split("+")
    .map((p) => {
      // "ctrl" in a combo means Cmd on macOS (matching is ctrlKey || metaKey)
      if (isMac && p === "ctrl") return "Cmd";
      if (isMac && p === "alt") return "Option";
      return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    })
    .join("+");

// ---------------------------------------------------------------- shortcuts help

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "editing",
    [
      ["Ctrl+S", "save (autosave is on anyway)"],
      ["Ctrl+B", "bold"],
      ["Ctrl+I", "italic"],
      ["Ctrl+Shift+X", "strikethrough"],
      ["Ctrl+K", "insert markdown link"],
      ["` with text selected", "wrap as inline code"],
      ["Ctrl+1 … Ctrl+6", "heading level 1–6 (repeat to clear)"],
      ["Ctrl+F", "find in note"],
      ["click a [ ]", "toggle checkbox"],
      ["Tab / Shift+Tab", "table: next / previous cell (auto-formats)"],
      ["Enter", "table: row below (on an empty last row: leave the table)"],
    ],
  ],
  [
    "navigation",
    [
      isMac
        ? ["Cmd+[ / Cmd+]", "back / forward through opened files"]
        : ["Alt+← / Alt+→", "back / forward through opened files"],
      ["Ctrl+Enter", "open wikilink under cursor"],
      ["Ctrl+click", "follow wikilink, or open URL in browser"],
    ],
  ],
  [
    "view",
    [
      ["Ctrl+= / Ctrl+-", "editor font size — zooms instead while viewing an image or PDF"],
      ["Ctrl+Shift+= / Ctrl+Shift+-", "UI font size"],
      ["Ctrl+0", "reset font sizes (or image/PDF zoom)"],
    ],
  ],
];

function showShortcuts() {
  // the app section reflects the live [keys] config; the rest is fixed
  const app: [string, string][] = ACTIONS.map((a) => [prettyCombo(effectiveCombo(a)), a.what]);
  infoBox((box) => {
    const caption = document.createElement("div");
    caption.className = "modal-caption";
    caption.textContent = "keyboard shortcuts";
    const grid = document.createElement("div");
    grid.className = "keys-grid";
    const sections: [string, [string, string][]][] = [
      ["app (rebindable in config)", app],
      ...SHORTCUTS,
    ];
    for (const [section, keys] of sections) {
      const head = document.createElement("div");
      head.className = "keys-section";
      head.textContent = section;
      grid.appendChild(head);
      for (const [combo, what] of keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = combo;
        const desc = document.createElement("span");
        desc.textContent = what;
        grid.append(kbd, desc);
      }
    }
    box.append(caption, grid);
  });
}

// ---------------------------------------------------------------- keyboard

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "F11") {
    e.preventDefault();
    return void toggleZen();
  }
  // Alt+arrows: back/forward. The editor keymap handles these itself when
  // focused (defaultPrevented) — this catches them everywhere else. On
  // macOS Option+arrows stay word motion; nav is Cmd+[ / Cmd+] there.
  if (!isMac && e.altKey && !mod && !e.shiftKey && !e.defaultPrevented) {
    if (e.key === "ArrowLeft") return (e.preventDefault(), goBack());
    if (e.key === "ArrowRight") return (e.preventDefault(), goForward());
  }
  if (!mod && !e.altKey) {
    if (e.key === "Escape") closeModal();
    return;
  }
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };
  // Ctrl+= / Ctrl+- (fixed): zoom the image or PDF when one is open,
  // otherwise the editor font; Ctrl+Shift+= / Ctrl+Shift+- the UI font.
  // Ctrl+0 resets whichever applies. Matched on e.code so they work
  // regardless of layout and shift state.
  if (mod && (e.code === "Equal" || e.code === "Minus" || e.code === "NumpadAdd" || e.code === "NumpadSubtract")) {
    const delta = e.code === "Equal" || e.code === "NumpadAdd" ? 1 : -1;
    return run(() => {
      if (!e.shiftKey && viewingImage) {
        imgScale = Math.min(4, Math.max(0.1, Math.round((imgScale + delta * 0.1) * 10) / 10));
        applyImageTools();
      } else if (!e.shiftKey && viewingPdf) {
        bumpPdfZoom(delta * 0.1);
      } else if (e.shiftKey) {
        bumpUiFont(delta);
      } else {
        bumpEditorFont(delta);
      }
    });
  }
  if (mod && e.code === "Digit0" && !e.shiftKey) {
    return run(() => {
      if (viewingImage) {
        imgScale = 1;
        applyImageTools();
      } else if (viewingPdf) {
        resetPdfZoom();
      } else {
        bumpEditorFont(15 - config.font_size);
        bumpUiFont(13 - config.ui_font_size);
      }
    });
  }
  // configurable app shortcuts — the editor keeps anything it already
  // handled. Both the typed key and the physical (unshifted) key are tried,
  // so e.g. ctrl+shift+\ matches even where Shift+\ types "|".
  if (e.defaultPrevented) return;
  for (const combo of comboCandidates(e)) {
    const action = boundKeys.get(combo);
    if (action) return run(action);
  }
}

function toggleSidebar() {
  const sb = $("#sidebar");
  const hidden = sb.style.display === "none";
  sb.style.display = hidden ? "" : "none";
  $("#resizer").style.display = hidden ? "" : "none";
}

// ---------------------------------------------------------------- resizer

function initResizer() {
  const resizer = $("#resizer");
  const sidebar = $("#sidebar");
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const w = Math.min(Math.max(ev.clientX, 160), 480);
      sidebar.style.width = `${w}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      config.sidebar_width = sidebar.offsetWidth;
      void api.saveConfig(config);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ---------------------------------------------------------------- init

async function init() {
  config = await api.loadConfig();
  const themesDir = await api.themesDirPath();
  configFilePath = themesDir.replace(/themes$/, "config.toml");

  editor = new Editor($("#editor-host"), {
    onDocChanged: () => {
      dirty = true;
      updateStatus();
      scheduleAutosave();
      schedulePreview();
      if (tableShown()) renderTableView(); // external reload while in table view
    },
    onStatus: updateStatus,
    onSave: () => void save(),
    getNotes: () => notes,
    openWikilink,
    openExternal: (url) => void openUrl(url),
    resolveImage: imageResolver(() => currentPath),
    importImageBlob,
    onNavBack: goBack,
    onNavForward: goForward,
    dataview: dataviewHost,
  });

  initPreview(
    {
      getText: () => editor.text,
      getPath: () => currentPath,
      isMarkdownish: (p) => {
        const name = p.split("/").pop()!;
        return isNote(name) || /\.(txt|text)$/i.test(name) || !name.includes(".");
      },
      resolveImage: imageResolver(() => currentPath),
      openWikilink,
      openRelPath: openRelTarget,
      openExternal: (url) => void openUrl(url),
    },
    () => setPreview(false),
  );

  await applyConfigFromDisk();

  // macOS: native decorations with overlay traffic lights replace the custom
  // window buttons and resize grips (see tauri.macos.conf.json / windows.rs)
  if (isMac) document.body.classList.add("macos");

  const appWindow = getCurrentWindow();
  $("#tb-min").addEventListener("click", () => void appWindow.minimize());
  $("#tb-max").addEventListener("click", () => void appWindow.toggleMaximize());
  $("#tb-close").addEventListener("click", () => void appWindow.close());

  // edge/corner resize grips (no native decorations); hidden while maximized
  for (const grip of document.querySelectorAll<HTMLElement>(".grip")) {
    grip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void appWindow.startResizeDragging(
        grip.dataset.dir as Parameters<typeof appWindow.startResizeDragging>[0],
      );
    });
  }
  const syncMaximized = async () =>
    document.body.classList.toggle("maximized", await appWindow.isMaximized());
  void appWindow.onResized(() => void syncMaximized());
  void syncMaximized();
  // flush unsaved edits before the window goes away (autosave is debounced)
  void appWindow.onCloseRequested(async (event) => {
    if (!dirty) return;
    event.preventDefault();
    await save();
    void appWindow.destroy();
  });
  // also flush when the window loses focus — covers app quits that skip
  // close-requested (macOS Cmd+Q) and just plain switching away
  window.addEventListener("blur", () => {
    if (dirty) void save();
    if (pane2Dirty) void savePane2();
  });

  $("#btn-open-folder").addEventListener("click", () => void chooseFolder());
  $("#folder-name").addEventListener("click", () => void switchFolder());
  $("#btn-new-note").addEventListener("click", () => void newNote());
  $("#btn-new-folder").addEventListener("click", () => void newFolder());

  $("#img-rot-l").addEventListener("click", () => {
    imgRotation = (imgRotation + 270) % 360;
    applyImageTools();
  });
  $("#img-rot-r").addEventListener("click", () => {
    imgRotation = (imgRotation + 90) % 360;
    applyImageTools();
  });
  $("#img-shrink").addEventListener("click", () => {
    imgScale = Math.max(0.1, Math.round((imgScale - 0.1) * 10) / 10);
    applyImageTools();
  });
  $("#img-grow").addEventListener("click", () => {
    imgScale = Math.min(4, Math.round((imgScale + 0.1) * 10) / 10);
    applyImageTools();
  });
  $("#img-reset").addEventListener("click", resetImageTools);
  $("#img-save-copy").addEventListener("click", () => void saveImageCopy());
  $("#img-overwrite").addEventListener("click", () => void overwriteImage());

  // drag to pan when zoomed in. The pan is clamped to roughly the extent the
  // scaled image overflows its stage, so it can't be flung off-screen.
  {
    const stageEl = $("#image-stage");
    const imgEl = $<HTMLImageElement>("#image-view img");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    const clampPan = () => {
      const stageRect = stageEl.getBoundingClientRect();
      // base (unzoomed) rendered size = scaled rect divided by current scale
      const baseW = imgEl.offsetWidth;
      const baseH = imgEl.offsetHeight;
      const overflowX = Math.max(0, (baseW * imgScale - stageRect.width) / 2 + 24);
      const overflowY = Math.max(0, (baseH * imgScale - stageRect.height) / 2 + 24);
      imgPanX = Math.min(overflowX, Math.max(-overflowX, imgPanX));
      imgPanY = Math.min(overflowY, Math.max(-overflowY, imgPanY));
    };
    imgEl.addEventListener("pointerdown", (e) => {
      if (imgScale <= 1 || e.button !== 0) return;
      dragging = true;
      startX = e.clientX - imgPanX;
      startY = e.clientY - imgPanY;
      imgEl.setPointerCapture(e.pointerId);
      imgEl.classList.add("panning");
      e.preventDefault();
    });
    imgEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      imgPanX = e.clientX - startX;
      imgPanY = e.clientY - startY;
      clampPan();
      applyImageTools();
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      imgEl.classList.remove("panning");
      if (imgEl.hasPointerCapture(e.pointerId)) imgEl.releasePointerCapture(e.pointerId);
    };
    imgEl.addEventListener("pointerup", endDrag);
    imgEl.addEventListener("pointercancel", endDrag);
  }
  $("#btn-collapse").addEventListener("click", () => {
    expanded.clear();
    localStorage.setItem("text.expanded", "[]");
    renderTree();
  });
  $("#btn-sidebar").addEventListener("click", toggleSidebar);
  $("#btn-table").addEventListener("click", () => {
    tableMode = !tableShown();
    if (tableMode) showTableView();
    else (hideTableView(), editor.focus());
    updateStatus();
  });
  $("#tab-new").addEventListener("click", () => void newTab());
  $("#pane2-close").addEventListener("click", () => void setSplit("off"));
  // focus follows the pane the user interacts with
  $("#pane1").addEventListener("mousedown", () => setFocusedPane(1), true);
  $("#pane2").addEventListener("mousedown", () => setFocusedPane(2), true);
  $("#pane1").addEventListener("focusin", () => setFocusedPane(1));
  $("#pane2").addEventListener("focusin", () => setFocusedPane(2));
  $("#btn-daily").addEventListener("click", () => void openDaily());
  $("#btn-calendar").addEventListener("click", openDailyCalendar);
  $("#btn-share").addEventListener("click", shareRoot);
  $("#btn-config").addEventListener("click", () => openSettingsPanel());
  $("#btn-config").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void openPath(themesDir);
  });
  for (const b of document.querySelectorAll<HTMLElement>("#sidebar-tabs button")) {
    b.addEventListener("click", () => showPane(b.dataset.tab as never));
  }
  $<HTMLInputElement>("#search-input").addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
  window.addEventListener("keydown", onKeydown);
  initResizer();
  initPdfView();
  // wheel zooms images, like a standalone image viewer
  $("#image-stage").addEventListener(
    "wheel",
    (e) => {
      if (!viewingImage) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.1 : -0.1;
      imgScale = Math.min(4, Math.max(0.1, Math.round((imgScale + step) * 10) / 10));
      applyImageTools();
    },
    { passive: false },
  );

  await listen<string[]>("fs:changed", (event) => void onFsChanged(event.payload));
  await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      void handleFileDrop(event.payload.paths, event.payload.position);
    }
  });

  renderTabs();

  // init params come from the backend: CLI args for the main window
  // (`text <file|dir>`), or the hand-over to new-window / detached tabs.
  // without params, the main window restores its previous session.
  const params = await api.windowInitParams().catch(() => null);
  const startRoot = params?.root ?? config.root;
  if (startRoot) {
    try {
      await openRoot(startRoot);
      if (params?.file) {
        await api.createFile(params.file).catch(() => {}); // `text newnote.md`
        await refreshTree();
        await openFile(params.file);
      } else if (isMain && !params) {
        await restoreSession();
      } else {
        await openFirstFile();
      }
    } catch {
      config.root = null;
    }
  }

  // expired share links get taken down in the background; failures (offline,
  // gh signed out) are silent and retried next launch
  if (isMain) void api.cleanupShares().catch(() => {});
}

window.addEventListener("DOMContentLoaded", () => void init());
