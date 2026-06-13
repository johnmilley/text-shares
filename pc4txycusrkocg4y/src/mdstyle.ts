import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Source-with-inline-styling: the markdown characters always stay visible,
 * but lines and spans get typographic treatment. Sizing/weight for block
 * elements is done with line classes (so `#` marks scale with their heading);
 * inline spans go through one HighlightStyle that doubles as the syntax
 * highlighting for code blocks and non-markdown files.
 */

const inlineHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
    color: "var(--heading)" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--fg-muted)" },
  { tag: t.monospace, color: "var(--code)" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--fg-muted)" },
  { tag: t.quote, color: "var(--quote)" },
  { tag: t.contentSeparator, color: "var(--fg-muted)" },
  { tag: [t.processingInstruction, t.meta, t.punctuation, t.labelName],
    color: "var(--fg-muted)" },
  // generic code tokens: code blocks and non-markdown files
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code)" },
  { tag: t.comment, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom, t.literal], color: "var(--tag)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--link)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--heading)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName)],
    color: "var(--fg)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--accent)" },
  { tag: t.invalid, color: "var(--fg)", textDecoration: "underline wavy var(--accent)" },
]);

const BLOCK_CLASSES: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6",
  SetextHeading1: "cm-h1",
  SetextHeading2: "cm-h2",
};

const MULTILINE_CLASSES: Record<string, string> = {
  FencedCode: "cm-codeblock",
  CodeBlock: "cm-codeblock",
  Blockquote: "cm-quoteline",
};

function buildLineStyles(view: EditorView): DecorationSet {
  const classes = new Map<number, string>();
  const add = (lineFrom: number, cls: string) => {
    const prev = classes.get(lineFrom);
    if (!prev) classes.set(lineFrom, cls);
    else if (!prev.split(" ").includes(cls)) classes.set(lineFrom, prev + " " + cls);
  };
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const single = BLOCK_CLASSES[node.name];
        if (single) {
          add(view.state.doc.lineAt(node.from).from, single);
          return;
        }
        const multi = MULTILINE_CLASSES[node.name];
        if (multi) {
          let line = view.state.doc.lineAt(node.from);
          for (;;) {
            add(line.from, multi);
            if (line.to >= node.to || line.to >= view.state.doc.length) break;
            line = view.state.doc.lineAt(line.to + 1);
          }
        }
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const from of [...classes.keys()].sort((a, b) => a - b)) {
    builder.add(from, from, Decoration.line({ class: classes.get(from)! }));
  }
  return builder.finish();
}

const lineStyles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLineStyles(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLineStyles(update.view);
      } else {
        const treeNow = syntaxTree(update.state);
        if (treeNow !== syntaxTree(update.startState)) {
          this.decorations = buildLineStyles(update.view);
        }
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** `inline code` spans: monospace + tinted background (styles.css), so
 * backticks read as code even when the editor font is proportional —
 * the same way bold/italic get their typographic treatment. */
function buildInlineCode(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name === "InlineCode") {
          builder.add(node.from, node.to, Decoration.mark({ class: "cm-inlinecode" }));
        }
      },
    });
  }
  return builder.finish();
}

const inlineCode = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineCode(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildInlineCode(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** YAML frontmatter at the top of the file, dimmed as metadata. */
function buildFrontmatter(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return builder.finish();
  let close = 0;
  for (let n = 2; n <= Math.min(doc.lines, 100); n++) {
    const text = doc.line(n).text.trim();
    if (text === "---" || text === "...") {
      close = n;
      break;
    }
  }
  if (!close) return builder.finish();
  for (let n = 1; n <= close; n++) {
    const line = doc.line(n);
    builder.add(line.from, line.from, Decoration.line({ class: "cm-frontmatter" }));
  }
  return builder.finish();
}

const frontmatter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFrontmatter(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildFrontmatter(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

const wikilinkDecorator = new MatchDecorator({
  regexp: WIKILINK_RE,
  decoration: Decoration.mark({ class: "cm-wikilink" }),
});

const wikilinks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikilinkDecorator.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = wikilinkDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const TAG_RE = /#[\p{L}\p{N}/_-]*\p{L}[\p{L}\p{N}/_-]*/gu;

const tagDecorator = new MatchDecorator({
  regexp: TAG_RE,
  decorate(add, from, _to, match, view) {
    // only when preceded by whitespace/start — keeps URL anchors etc. plain
    if (from > 0) {
      const before = view.state.doc.sliceString(from - 1, from);
      if (!/[\s([{]/.test(before)) return;
    }
    add(from, from + match[0].length, Decoration.mark({ class: "cm-hashtag" }));
  },
});

const hashtags = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tagDecorator.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = tagDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// task-list checkboxes: `- [ ]` / `- [x]`, clickable (toggled in editor.ts)
const CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\](?=\s|$)/g;

const checkboxDecorator = new MatchDecorator({
  regexp: CHECKBOX_RE,
  decorate(add, from, to, match) {
    const start = from + match[1].length;
    const checked = /[xX]/.test(match[0].slice(-2, -1));
    add(
      start,
      to,
      Decoration.mark({ class: "cm-checkbox" + (checked ? " cm-checked" : "") }),
    );
  },
});

const checkboxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = checkboxDecorator.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = checkboxDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Flip the `[ ]`/`[x]` covering `pos`, if any. Returns true when toggled. */
export function toggleCheckboxAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  CHECKBOX_RE.lastIndex = 0;
  const m = CHECKBOX_RE.exec(line.text);
  if (!m) return false;
  const from = line.from + m[1].length;
  const to = from + 3;
  if (pos < from || pos > to) return false;
  const checked = /[xX]/.test(line.text.charAt(m[1].length + 1));
  view.dispatch({ changes: { from: from + 1, to: to - 1, insert: checked ? " " : "x" } });
  return true;
}

/** Extensions for markdown documents. */
export function markdownStyling(): Extension {
  return [lineStyles, inlineCode, frontmatter, wikilinks, hashtags, checkboxes];
}

/** The shared highlight style (markdown inline + generic code tokens). */
export function baseHighlighting(): Extension {
  return syntaxHighlighting(inlineHighlight, { fallback: true });
}

// bare URLs and the (target) of markdown links — for Ctrl+click to browser
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]"']+/g;
const MD_LINK_RE = /\[[^\]\n]*\]\((https?:[^()\s]+)(?:\s+"[^"]*")?\)/g;

/** Find the external URL covering `pos` (bare, or a markdown link). */
export function urlAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(MD_LINK_RE)) {
    const from = line.from + (m.index ?? 0);
    if (pos >= from && pos <= from + m[0].length) return m[1];
  }
  for (const m of line.text.matchAll(BARE_URL_RE)) {
    const from = line.from + (m.index ?? 0);
    // trim trailing punctuation that's almost never part of the URL
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (pos >= from && pos <= from + url.length) return url;
  }
  return null;
}

/** Find the wikilink target covering `pos`, if any. */
export function wikilinkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  WIKILINK_RE.lastIndex = 0;
  for (const m of line.text.matchAll(WIKILINK_RE)) {
    const from = line.from + (m.index ?? 0);
    const to = from + m[0].length;
    if (pos >= from && pos <= to) {
      // strip |label and #heading parts
      return m[1].split("|")[0].split("#")[0].trim();
    }
  }
  return null;
}
