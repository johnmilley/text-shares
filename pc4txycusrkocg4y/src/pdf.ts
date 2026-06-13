import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "./api";

/**
 * In-app PDF viewer: pages render to canvases as they scroll into view, each
 * with a pdf.js text layer on top so text can be selected and copied straight
 * into a note. Wired to the #pdf-view markup in index.html.
 */

// pdf.js is heavy (~1 MB) — load it the first time a PDF is actually opened
type PdfJs = typeof import("pdfjs-dist");
let pdfjs: PdfJs | null = null;
async function lib(): Promise<PdfJs> {
  if (!pdfjs) {
    pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

export const isPdfFile = (name: string) => /\.pdf$/i.test(name);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

let doc: PDFDocumentProxy | null = null;
let docPath: string | null = null;
let zoom = 1; // multiplier on fit-to-width
let pages: HTMLElement[] = [];
let observer: IntersectionObserver | null = null;
/** Bumped on close/zoom/reopen so stale async renders drop their results. */
let token = 0;
/** Stage width at last layout — refit only when it actually changes. */
let layoutWidth = 0;

const stage = () => $("#pdf-pages");

const clampZoom = (z: number) => Math.min(4, Math.max(0.4, z));

/** Scale that fits a scale-1 page width to the stage, times the user zoom. */
function fitScale(pageWidth: number): number {
  const available = stage().clientWidth - 32; // padding + scrollbar margin
  return Math.max(0.1, available / pageWidth) * zoom;
}

export async function openPdfDoc(path: string): Promise<void> {
  closePdfDoc();
  const mine = ++token;
  const { getDocument } = await lib();
  let loaded: PDFDocumentProxy;
  try {
    // asset protocol streams from disk with range requests — pdf.js only
    // fetches the pieces it needs, so large files open fast
    loaded = await getDocument({ url: convertFileSrc(path) }).promise;
  } catch {
    // protocol unavailable for this path — fall back to reading the bytes
    const { base64 } = await api.readImage(path);
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    loaded = await getDocument({ data }).promise;
  }
  if (mine !== token) {
    void loaded.loadingTask.destroy();
    return;
  }
  doc = loaded;
  docPath = path;
  zoom = 1;
  $("#pdf-name").textContent = path.split("/").pop() ?? path;
  $("#pdf-view").hidden = false;
  await buildPages();
}

export function closePdfDoc() {
  token++;
  observer?.disconnect();
  observer = null;
  pages = [];
  stage().replaceChildren();
  $("#pdf-view").hidden = true;
  void doc?.loadingTask.destroy();
  doc = null;
  docPath = null;
}

export const currentPdfPath = () => docPath;

/** Lay out one placeholder per page (sized like page 1 until rendered) and
 * render lazily as placeholders approach the viewport. */
async function buildPages() {
  if (!doc) return;
  const mine = token;
  const first = await doc.getPage(1);
  if (mine !== token) return;
  const base = first.getViewport({ scale: 1 });
  const scale = fitScale(base.width);
  const host = stage();
  layoutWidth = host.clientWidth;
  host.replaceChildren();
  observer?.disconnect();
  pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const div = document.createElement("div");
    div.className = "pdf-page";
    div.dataset.page = String(i);
    div.style.width = `${Math.floor(base.width * scale)}px`;
    div.style.height = `${Math.floor(base.height * scale)}px`;
    host.appendChild(div);
    pages.push(div);
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) void renderPage(e.target as HTMLElement);
      }
    },
    { root: host, rootMargin: "800px 0px" },
  );
  for (const p of pages) observer.observe(p);
  $("#pdf-zoom").textContent = `${Math.round(zoom * 100)}%`;
  updatePageInfo();
}

