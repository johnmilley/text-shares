/**
 * Keyboard-combo helpers shared by the global shortcut dispatch (main.ts)
 * and the rebinding capture in settings.ts.
 *
 * Combos are stored against the *unshifted* key ("ctrl+shift+\"), but with
 * Shift held `e.key` reports the shifted character ("|"), so matching on
 * e.key alone silently breaks every shifted punctuation shortcut (this is
 * why Ctrl+Shift+\ never split the editor). `e.code` names the physical
 * key, which lets us recover the base character.
 */

/** Base (unshifted) character for a KeyboardEvent.code, when derivable. */
const CODE_BASE: Record<string, string> = {
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
};

export function baseKey(e: KeyboardEvent): string | null {
  if (CODE_BASE[e.code]) return CODE_BASE[e.code];
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return null;
}

/** All combo strings this event could mean, most specific first: the key as
 * typed, then the physical (unshifted) key when it differs. */
export function comboCandidates(e: KeyboardEvent): string[] {
  const mods =
    `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}` +
    `${e.altKey ? "alt+" : ""}`;
  const typed = e.key.toLowerCase();
  const base = baseKey(e);
  const keys = base && base !== typed ? [typed, base] : [typed];
  return keys.map((k) => mods + k);
}
