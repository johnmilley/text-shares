import * as api from "./api";
import { confirmBox, infoBox } from "./modal";

/**
 * Share dialog: publish a folder as a static site on GitHub Pages (one
 * unguessable slug per share), update it from the current folder contents,
 * and destroy the link. Backed by share.rs; nothing is shared by default.
 */

const fmtDate = (secs: number) => new Date(secs * 1000).toLocaleDateString();

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function openShareDialog(folder: string) {
  infoBox((box) => {
    box.classList.add("share-box");
    const caption = el("div", "modal-caption", `share "${folder.split("/").pop()}"`);
    const body = el("div", "share-body");
    box.append(caption, body);
    // expired shares vanish before we show anything as live
    void api
      .cleanupShares()
      .catch(() => [])
      .then(() => api.shareStatus(folder))
      .then((status) => render(body, folder, status))
      .catch((err) => body.replaceChildren(el("div", "share-error", String(err))));
    body.replaceChildren(el("div", "share-status", "checking…"));
  });
}

function render(body: HTMLElement, folder: string, status: api.ShareStatus) {
  body.replaceChildren();
  if (status.entry) renderActive(body, status.entry);
  else renderCreate(body, folder);
  renderOrphans(body, status.orphans, folder);
}

/** Setup steps, shown collapsed in the create view and expanded on tooling
 * errors. Sharing runs entirely on the local user's own GitHub account —
 * anyone can use it once the gh CLI is signed in. */
function setupHelp(open: boolean): HTMLElement {
  const details = document.createElement("details");
  details.className = "share-setup";
  if (open) details.open = true;
  const summary = el("summary", "", "how sharing works / set it up with your own GitHub");
  const steps = el("div", "share-note");
  steps.append(
    "sharing publishes to a public ",
    el("code", "", "text-shares"),
    " repo on your own GitHub account (GitHub Pages) — no third-party server, no stored tokens. one-time setup:",
  );
  const list = document.createElement("ol");
  for (const step of [
    "create a free github.com account (if you don't have one)",
    "install the GitHub CLI: https://cli.github.com (e.g. `dnf install gh` / `brew install gh`)",
    "sign in once: run `gh auth login` in a terminal",
  ]) {
    const li = document.createElement("li");
    li.textContent = step;
    list.appendChild(li);
  }
  const tail = el(
    "div",
    "share-note",
    "after that, every share/update/destroy here acts on your account. " +
      "the app creates the repo and enables Pages automatically on first share.",
  );
  details.append(summary, steps, list, tail);
  return details;
}

// ------------------------------------------------------------ create view

function renderCreate(body: HTMLElement, folder: string) {
  const note = el(
    "div",
    "share-note",
    "publishes this folder as a website on GitHub Pages. the link is " +
      "unguessable but public — anyone who has it can read the content.",
  );

  const expiry = el("div", "share-expiry");
  const choices: [string, number | null][] = [
    ["1 day", 1],
    ["1 week", 7],
    ["1 month", 30],
    ["never", null],
  ];
  let expires: number | null = 7;
  const dateInput = el("input", "share-date") as HTMLInputElement;
  dateInput.type = "date";
  dateInput.title = "expire on a specific date";
  const buttons = choices.map(([label, days]) => {
    const b = el("button", days === expires ? "selected" : "", label);
    b.addEventListener("click", () => {
      expires = days;
      dateInput.value = "";
      dateInput.classList.remove("selected");
      for (const other of buttons) other.classList.remove("selected");
      b.classList.add("selected");
    });
    return b;
  });
  // a custom calendar date converts to whole days from now (rounded up)
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    const target = new Date(dateInput.value + "T23:59:59").getTime();
    const days = Math.ceil((target - Date.now()) / 86_400_000);
    if (days < 1) {
      dateInput.value = ""; // past dates make no sense for an expiry
      return;
    }
    expires = days;
    for (const other of buttons) other.classList.remove("selected");
    dateInput.classList.add("selected");
  });
  expiry.append(el("span", "share-caption", "link expires:"), ...buttons, dateInput);

  const commentsRow = el("div", "share-expiry");
  const commentsBox = el("input") as HTMLInputElement;
  commentsBox.type = "checkbox";
  commentsBox.id = "share-comments";
  const commentsLabel = el("label", "share-caption", "reader comments (GitHub Discussions)");
  commentsLabel.setAttribute("for", "share-comments");
  commentsRow.append(commentsBox, commentsLabel);
  const commentsNote = el(
    "div",
    "share-note",
    "readers comment through giscus with their GitHub accounts; threads live in " +
      "your text-shares repo's Discussions. one-time: install the giscus app on " +
      "that repo at github.com/apps/giscus (comments stay blank until then).",
  );
  commentsNote.hidden = true;
  commentsBox.addEventListener("change", () => (commentsNote.hidden = !commentsBox.checked));

  const statusLine = el("div", "share-status", "");
  const row = el("div", "modal-buttons");
  const create = el("button", "danger", "create share");
  row.appendChild(create);

  create.addEventListener("click", () => {
    create.disabled = true;
    statusLine.textContent = "exporting and pushing — this can take a minute…";
    api
      .createShare(folder, expires, commentsBox.checked)
      .then((result) => {
        body.replaceChildren();
        renderActive(body, result.share, result);
        void navigator.clipboard?.writeText(result.share.url).catch(() => {});
      })
      .catch((err) => {
        create.disabled = false;
        statusLine.replaceChildren(el("span", "share-error", String(err)));
        // tooling problems → unfold the setup instructions
        const msg = String(err).toLowerCase();
        if (msg.includes("gh") || msg.includes("git") || msg.includes("signed in")) {
          body.querySelector<HTMLDetailsElement>(".share-setup")?.toggleAttribute("open", true);
        }
      });
  });

  body.append(note, expiry, commentsRow, commentsNote, statusLine, row, setupHelp(false));
}

