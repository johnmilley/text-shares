import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { vim } from "@replit/codemirror-vim";
import { baseHighlighting, markdownStyling, toggleCheckboxAt, urlAt, wikilinkAt } from "./mdstyle";
import { imageEmbeds, type ImageResolver } from "./images";
import { tableNextCell, tableNextRow, tablePrevCell } from "./tables";
import { dataviewBlocks, type DataviewHost } from "./dataview";

export interface NoteRef {
  name: string; // file name without extension
  path: string;
}

export interface EditorCallbacks {
  onDocChanged: () => void;
  onStatus: () => void;
  onSave: () => void;
  getNotes: () => NoteRef[];
  openWikilink: (target: string) => void;
  /** Open an http(s) URL in the system browser. */
  openExternal: (url: string) => void;
  resolveImage: ImageResolver;
  /** Save a pasted image; resolves to the file name to embed, or null. */
  importImageBlob: (blob: File) => Promise<string | null>;
  onNavBack: () => void;
  onNavForward: () => void;
  /** data + navigation for `dataview` query blocks (omit to disable) */
  dataview?: DataviewHost;
}

/** Files that get markdown styling, embeds, and link shortcuts. */
const isMarkdownish = (filename: string) =>
  /\.(md|markdown|mdown|txt|text)$/.test(filename.toLowerCase()) || !filename.includes(".");

const isMac = /Mac/i.test(navigator.platform);

/** Typewriter scrolling (zen mode): keep the cursor line vertically centered
 * while typing or moving. Dispatched on the next frame — dispatching from
 * inside an update listener is not allowed. */
const typewriterScroll = () =>
  EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    const head = update.state.selection.main.head;
    requestAnimationFrame(() => {
      if (update.view.state.selection.main.head !== head) return; // stale
      update.view.dispatch({
        effects: EditorView.scrollIntoView(head, { y: "center" }),
      });
    });
  });

const URL_RE = /^https?:\/\/\S+$/i;

const cmTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    fontSize: "var(--editor-font-size, 15px)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-editor)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    // margin-driven, not a fixed column: small margins by default so wide
    // data fits — size the window for prose. Zen mode centers a column.
    padding: "28px var(--editor-margin, 24px) 50vh",
    caretColor: "var(--cursor)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--fg-muted)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { background: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 45%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
  ".cm-panels": {
    backgroundColor: "var(--bg-panel)",
    color: "var(--fg)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    outline: "1px solid var(--accent)",
  },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-hover)",
    color: "var(--fg)",
  },
});

function wikiCompletions(getNotes: () => NoteRef[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const match = ctx.matchBefore(/\[\[[^[\]]*$/);
    if (!match) return null;
    return {
      from: match.from + 2,
      validFor: /^[^[\]]*$/,
      options: getNotes().map((note) => ({
        label: note.name,
        apply: (view, _completion, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          const insert = note.name + (closed ? "" : "]]");
          const cursor = from + note.name.length + 2;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: cursor },
          });
        },
      })),
    };
  };
}

/** Wrap the selection in `marker` when something is selected; with an empty
 * selection the keypress falls through and types the character normally
 * (regular markdown editor behaviour for `, like Ctrl+B/I for **‍/*). */
function wrapIfSelected(marker: string) {
  return (view: EditorView): boolean => {
    if (view.state.selection.ranges.every((r) => r.empty)) return false;
    return toggleWrap(marker)(view);
  };
}

/** Toggle `marker` (e.g. ** or *) around each selection range. */
function toggleWrap(marker: string) {
  return (view: EditorView): boolean => {
    const len = marker.length;
    const tr = view.state.changeByRange((range) => {
      const { from, to } = range;
      const before = view.state.sliceDoc(Math.max(0, from - len), from);
      const after = view.state.sliceDoc(to, to + len);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          range: EditorSelection.range(from - len, to - len),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + len, to + len),
      };
    });
    view.dispatch(tr);
    return true;
  };
}

/** Markdown link from the selection: [sel](cursor), or [cursor](sel) when the
 * selection is already a URL. */
function insertLink(view: EditorView): boolean {
  const tr = view.state.changeByRange((range) => {
    const sel = view.state.sliceDoc(range.from, range.to);
    if (URL_RE.test(sel)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${sel})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: `[${sel}]()` },
      range: EditorSelection.cursor(range.from + sel.length + 3),
    };
  });
  view.dispatch(tr);
  return true;
}

/** Set the selected lines to ATX heading `level`; same level toggles off. */
function setHeading(level: number) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes: { from: number; to: number; insert: string }[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const last = state.doc.lineAt(range.to).number;
      for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        if (!line.text && seen.size > 1) continue; // skip blanks in multi-line selections
        const m = /^(#{1,6})\s+/.exec(line.text);
        const insert = m && m[1].length === level ? "" : "#".repeat(level) + " ";
        changes.push({ from: line.from, to: line.from + (m?.[0].length ?? 0), insert });
      }
    }
    view.dispatch({ changes });
    return true;
  };
}

