import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { NoteMeta } from "./api";

/**
 * A small, Dataview-inspired query block. A fenced code block whose info
 * string is `dataview` renders its live results right below the fence:
 *
 *   ```dataview
 *   LIST FROM "projects"            — notes in a folder
 *   TABLE status, due FROM #course  — frontmatter fields as columns
 *   TASK FROM "daily"               — open `- [ ]` items
 *   ... SORT name DESC  /  ... LIMIT 20
 *   ```
 *
 * FROM accepts any mix of "folder" and #tag terms (all must match). SORT
 * fields: name, mtime, or any frontmatter key. The block stays plain text —
 * results are a widget, so the source survives sync/export untouched.
 */

export interface DataviewHost {
  /** all note metadata for the open folder (cached by the host) */
  data: () => Promise<NoteMeta[]>;
  /** subscribe to "the folder changed" — returns an unsubscribe */
  onInvalidate: (cb: () => void) => () => void;
  openNote: (path: string, line?: number) => void;
}

interface Query {
  kind: "list" | "table" | "task";
  columns: string[];
  folders: string[];
  tags: string[];
  sort: { field: string; desc: boolean } | null;
  limit: number | null;
}

export function parseQuery(src: string): Query | string {
  const text = src.trim().replace(/\s+/g, " ");
  if (!text) return "empty query — try: LIST FROM \"folder\" or TASK FROM #tag";
  const m = /^(list|table|task)\b\s*(.*)$/i.exec(text);
  if (!m) return `unknown query type — expected LIST, TABLE, or TASK`;
  const kind = m[1].toLowerCase() as Query["kind"];
  let rest = m[2];

  const query: Query = { kind, columns: [], folders: [], tags: [], sort: null, limit: null };

  const limitMatch = /\blimit\s+(\d+)\s*$/i.exec(rest);
  if (limitMatch) {
    query.limit = Number(limitMatch[1]);
    rest = rest.slice(0, limitMatch.index).trim();
  }
  const sortMatch = /\bsort\s+([\w.-]+)(?:\s+(asc|desc))?\s*$/i.exec(rest);
  if (sortMatch) {
    query.sort = { field: sortMatch[1].toLowerCase(), desc: sortMatch[2]?.toLowerCase() === "desc" };
    rest = rest.slice(0, sortMatch.index).trim();
  }
  const fromMatch = /\bfrom\b\s*(.*)$/i.exec(rest);
  if (fromMatch) {
    for (const term of fromMatch[1].match(/"[^"]*"|#[^\s]+/g) ?? []) {
      if (term.startsWith('"')) query.folders.push(term.slice(1, -1).replace(/^\/+|\/+$/g, ""));
      else query.tags.push(term.slice(1).toLowerCase());
    }
    if (!query.folders.length && !query.tags.length) {
      return `FROM expects "folder" or #tag terms`;
    }
    rest = rest.slice(0, fromMatch.index).trim();
  }
  if (kind === "table") {
    query.columns = rest
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    if (!query.columns.length) return "TABLE needs columns: TABLE field1, field2 FROM …";
  } else if (rest) {
    return `unexpected: "${rest}"`;
  }
  return query;
}

function fieldOf(note: NoteMeta, field: string): string {
  if (field === "name" || field === "file.name") return note.name;
  if (field === "mtime" || field === "file.mtime") {
    return new Date(note.mtime * 1000).toISOString().slice(0, 10);
  }
  if (field === "path" || field === "file.path") return note.rel;
  return note.fields[field] ?? "";
}

