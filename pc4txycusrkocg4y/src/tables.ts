import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Markdown table editing, in the spirit of Obsidian's Advanced Tables:
 * Tab / Shift+Tab hop between cells (selecting the cell's content), Enter
 * moves down a row — creating one at the bottom, or exiting the table when
 * the last row is empty — and every hop reformats the table: pipes aligned,
 * widths padded, alignment colons (:--- :--: ---:) preserved.
 */

type Align = "left" | "center" | "right" | null;

const isTableLine = (text: string) => text.trimStart().startsWith("|");

/** Split a table line into trimmed cells, honoring escaped \| pipes. */
function splitCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

const isSepCell = (c: string) => /^:?-+:?$/.test(c);
const isSepRow = (cells: string[]) =>
  cells.some(isSepCell) && cells.every((c) => c === "" || isSepCell(c));

function alignOf(cell: string | undefined): Align {
  if (!cell || !isSepCell(cell)) return null;
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

interface Ctx {
  from: number; // doc offsets of the whole table block
  to: number;
  rows: string[][];
  sepIndex: number; // row index of the |---| separator, -1 when absent
  aligns: Align[];
  row: number; // cursor cell
  col: number;
}

/** The table block around the cursor, or null (multi-selections opt out). */
function tableAt(state: EditorState): Ctx | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const pos = sel.main.head;
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (!isTableLine(line.text)) return null;
  let first = line.number;
  let last = line.number;
  while (first > 1 && isTableLine(doc.line(first - 1).text)) first--;
  while (last < doc.lines && isTableLine(doc.line(last + 1).text)) last++;
  const rows: string[][] = [];
  for (let n = first; n <= last; n++) rows.push(splitCells(doc.line(n).text));
  const sepIndex = rows.findIndex(isSepRow);
  const cols = Math.max(...rows.map((r) => r.length));
  const aligns = Array.from({ length: cols }, (_, c) =>
    sepIndex >= 0 ? alignOf(rows[sepIndex][c]) : null,
  );
  // cursor cell = number of unescaped pipes before the cursor, minus the
  // leading pipe
  const before = line.text.slice(0, pos - line.from);
  let pipes = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "\\" && before[i + 1] === "|") i++;
    else if (before[i] === "|") pipes++;
  }
  const row = line.number - first;
  const col = Math.min(Math.max(pipes - 1, 0), cols - 1);
  return { from: doc.line(first).from, to: doc.line(last).to, rows, sepIndex, aligns, row, col };
}

function pad(text: string, width: number, align: Align): string {
  const extra = width - text.length;
  if (extra <= 0) return text;
  if (align === "right") return " ".repeat(extra) + text;
  if (align === "center") {
    const left = Math.floor(extra / 2);
    return " ".repeat(left) + text + " ".repeat(extra - left);
  }
  return text + " ".repeat(extra);
}

function sepCell(width: number, align: Align): string {
  if (align === "center") return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
  if (align === "right") return "-".repeat(Math.max(1, width - 1)) + ":";
  if (align === "left") return ":" + "-".repeat(Math.max(1, width - 1));
  return "-".repeat(width);
}

/** Render the table formatted; selection covers the (row, col) cell content
 * so navigation lands ready to overwrite. Offsets are block-relative. */
function build(rows: string[][], sepIndex: number, aligns: Align[], row: number, col: number) {
  const cols = Math.max(...rows.map((r) => r.length), aligns.length);
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.map((r, i) => (i === sepIndex ? 0 : (r[c] ?? "").length))),
  );
  const lines: string[] = [];
  let anchor = 0;
  let head = 0;
  let offset = 0;
  rows.forEach((r, i) => {
    let line = "|";
    for (let c = 0; c < cols; c++) {
      const align = aligns[c] ?? null;
      const cell = r[c] ?? "";
      if (i === row && c === col) {
        let start = offset + line.length + 1;
        if (align === "right") start += widths[c] - cell.length;
        else if (align === "center") start += Math.floor((widths[c] - cell.length) / 2);
        anchor = start;
        head = start + cell.length;
      }
      line += " " + (i === sepIndex ? sepCell(widths[c], align) : pad(cell, widths[c], align)) + " |";
    }
    lines.push(line);
    offset += line.length + 1;
  });
  return { text: lines.join("\n"), anchor, head };
}

/** Replace the block with its formatted form, cursor on (row, col); rows
 * are appended as needed (Tab past the last cell, Enter on the last row). */
function jump(view: EditorView, t: Ctx, row: number, col: number): boolean {
  const rows = t.rows.map((r) => [...r]);
  const cols = Math.max(...rows.map((r) => r.length), t.aligns.length);
  while (row >= rows.length) rows.push(Array(cols).fill(""));
  const { text, anchor, head } = build(rows, t.sepIndex, t.aligns, row, col);
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: text },
    selection: EditorSelection.range(t.from + anchor, t.from + head),
    scrollIntoView: true,
  });
  return true;
}

export function tableNextCell(view: EditorView): boolean {
  const t = tableAt(view.state);
  if (!t) return false;
  const cols = Math.max(...t.rows.map((r) => r.length), t.aligns.length);
  let { row, col } = t;
  col++;
  if (col >= cols) {
    col = 0;
    row++;
    if (row === t.sepIndex) row++;
  }
  return jump(view, t, row, col);
}

export function tablePrevCell(view: EditorView): boolean {
  const t = tableAt(view.state);
  if (!t) return false;
  const cols = Math.max(...t.rows.map((r) => r.length), t.aligns.length);
  let { row, col } = t;
  col--;
  if (col < 0) {
    row--;
    if (row === t.sepIndex) row--;
    if (row < 0) {
      row = t.row;
      col = 0;
    } else {
      col = cols - 1;
    }
  }
  return jump(view, t, row, col);
}

export function tableNextRow(view: EditorView): boolean {
  const t = tableAt(view.state);
  if (!t) return false;
  // Enter on an empty last row exits the table (like ending a list)
  const onLast = t.row === t.rows.length - 1;
  if (onLast && t.row !== t.sepIndex && t.rows[t.row].every((c) => !c)) {
    const { text } = build(t.rows.slice(0, -1), t.sepIndex, t.aligns, 0, 0);
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: text + "\n\n" },
      selection: { anchor: t.from + text.length + 2 },
      scrollIntoView: true,
    });
    return true;
  }
  let row = t.row + 1;
  if (row === t.sepIndex) row++;
  return jump(view, t, row, t.col);
}
