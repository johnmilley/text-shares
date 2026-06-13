import type { Config } from "./api";
import { baseKey } from "./keys";
import { infoBox } from "./modal";

/**
 * The settings panel (Ctrl+,): a friendly face over config.toml. Everything
 * applies immediately and saves through the host; the raw file stays
 * available for hand-editing at the bottom.
 */

export interface SettingsHost {
  config: Config;
  /** persist the config (debounced by the host) */
  save(): void;
  applyFontSizes(): void;
  applyMargin(): void;
  applyVim(): void;
  /** line numbers + current-line highlight */
  applyEditorView(): void;
  /** open the bundled markdown reference note */
  openDemo(): void;
  /** closes settings (pickers replace the modal) */
  pickTheme(): void;
  pickFont(): void;
  openConfigFile(): void;
  /** current editor-font display label ("theme default", "Inter", …) */
  fontLabel(): string;
  actions: { id: string; combo: string; what: string }[];
  effectiveCombo(id: string): string;
  /** combo = null resets the action to its default */
  setKey(id: string, combo: string | null): void;
  isOverridden(id: string): boolean;
  prettyCombo(combo: string): string;
}

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

export function openSettings(host: SettingsHost) {
  infoBox((box) => {
    box.classList.add("settings-box");
    box.appendChild(el("div", "modal-caption", "settings"));
    const body = el("div", "settings-body");
    box.appendChild(body);

    const section = (title: string) => {
      body.appendChild(el("div", "settings-section", title));
    };
    const row = (label: string, control: HTMLElement, hint?: string) => {
      const r = el("div", "set-row");
      const left = el("div", "set-label", label);
      if (hint) left.appendChild(el("div", "set-hint", hint));
      r.append(left, control);
      body.appendChild(r);
      return r;
    };

    // ---------------------------------------------------------- appearance
    section("appearance");

    const themeBtn = el("button", "set-btn", host.config.theme);
    themeBtn.addEventListener("click", host.pickTheme);
    row("theme", themeBtn, "live preview while browsing");

    const fontBtn = el("button", "set-btn", host.fontLabel());
    fontBtn.addEventListener("click", host.pickFont);
    row("editor font", fontBtn);

    const stepper = (
      get: () => number,
      set: (n: number) => void,
      lo: number,
      hi: number,
      apply: () => void,
      step = 1,
    ) => {
      const wrap = el("span", "set-stepper");
      const minus = el("button", "", "−");
      const value = el("span", "set-value", String(get()));
      const plus = el("button", "", "+");
      const bump = (d: number) => {
        set(Math.min(hi, Math.max(lo, get() + d)));
        value.textContent = String(get());
        apply();
        host.save();
      };
      minus.addEventListener("click", () => bump(-step));
      plus.addEventListener("click", () => bump(step));
      wrap.append(minus, value, plus);
      return wrap;
    };
    row(
      "editor font size",
      stepper(() => host.config.font_size, (n) => (host.config.font_size = n), 9, 40, host.applyFontSizes),
    );
    row(
      "UI font size",
      stepper(() => host.config.ui_font_size, (n) => (host.config.ui_font_size = n), 9, 28, host.applyFontSizes),
      "sidebar, tabs, dialogs",
    );
    row(
      "editor margins",
      stepper(
        () => host.config.editor_margin,
        (n) => (host.config.editor_margin = n),
        0,
        400,
        host.applyMargin,
        8,
      ),
      "px between text and window edge — small keeps wide data usable",
    );

    const checkbox = (
      get: () => boolean,
      set: (v: boolean) => void,
      apply: () => void,
    ) => {
      const input = el("input") as HTMLInputElement;
      input.type = "checkbox";
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        apply();
        host.save();
      });
      return input;
    };

    row(
      "line numbers",
      checkbox(
        () => host.config.line_numbers,
        (v) => (host.config.line_numbers = v),
        host.applyEditorView,
      ),
    );
    row(
      "highlight current line",
      checkbox(
        () => host.config.highlight_line,
        (v) => (host.config.highlight_line = v),
        host.applyEditorView,
      ),
    );

    // ------------------------------------------------------------- editing
    section("editing");

    row(
      "vim mode",
      checkbox(
        () => host.config.vim_mode,
        (v) => (host.config.vim_mode = v),
        host.applyVim,
      ),
      "modal editing via codemirror-vim",
    );

    // --------------------------------------------------------------- files
    section("files");

    const textInput = (get: () => string, set: (v: string) => void, placeholder: string) => {
      const input = el("input", "set-input") as HTMLInputElement;
      input.value = get();
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.addEventListener("change", () => {
        set(input.value.trim());
        host.save();
      });
      return input;
    };
    row(
      "daily notes folder",
      textInput(() => host.config.daily_dir, (v) => (host.config.daily_dir = v || "daily"), "daily"),
      "relative to the notes folder",
    );
    row(
      "images folder",
      textInput(() => host.config.image_dir, (v) => (host.config.image_dir = v), "(folder root)"),
      "where dropped/pasted images land",
    );

    // ----------------------------------------------------------- shortcuts
    section("shortcuts");
    body.appendChild(
      el("div", "set-hint settings-keys-hint", "click a shortcut, then press the new keys (needs ctrl or alt; esc cancels)"),
    );

    const keyRows = new Map<string, { kbd: HTMLElement; reset: HTMLElement }>();

    const refreshKeys = () => {
      // mark combos used twice
      const used = new Map<string, string[]>();
      for (const a of host.actions) {
        const combo = host.effectiveCombo(a.id);
        used.set(combo, [...(used.get(combo) ?? []), a.what]);
      }
      for (const a of host.actions) {
        const entry = keyRows.get(a.id);
        if (!entry) continue;
        const combo = host.effectiveCombo(a.id);
        entry.kbd.textContent = host.prettyCombo(combo);
        const clash = (used.get(combo) ?? []).length > 1;
        entry.kbd.classList.toggle("conflict", clash);
        entry.kbd.title = clash
          ? `also bound to: ${used.get(combo)!.filter((w) => w !== a.what).join(", ")}`
          : "click to rebind";
        (entry.reset as HTMLButtonElement).hidden = !host.isOverridden(a.id);
      }
    };

    let capturing: (() => void) | null = null;

    const captureFor = (id: string, kbd: HTMLElement) => {
      capturing?.(); // cancel a previous capture
      kbd.textContent = "press keys…";
      kbd.classList.add("capturing");
      const done = () => {
        window.removeEventListener("keydown", onKey, true);
        kbd.classList.remove("capturing");
        capturing = null;
        refreshKeys();
      };
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return done();
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          kbd.textContent = "needs ctrl or alt…";
          return;
        }
        // store the *unshifted* key (ctrl+shift+\, not ctrl+shift+|), so the
        // combo matches what the dispatcher in main.ts looks up
        const key = baseKey(e) ?? e.key.toLowerCase();
        const combo =
          `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}` +
          `${e.altKey ? "alt+" : ""}${key}`;
        host.setKey(id, combo);
        done();
      };
      capturing = done;
      window.addEventListener("keydown", onKey, true);
    };

    for (const a of host.actions) {
      const wrap = el("span", "set-key");
      const kbd = el("kbd");
      kbd.addEventListener("click", () => captureFor(a.id, kbd));
      const reset = el("button", "set-key-reset", "↺");
      reset.title = `reset to ${host.prettyCombo(a.combo)}`;
      reset.addEventListener("click", () => {
        host.setKey(a.id, null);
        refreshKeys();
      });
      wrap.append(kbd, reset);
      keyRows.set(a.id, { kbd, reset });
      row(a.what, wrap);
    }
    refreshKeys();

    // ---------------------------------------------------------------- file
    const foot = el("div", "settings-foot");
    const demo = el("button", "set-btn", "markdown reference");
    demo.title = "open a demo note showing everything markdown can do here";
    demo.addEventListener("click", host.openDemo);
    const openRaw = el("button", "set-btn", "open config.toml");
    openRaw.addEventListener("click", host.openConfigFile);
    foot.append(demo, openRaw);
    body.appendChild(foot);
  });
}