async function renderPage(div: HTMLElement) {
  if (!doc || div.dataset.rendered) return;
  div.dataset.rendered = "1";
  const mine = token;
  const page = await doc.getPage(Number(div.dataset.page));
  if (mine !== token) return;
  const viewport = page.getViewport({
    scale: fitScale(page.getViewport({ scale: 1 }).width),
  });
  div.style.width = `${Math.floor(viewport.width)}px`;
  div.style.height = `${Math.floor(viewport.height)}px`;
  // the text layer positions itself through these pdf.js CSS variables
  div.style.setProperty("--scale-factor", String(viewport.scale));
  div.style.setProperty("--total-scale-factor", String(viewport.scale));

  // render at device-pixel resolution so text stays crisp on hidpi screens
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  await page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;
  if (mine !== token) return;

  const { TextLayer } = await lib();
  const text = document.createElement("div");
  text.className = "textLayer";
  div.replaceChildren(canvas, text);
  await new TextLayer({
    textContentSource: page.streamTextContent(),
    container: text,
    viewport,
  }).render();
}

/** Re-render everything at the current zoom, keeping the scroll position. */
async function relayout() {
  if (!doc) return;
  token++;
  const host = stage();
  const ratio = host.scrollTop / Math.max(1, host.scrollHeight);
  await buildPages();
  host.scrollTop = ratio * host.scrollHeight;
}

function updatePageInfo() {
  if (!doc) return;
  const top = stage().scrollTop + 100;
  let current = 1;
  for (const p of pages) {
    if (p.offsetTop > top) break;
    current = Number(p.dataset.page);
  }
  const input = $<HTMLInputElement>("#pdf-page-input");
  // don't fight the user while they're typing a target page
  if (document.activeElement !== input) input.value = String(current);
  $("#pdf-page-total").textContent = `/ ${doc.numPages}`;
}

/** Scroll a 1-based page number to the top of the stage. */
function goToPage(n: number) {
  if (!doc) return;
  const clamped = Math.min(doc.numPages, Math.max(1, Math.floor(n)));
  const div = pages[clamped - 1];
  if (div) stage().scrollTo({ top: div.offsetTop - 8 });
}

// re-rendering every page is heavy — batch rapid zoom steps (wheel spins,
// held keyboard shortcuts)
let zoomTimer: number | undefined;
const scheduleRelayout = () => {
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => void relayout(), 150);
};

/** Step the zoom (also bound to Ctrl+= / Ctrl+- while a PDF is open). */
export function bumpPdfZoom(delta: number) {
  if (!doc) return;
  const next = clampZoom(Math.round((zoom + delta) * 10) / 10);
  if (next === zoom) return;
  zoom = next;
  $("#pdf-zoom").textContent = `${Math.round(zoom * 100)}%`;
  scheduleRelayout();
}

/** Back to fit-width (Ctrl+0 while a PDF is open). */
export function resetPdfZoom() {
  if (!doc) return;
  zoom = 1;
  $("#pdf-zoom").textContent = "100%";
  void relayout();
}

export function initPdfView() {
  const bumpZoom = bumpPdfZoom;
  $("#pdf-shrink").addEventListener("click", () => bumpZoom(-0.1));
  $("#pdf-grow").addEventListener("click", () => bumpZoom(0.1));
  $("#pdf-fit").addEventListener("click", resetPdfZoom);
  // jump to a typed page on Enter; revert to the live page on Escape/blur
  const pageInput = $<HTMLInputElement>("#pdf-page-input");
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = Number(pageInput.value.trim());
      if (Number.isFinite(n)) goToPage(n);
      pageInput.blur();
    } else if (e.key === "Escape") {
      pageInput.blur();
    }
    e.stopPropagation(); // keep editor/global shortcuts out of the field
  });
  pageInput.addEventListener("focus", () => pageInput.select());
  pageInput.addEventListener("blur", updatePageInfo);
  // Ctrl+wheel zooms (plain wheel keeps scrolling the pages)
  stage().addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !doc) return;
      e.preventDefault();
      bumpZoom(e.deltaY < 0 ? 0.1 : -0.1);
    },
    { passive: false },
  );
  stage().addEventListener("scroll", updatePageInfo, { passive: true });

  // refit when the stage changes size (window resize, sidebar toggle/drag),
  // once it settles
  let timer: number | undefined;
  new ResizeObserver(() => {
    const width = stage().clientWidth;
    if (!doc || width === layoutWidth || width === 0) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void relayout(), 200);
  }).observe(stage());
}
