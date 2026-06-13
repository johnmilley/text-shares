/**
 * Fonts bundled with the app, so the curated picker (Ctrl+Shift+E) works the
 * same on every machine — including the iA Writer family. All are SIL OFL
 * licensed, shipped as woff2 via fontsource. Variable families register as
 * "<Name> Variable"; the stacks in main.ts list both, preferring a locally
 * installed copy when there is one.
 *
 * Iosevka stays unbundled (its files are enormous); Cantarell and Charter
 * stay system-provided.
 */

// variable: one file covers all weights; italics ride along where they exist
import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@fontsource-variable/fira-code"; // no italic exists
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/source-serif-4/wght-italic.css";

// static: regular / bold and their italics
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-mono/700-italic.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-sans/700-italic.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/400-italic.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/atkinson-hyperlegible/700-italic.css";
import "@fontsource/ia-writer-mono/400.css";
import "@fontsource/ia-writer-mono/400-italic.css";
import "@fontsource/ia-writer-mono/700.css";
import "@fontsource/ia-writer-mono/700-italic.css";
import "@fontsource/ia-writer-duo/400.css";
import "@fontsource/ia-writer-duo/400-italic.css";
import "@fontsource/ia-writer-duo/700.css";
import "@fontsource/ia-writer-duo/700-italic.css";
import "@fontsource/ia-writer-quattro/400.css";
import "@fontsource/ia-writer-quattro/400-italic.css";
import "@fontsource/ia-writer-quattro/700.css";
import "@fontsource/ia-writer-quattro/700-italic.css";
