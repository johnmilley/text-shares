import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as api from "./api";

/** Resolve a link target (wikilink name, relative path, URL) to an img src. */
export type ImageResolver = (target: string) => Promise<string | null>;

/** Formats the standalone viewer opens. SVG stays editable as text. */
export const isViewableImage = (name: string) =>
  /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i.test(name);

/** Formats inline embeds will render (SVG included). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|svg)$/i;

/** Audio formats the built-in player opens. */
export const isAudioFile = (name: string) =>
  /\.(mp3|wav|ogg|oga|m4a|flac|opus|aac|weba)$/i.test(name);

/** Video formats recognized in the tree. Opening one hands the file to the
 * system's default player — in-app playback through WebKitGTK is software-
 * decoded and crash-prone, so the app never plays video itself. */
export const isVideoFile = (name: string) =>
  /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(name);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  opus: "audio/ogg",
  aac: "audio/aac",
  weba: "audio/webm",
};

// ---------------------------------------------------------------- loading

const cache = new Map<string, Promise<string>>();

/** Read an image from disk as a data URL, cached per path. */
export function loadImage(path: string): Promise<string> {
  let hit = cache.get(path);
  if (!hit) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    hit = api
      .readImage(path)
      .then((img) => `data:${MIME[ext] ?? "application/octet-stream"};base64,${img.base64}`);
    hit.catch(() => cache.delete(path));
    cache.set(path, hit);
  }
  return hit;
}

export function invalidateImage(path: string) {
  cache.delete(path);
  invalidateAudio(path);
}

// ---------------------------------------------------------------- audio

import { convertFileSrc } from "@tauri-apps/api/core";

const audioUrls = new Map<string, string>(); // path → blob object URL

/** Load an audio file as a blob URL. The asset protocol streams fine for
 * fetch() (pdf.js relies on it), but WebKitGTK's media player can't play
 * from the custom scheme directly on some systems — a blob URL sidesteps
 * that. Falls back to reading the bytes over IPC. */
export async function loadAudio(path: string): Promise<string> {
  const hit = audioUrls.get(path);
  if (hit) return hit;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  let bytes: ArrayBuffer | Uint8Array;
  try {
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) throw new Error(`status ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch {
    const { base64 } = await api.readImage(path); // generic byte read
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  audioUrls.set(path, url);
  return url;
}

export function invalidateAudio(path: string) {
  const url = audioUrls.get(path);
  if (url) {
    URL.revokeObjectURL(url);
    audioUrls.delete(path);
  }
}

// ---------------------------------------------------------------- embeds

// ![[image.png]] and ![[image.png|300]], or standard ![alt](path "title")
const EMBED_RE = /!\[\[([^[\]\n]+)\]\]|!\[[^\]\n]*\]\(([^()\n]+)\)/g;

function parseEmbed(match: RegExpExecArray): { target: string; width: number | null } | null {
  if (match[1] !== undefined) {
    const [name, mod] = match[1].split("|");
    const target = name.trim();
    if (!IMAGE_EXT_RE.test(target)) return null;
    const width = mod && /^\d+$/.test(mod.trim()) ? Number(mod.trim()) : null;
    return { target, width };
  }
  let src = match[2].trim();
  if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1).trim();
  else src = src.split(/\s+["']/)[0].trim();
  if (!src) return null;
  // remote URLs are always images here (it's image syntax); local paths
  // only when the extension says so, to leave e.g. ![doc](notes.md) alone
  if (!/^(https?:|data:)/i.test(src) && !IMAGE_EXT_RE.test(src)) return null;
  return { target: src, width: null };
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly target: string,
    private readonly width: number | null,
    private readonly resolve: ImageResolver,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.target === this.target && other.width === this.width;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-embed";
    const img = document.createElement("img");
    img.alt = this.target;
    if (this.width) img.style.maxWidth = `${this.width}px`;
    img.addEventListener("load", () => view.requestMeasure());
    wrap.appendChild(img);
    void this.resolve(this.target).then((src) => {
      if (src) {
        img.src = src;
      } else {
        img.remove();
        wrap.classList.add("cm-image-missing");
        wrap.textContent = `missing image: ${this.target}`;
        view.requestMeasure();
      }
    });
    return wrap;
  }
}

/** Render image links inline below their markdown source, Obsidian-style. */
export function imageEmbeds(resolve: ImageResolver): Extension {
  const decorator = new MatchDecorator({
    regexp: EMBED_RE,
    decorate(add, _from, to, match) {
      const parsed = parseEmbed(match);
      if (!parsed) return;
      add(
        to,
        to,
        Decoration.widget({
          widget: new ImageWidget(parsed.target, parsed.width, resolve),
          side: 1,
        }),
      );
    },
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