// ------------------------------------------------------------ active view

function renderActive(body: HTMLElement, share: api.ShareEntry, result?: api.ShareResult) {
  const url = el("div", "share-url");
  const link = el("a", "", share.url);
  link.href = share.url;
  link.target = "_blank";
  url.appendChild(link);

  const meta = el(
    "div",
    "share-note",
    `created ${fmtDate(share.created)} · ` +
      (share.expires ? `expires ${fmtDate(share.expires)}` : "never expires") +
      (share.comments ? " · comments on" : ""),
  );
  if (share.comments) {
    meta.append(
      el(
        "div",
        "share-note",
        "comments need the giscus app installed once on " +
          `${share.comments.repo} — github.com/apps/giscus`,
      ),
    );
  }

  const statusLine = el("div", "share-status", "");
  if (result) {
    const what = result.pushed ? `published · ${result.pages} pages` : "already up to date";
    statusLine.textContent = `${what} — link copied. first publish can take a couple of minutes to go live.`;
    if (result.skipped.length) {
      statusLine.append(
        el("div", "share-error", `skipped (too large): ${result.skipped.join(", ")}`),
      );
    }
  }

  const row = el("div", "modal-buttons");
  const copy = el("button", "", "copy link");
  const update = el("button", "", "update");
  const destroy = el("button", "danger", "destroy link");
  row.append(copy, update, destroy);

  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(share.url);
    statusLine.textContent = "link copied";
  });

  update.addEventListener("click", () => {
    update.disabled = true;
    statusLine.textContent = "re-exporting and pushing…";
    api
      .updateShare(share.folder)
      .then((r) => {
        update.disabled = false;
        statusLine.textContent = r.pushed ? `updated · ${r.pages} pages` : "already up to date";
        if (r.skipped.length) {
          statusLine.append(
            el("div", "share-error", `skipped (too large): ${r.skipped.join(", ")}`),
          );
        }
      })
      .catch((err) => {
        update.disabled = false;
        statusLine.replaceChildren(el("span", "share-error", String(err)));
      });
  });

  destroy.addEventListener("click", async () => {
    // confirmBox replaces this modal; reopen the dialog with the outcome
    const ok = await confirmBox("destroy this share link? the site goes away.", "Destroy");
    if (!ok) return openShareDialog(share.folder);
    try {
      await api.destroyShare(share.folder);
      openShareDialog(share.folder);
    } catch (err) {
      infoBox((box) => {
        box.append(
          el("div", "modal-caption", "destroy failed"),
          el("div", "share-error", String(err)),
        );
      });
    }
  });

  body.append(url, meta, statusLine, row);
}

// ------------------------------------------------------------ orphans

/** Registry entries whose folders vanished (renamed/moved after sharing). */
function renderOrphans(body: HTMLElement, orphans: api.ShareEntry[], current: string) {
  const dead = orphans.filter((o) => o.folder !== current);
  if (!dead.length) return;
  const section = el("div", "share-orphans");
  section.appendChild(
    el("div", "share-caption", "shares whose folder no longer exists:"),
  );
  for (const o of dead) {
    const row = el("div", "share-orphan-row");
    row.appendChild(el("span", "", o.folder));
    const destroy = el("button", "", "destroy link");
    destroy.addEventListener("click", () => {
      destroy.disabled = true;
      api
        .destroyShare(o.folder)
        .then(() => row.remove())
        .catch((err) => {
          destroy.disabled = false;
          row.appendChild(el("div", "share-error", String(err)));
        });
    });
    row.appendChild(destroy);
    section.appendChild(row);
  }
  body.appendChild(section);
}
