/** The markdown reference note, opened from settings. Written into the
 * notes folder once (never overwritten) so it can be edited and deleted
 * like any other note. Open it with the preview pane (Ctrl+Shift+M) for a
 * live side-by-side source/result comparison. */

export const DEMO_FILE = "markdown reference.md";

export const DEMO_NOTE = `---
status: example
tags: reference
---

# markdown reference

Open the preview (Ctrl+Shift+M) to see this note rendered side by side
with its source. Everything below works in the editor, the preview, and
on shared pages.

## headings

# h1 · ## h2 · ### h3 — \`#\` through \`######\` at line start.
Ctrl+1…Ctrl+6 set a heading level; repeating the same level clears it.

## inline styles

**bold** (Ctrl+B) · *italic* (Ctrl+I) · ~~strikethrough~~ (Ctrl+Shift+X) ·
\`inline code\` — select text and press \` to wrap it.

## links

- [a markdown link](https://example.com) — Ctrl+K wraps the selection
- a bare URL: https://example.com (Ctrl+click opens in the browser)
- a wikilink to another note: [[markdown reference]] — Ctrl+Enter follows it
- with a label: [[markdown reference|this very note]]
- to a section: [[markdown reference#tables]]

## lists & tasks

1. ordered
2. lists
   - nested bullets
   - another

- [ ] open task — click the brackets to toggle
- [x] done task

## tables

Tab / Shift+Tab hop between cells (auto-formats); Enter adds a row.

| feature   | shortcut     | notes                  |
| --------- | ------------ | ---------------------- |
| bold      | Ctrl+B       | wraps the selection    |
| heading   | Ctrl+1…6     | repeat to clear        |
| preview   | Ctrl+Shift+M | rendered split view    |

## quotes & rules

> a blockquote — useful for citations.
> it can span lines.

A horizontal rule (also splits slides in presentations):

---

## code blocks

\`\`\`python
def hello(name: str) -> str:
    return f"hi {name}"   # syntax highlighting by language
\`\`\`

## embeds

![[photo.png]] embeds an image (also \`![[photo.png|300]]\` for a width);
\`![alt](path/to/img.png)\` works too. Drop or paste images straight into
a note. \`![[lecture.pdf]]\` becomes an attachment link on shared pages.

## tags & frontmatter

This note has YAML frontmatter at the top (the dimmed block) and a tag:
#reference — both are queryable below.

## dataview queries

A fenced block with the language \`dataview\` shows live results:

\`\`\`dataview
LIST FROM #reference
\`\`\`

Also: \`TABLE status, tags FROM "folder" SORT mtime DESC LIMIT 10\`
and \`TASK FROM "folder"\` for open checkboxes.

## presentations

Add \`slides: true\` to a note's frontmatter and share its folder: the note
becomes a slide deck on the shared site, one slide per \`---\` separator.
`;