export function runQuery(query: Query, notes: NoteMeta[]): NoteMeta[] {
  let hits = notes.filter((n) => {
    const inFolder = !query.folders.length
      || query.folders.some((f) => n.rel === f || n.rel.startsWith(f + "/"));
    const hasTags = query.tags.every((t) => n.tags.some((x) => x === t || x.startsWith(t + "/")));
    return inFolder && hasTags;
  });
  if (query.kind === "task") hits = hits.filter((n) => n.tasks.some((t) => !t.done));
  const sort = query.sort;
  if (sort) {
    hits.sort((a, b) => {
      const cmp =
        sort.field === "mtime" || sort.field === "file.mtime"
          ? a.mtime - b.mtime
          : fieldOf(a, sort.field).localeCompare(fieldOf(b, sort.field), undefined, { numeric: true });
      return sort.desc ? -cmp : cmp;
    });
  }
  if (query.limit !== null) hits = hits.slice(0, query.limit);
  return hits;
}

// ---------------------------------------------------------------- widget

function renderResults(box: HTMLElement, query: Query, hits: NoteMeta[], host: DataviewHost) {
  box.replaceChildren();
  if (!hits.length) {
    box.appendChild(note("no results"));
    return;
  }
  const link = (n: NoteMeta, line?: number) => {
    const a = document.createElement("a");
    a.className = "dv-link";
    a.textContent = n.name;
    a.addEventListener("mousedown", (e) => {
      e.preventDefault();
      host.openNote(n.path, line);
    });
    return a;
  };
  if (query.kind === "list") {
    const ul = document.createElement("ul");
    for (const n of hits) {
      const li = document.createElement("li");
      li.appendChild(link(n));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  } else if (query.kind === "table") {
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const col of ["note", ...query.columns]) {
      const th = document.createElement("th");
      th.textContent = col;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const n of hits) {
      const tr = document.createElement("tr");
      const first = document.createElement("td");
      first.appendChild(link(n));
      tr.appendChild(first);
      for (const col of query.columns) {
        const td = document.createElement("td");
        td.textContent = fieldOf(n, col);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    box.appendChild(table);
  } else {
    // task
    const ul = document.createElement("ul");
    ul.className = "dv-tasks";
    for (const n of hits) {
      for (const t of n.tasks) {
        if (t.done) continue;
        const li = document.createElement("li");
        li.append("◻ ", t.text, " — ");
        li.appendChild(link(n, t.line));
        ul.appendChild(li);
      }
    }
    box.appendChild(ul);
  }
}

function note(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "dv-note";
  div.textContent = text;
  return div;
}

class DataviewWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly host: DataviewHost,
  ) {
    super();
  }

  eq(other: DataviewWidget) {
    return other.src === this.src;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "dv-results";
    const parsed = parseQuery(this.src);
    if (typeof parsed === "string") {
      box.appendChild(note(parsed));
      return box;
    }
    let alive = true; // cleared in destroy(); isConnected lies before attach
    const refresh = () => {
      void this.host.data().then((notes) => {
        if (!alive) return;
        renderResults(box, parsed, runQuery(parsed, notes), this.host);
        view.requestMeasure();
      });
    };
    refresh();
    const unsub = this.host.onInvalidate(refresh);
    box.addEventListener("dv-destroy", () => (alive = false));
    box.addEventListener("dv-destroy", unsub as EventListener);
    return box;
  }

  destroy(dom: HTMLElement) {
    dom.dispatchEvent(new Event("dv-destroy"));
  }
}

function buildBlocks(view: EditorView, host: DataviewHost): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "FencedCode") return;
        const open = doc.lineAt(node.from).text;
        if (!/^(`{3,}|~{3,})\s*dataview\s*$/i.test(open.trim())) return;
        const src = doc.sliceString(
          Math.min(doc.lineAt(node.from).to + 1, node.to),
          doc.lineAt(node.to).from,
        );
        // inline widget styled display:block (like image embeds) — view
        // plugins may not contribute true block decorations
        builder.add(
          node.to,
          node.to,
          Decoration.widget({ widget: new DataviewWidget(src.trim(), host), side: 1 }),
        );
      },
    });
  }
  return builder.finish();
}

export function dataviewBlocks(host: DataviewHost): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildBlocks(view, host);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = buildBlocks(update.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