export class Editor {
  view: EditorView;
  private lang = new Compartment();
  private vimMode = new Compartment();
  private typewriter = new Compartment();
  private lineNos = new Compartment();
  private activeLine = new Compartment();
  private callbacks: EditorCallbacks;
  private vimOn = false;
  private typewriterOn = false;
  private lineNumbersOn = false;
  private highlightLineOn = true;
  private currentFile = "";
  private markdownish = true;

  constructor(parent: HTMLElement, callbacks: EditorCallbacks) {
    this.callbacks = callbacks;
    this.view = new EditorView({
      parent,
      state: this.makeState("", "untitled.md"),
    });
  }

  private extensions(): Extension[] {
    const cbs = this.callbacks;
    return [
      this.vimMode.of(this.vimOn ? vim() : []),
      this.typewriter.of(this.typewriterOn ? typewriterScroll() : []),
      this.lang.of([]),
      cmTheme,
      baseHighlighting(),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      this.lineNos.of(this.lineNumbersOn ? lineNumbers() : []),
      this.activeLine.of(this.highlightLineOn ? highlightActiveLine() : []),
      highlightSelectionMatches(),
      autocompletion({ override: [wikiCompletions(cbs.getNotes)], icons: false }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            cbs.onSave();
            return true;
          },
        },
        { key: "Mod-b", run: toggleWrap("**") },
        { key: "Mod-i", run: toggleWrap("*") },
        { key: "Mod-Shift-x", run: (view) => this.markdownish && toggleWrap("~~")(view) },
        { key: "Mod-k", run: (view) => this.markdownish && insertLink(view) },
        // ` around a selection makes it inline code (empty selection types `)
        { key: "`", run: (view) => this.markdownish && wrapIfSelected("`")(view) },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          key: `Mod-${level}`,
          run: (view: EditorView) => this.markdownish && setHeading(level)(view),
        })),
        // markdown tables: Tab/Shift+Tab hop cells, Enter hops rows, each
        // hop reformats the table (no-ops outside tables → defaults apply)
        {
          key: "Tab",
          run: (view) => this.markdownish && tableNextCell(view),
          shift: (view) => this.markdownish && tablePrevCell(view),
        },
        { key: "Enter", run: (view) => this.markdownish && tableNextRow(view) },
        // back/forward nav: Alt+arrows shadow defaultKeymap's cursor motion —
        // except on macOS, where Option+arrows must stay word motion; there
        // the Finder/Safari convention Cmd+[ / Cmd+] navigates instead
        ...(isMac
          ? [
              { key: "Mod-[", run: () => (cbs.onNavBack(), true) },
              { key: "Mod-]", run: () => (cbs.onNavForward(), true) },
            ]
          : [
              { key: "Alt-ArrowLeft", run: () => (cbs.onNavBack(), true) },
              { key: "Alt-ArrowRight", run: () => (cbs.onNavForward(), true) },
            ]),
        {
          key: "Mod-Enter",
          run: (view) => {
            const target = wikilinkAt(view, view.state.selection.main.head);
            if (!target) return false;
            cbs.openWikilink(target);
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          // plain click on a rendered task checkbox toggles it
          if (
            event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.target as HTMLElement).closest?.(".cm-checkbox") &&
            toggleCheckboxAt(view, pos)
          ) {
            event.preventDefault();
            return true;
          }
          if (!(event.ctrlKey || event.metaKey)) return false;
          const target = wikilinkAt(view, pos);
          if (target) {
            event.preventDefault();
            cbs.openWikilink(target);
            return true;
          }
          const url = urlAt(view, pos);
          if (url) {
            event.preventDefault();
            cbs.openExternal(url);
            return true;
          }
          return false;
        },
        paste: (event, view) => {
          if (!this.markdownish || !event.clipboardData) return false;
          // a clipboard image — screenshots arrive in .files, while images
          // copied from file managers / browsers often only appear in .items
          const cb = event.clipboardData;
          const image =
            [...cb.files].find((f) => f.type.startsWith("image/")) ??
            [...cb.items]
              .find((it) => it.kind === "file" && it.type.startsWith("image/"))
              ?.getAsFile() ??
            null;
          if (image) {
            event.preventDefault();
            void cbs.importImageBlob(image).then((name) => {
              if (!name) return;
              const { from, to } = view.state.selection.main;
              const insert = `![[${name}]]`;
              view.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + insert.length },
              });
            });
            return true;
          }
          // a URL pasted over selected text becomes a link
          const text = event.clipboardData.getData("text/plain").trim();
          const { from, to } = view.state.selection.main;
          if (from === to || !URL_RE.test(text)) return false;
          const sel = view.state.sliceDoc(from, to);
          if (URL_RE.test(sel)) return false; // replacing a URL — plain paste
          event.preventDefault();
          view.dispatch({
            changes: { from, to, insert: `[${sel}](${text})` },
            selection: { anchor: from + sel.length + text.length + 4 },
          });
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) cbs.onDocChanged();
        if (update.docChanged || update.selectionSet) cbs.onStatus();
      }),
    ];
  }

  private makeState(content: string, filename: string): EditorState {
    const state = EditorState.create({ doc: content, extensions: this.extensions() });
    this.currentFile = filename;
    this.markdownish = isMarkdownish(filename);
    return state;
  }

  /** Open a document: fresh state (own undo history), language by filename. */
  openDoc(content: string, filename: string) {
    this.view.setState(this.makeState(content, filename));
    void this.applyLanguage(filename);
  }

  /** Capture the live editor state for a backgrounded tab. The EditorState
   * carries the document, cursor, undo history, and language config. */
  snapshot(): { state: EditorState; scrollTop: number } {
    return { state: this.view.state, scrollTop: this.view.scrollDOM.scrollTop };
  }

  /** Bring a snapshot back (tab switch), restoring scroll once laid out. */
  restoreSnapshot(snap: { state: EditorState; scrollTop: number }, filename: string) {
    this.view.setState(snap.state);
    this.currentFile = filename;
    this.markdownish = isMarkdownish(filename);
    // the snapshot froze the compartments as they were when stashed — bring
    // them back in line with the current settings
    this.view.dispatch({
      effects: [
        this.lineNos.reconfigure(this.lineNumbersOn ? lineNumbers() : []),
        this.activeLine.reconfigure(this.highlightLineOn ? highlightActiveLine() : []),
        this.vimMode.reconfigure(this.vimOn ? vim() : []),
      ],
    });
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = snap.scrollTop;
    });
  }

  private async applyLanguage(filename: string) {
    if (isMarkdownish(filename)) {
      this.view.dispatch({
        effects: this.lang.reconfigure([
          // markdownLanguage = commonmark + GFM (tables, strikethrough, task lists)
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          markdownStyling(),
          imageEmbeds(this.callbacks.resolveImage),
          this.callbacks.dataview ? dataviewBlocks(this.callbacks.dataview) : [],
        ]),
      });
      return;
    }
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (!desc) {
      this.view.dispatch({ effects: this.lang.reconfigure([]) });
      return;
    }
    const support = await desc.load();
    if (this.currentFile === filename) {
      this.view.dispatch({ effects: this.lang.reconfigure(support) });
    }
  }

  /** Replace content in place (external reload), keeping the cursor put. */
  replaceContent(content: string) {
    const prev = this.view.state.selection.main.head;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
      selection: { anchor: Math.min(prev, content.length) },
    });
  }

  /** Insert text at the given client coordinates (file drop), or the cursor. */
  insertAt(text: string, coords?: { x: number; y: number }) {
    const pos =
      (coords ? this.view.posAtCoords(coords) : null) ?? this.view.state.selection.main.head;
    this.view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    this.view.focus();
  }

  setVim(on: boolean) {
    if (on === this.vimOn) return;
    this.vimOn = on;
    this.view.dispatch({ effects: this.vimMode.reconfigure(on ? vim() : []) });
  }

  setLineNumbers(on: boolean) {
    if (on === this.lineNumbersOn) return;
    this.lineNumbersOn = on;
    this.view.dispatch({ effects: this.lineNos.reconfigure(on ? lineNumbers() : []) });
  }

  setHighlightLine(on: boolean) {
    if (on === this.highlightLineOn) return;
    this.highlightLineOn = on;
    this.view.dispatch({
      effects: this.activeLine.reconfigure(on ? highlightActiveLine() : []),
    });
  }

  /** Zen mode: keep the cursor line vertically centered while editing. */
  setTypewriter(on: boolean) {
    if (on === this.typewriterOn) return;
    this.typewriterOn = on;
    this.view.dispatch({
      effects: this.typewriter.reconfigure(on ? typewriterScroll() : []),
    });
    if (on) {
      this.view.dispatch({
        effects: EditorView.scrollIntoView(this.view.state.selection.main.head, {
          y: "center",
        }),
      });
    }
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  focus() {
    this.view.focus();
  }

  jumpToLine(line: number) {
    const doc = this.view.state.doc;
    const pos = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    this.view.focus();
  }

  status(): { line: number; col: number; words: number; chars: number } {
    const state = this.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const text = state.doc.toString();
    const words = (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
    return {
      line: line.number,
      col: head - line.from + 1,
      words,
      chars: text.length,
    };
  }
}
