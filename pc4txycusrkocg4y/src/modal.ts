import { fuzzyFilter } from "./fuzzy";

export interface PickerItem {
  label: string;
  detail?: string;
  value: string;
  /** label for an inline action button on the row (e.g. "pin"/"unpin") */
  actionLabel?: string;
  /** tooltip for the action button */
  actionTitle?: string;
}

interface PickerOpts {
  placeholder: string;
  /** Called as the highlighted row changes (e.g. live theme preview) — but
   * only after the user actually moves the highlight (keys, hover, typing);
   * merely opening the picker never fires it. */
  onHighlight?: (item: PickerItem | null) => void;
  /** if set, called with free text when nothing matches and Enter is hit */
  onFreeText?: (text: string) => void;
  freeTextHint?: string;
  /** invoked when a row's inline action button is clicked. May mutate the
   * `items` array in place; the picker re-renders afterwards. */
  onAction?: (item: PickerItem) => void;
}

let openModal: (() => void) | null = null;

export function closeModal() {
  openModal?.();
  openModal = null;
}

function buildModal(): { overlay: HTMLElement; box: HTMLElement } {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  openModal = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  return { overlay, box };
}

/** Fuzzy picker over a list. Resolves with the chosen item, or null. */
export function pick(items: PickerItem[], opts: PickerOpts): Promise<PickerItem | null> {
  return new Promise((resolve) => {
    const { box } = buildModal();
    const input = document.createElement("input");
    input.className = "modal-input";
    input.placeholder = opts.placeholder;
    const list = document.createElement("div");
    list.className = "modal-list";
    box.append(input, list);

    let shown: PickerItem[] = [];
    let sel = 0;
    let done = false;
    let interacted = false; // suppresses onHighlight until the user moves

    const finish = (item: PickerItem | null) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(item);
    };

    const render = () => {
      shown = fuzzyFilter(input.value, items, (i) => i.label + " " + (i.detail ?? ""));
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...shown.map((item, i) => {
          const row = document.createElement("div");
          row.className = "modal-row" + (i === sel ? " selected" : "");
          const label = document.createElement("span");
          label.textContent = item.label;
          row.appendChild(label);
          if (item.detail) {
            const detail = document.createElement("span");
            detail.className = "modal-detail";
            detail.textContent = item.detail;
            row.appendChild(detail);
          }
          if (item.actionLabel && opts.onAction) {
            const btn = document.createElement("button");
            btn.className = "modal-row-action";
            btn.textContent = item.actionLabel;
            if (item.actionTitle) btn.title = item.actionTitle;
            // act without choosing the row; let the caller mutate items, then redraw
            btn.addEventListener("mousedown", (e) => {
              e.preventDefault();
              e.stopPropagation();
              opts.onAction!(item);
              render();
            });
            row.appendChild(btn);
          }
          row.addEventListener("mousemove", () => {
            if (sel !== i) {
              sel = i;
              interacted = true;
              render();
            }
          });
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            finish(item);
          });
          return row;
        }),
      );
      if (!shown.length && opts.onFreeText && input.value.trim()) {
        const row = document.createElement("div");
        row.className = "modal-row selected";
        row.textContent = `${opts.freeTextHint ?? "Create"}: ${input.value.trim()}`;
        list.appendChild(row);
      }
      list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
      if (interacted) opts.onHighlight?.(shown[sel] ?? null);
    };

    input.addEventListener("input", () => {
      sel = 0;
      interacted = true;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        sel = Math.min(sel + 1, shown.length - 1);
        interacted = true;
        render();
        e.preventDefault();
      } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        sel = Math.max(sel - 1, 0);
        interacted = true;
        render();
        e.preventDefault();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[sel]) finish(shown[sel]);
        else if (opts.onFreeText && input.value.trim()) {
          const text = input.value.trim();
          done = true;
          closeModal();
          opts.onFreeText(text);
          resolve(null);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });
    render();
    input.focus();
  });
}

/** Generic dismissable box (Escape / click outside); caller fills it in. */
export function infoBox(build: (box: HTMLElement) => void) {
  const { box } = buildModal();
  build(box);
}

/** One-line text prompt. Resolves with the string, or null on cancel. */
export function promptText(label: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const { box } = buildModal();
    const caption = document.createElement("div");
    caption.className = "modal-caption";
    caption.textContent = label;
    const input = document.createElement("input");
    input.className = "modal-input";
    input.value = initial;
    box.append(caption, input);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      closeModal();
      resolve(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value.trim() || null);
      else if (e.key === "Escape") finish(null);
    });
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });
}

/** Small confirm dialog. */
export function confirmBox(message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { box } = buildModal();
    const caption = document.createElement("div");
    caption.className = "modal-caption";
    caption.textContent = message;
    const row = document.createElement("div");
    row.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = action;
    ok.className = "danger";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    row.append(cancel, ok);
    box.append(caption, row);
    const finish = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    });
    ok.focus();
  });
}
