import * as api from "./api";

/**
 * Rendered-markdown preview (Ctrl+Shift+M): a pane beside the editor, laid
 * out by the same flex row as the split pane. Markdown is rendered by the
 * backend (pulldown-cmark — the exact renderer shared pages use), then local
 * targets are resolved here: `data-embed` images through the app's image
 * resolver, `data-wikilink` / `data-path` links back into the app.
 */

export interface PreviewHost {
  getText: () => string;
  getPath: () => string | null;
  isMarkdownish: (path: string) => boolean;
  resolveImage: (target: string) => Promise<string | null>;
  openWikilink: (target: string) => void;
  /** open a relative link target ("dir/note.md") from the current note */
  openRelPath: (target: string) => void;
  openExternal: (url: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

let host: PreviewHost;
let on = false;
let timer: number | undefined;
let renderSeq = 0;

export const previewOn = () => on;

export function initPreview(h: PreviewHost, onClose: () => void) {
  host = h;
  $("#preview-close").addEventListener("click", onClose);
  $("#preview-body").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const wiki = a.dataset.wikilink;
    const rel = a.dataset.path;
    if (wiki) host.openWikilink(wiki);
    else if (rel) host.openRelPath(rel);
    else if (/^https?:/i.test(a.href)) host.openExternal(a.href);
    else if (a.getAttribute("href")?.startsWith("#")) {
      document.getElementById(a.getAttribute("href")!.slice(1))?.scrollIntoView();
    }
  });
}

export function setPreview(v: boolean) {
  on = v;
  $("#preview").hidden = !v;
  if (v) void render();
}

/** Re-render soon (debounced — called on every keystroke while editing). */
export function schedulePreview() {
  if (!on) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void render(), 300);
}

/** Re-render now (file switched). */
export function refreshPreview() {
  if (!on) return;
  window.clearTimeout(timer);
  void render();
}

async function render() {
  const body = $("#preview-body");
  const path = host.getPath();
  // the bar names the note being previewed (mirrors the split pane's bar)
  $("#preview-name").textContent = path ? (path.split("/").pop() ?? "preview") : "preview";
  if (!path || !host.isMarkdownish(path)) {
    body.replaceChildren();
    const hint = document.createElement("div");
    hint.className = "preview-hint";
    hint.textContent = path ? "not a markdown file" : "no note open";
    body.appendChild(hint);
    return;
  }
  const mine = ++renderSeq;
  const html = await api.renderPreview(host.getText()).catch(() => null);
  if (mine !== renderSeq || html === null) return;
  const scroll = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = scroll;
  for (const img of body.querySelectorAll<HTMLImageElement>("img[data-embed]")) {
    void host.resolveImage(img.dataset.embed!).then((src) => {
      if (src && mine === renderSeq) img.src = src;
      else if (mine === renderSeq) {
        const missing = document.createElement("span");
        missing.className = "preview-missing";
        missing.textContent = `missing image: ${img.dataset.embed}`;
        img.replaceWith(missing);
      }
    });
  }
}
