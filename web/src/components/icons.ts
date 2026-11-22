import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { iconSet } from "@corestone/ui";
import type { Kind } from "./types";

// The application's icons (the editor has its own set), all drawn by the icon
// function of @corestone/ui: the icons of the views on a grid of 24, the
// pictograms of the kinds and the small marks of the controls on a grid of 16.

const PATHS = {
  outline: '<path d="M4 6h2M4 12h2M4 18h2M9 6h11M11 12h9M13 18h7"/>',
  props: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  entry: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>',
  rel: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.3 10.8 15.7 7.2M8.3 13.2l7.4 3.6"/>',
  comments: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  versions: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4M12 8v4l3 2"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  send: '<path d="M4 12 20 4l-5 16-3-7-8-1z"/><path d="m12 13 8-9"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
};


export type AppIcon = keyof typeof PATHS;
const app = iconSet(PATHS, { grid: 24, size: 18, stroke: 1.8, cls: "app-icon" });

/** An icon of the views, for a Lit template. */
export function appIcon(name: AppIcon, size = 18): TemplateResult {
  return html`${unsafeSVG(app(name, size))}`;
}

const KINDS: Record<Kind, string> = {
  // a card with a column of labels and lines of values
  entry: '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M6 3v10M8.5 6.5h3.5M8.5 9.5h3.5"/>',
  // a page with a folded corner
  document: '<path d="M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13M6.5 8.5h4M6.5 11.5h4"/>',
  // two things with an arrow from one up to the other
  link: '<circle cx="3" cy="13" r="1.7" fill="currentColor"/><circle cx="13" cy="3" r="1.7" fill="currentColor"/><path d="M5.4 10.6 10 6M7 5.8h3.2V9"/>',
  // a speech bubble
  comment: '<path d="M3.5 2.5h9A1.5 1.5 0 0 1 14 4v5.5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5V4a1.5 1.5 0 0 1 1.5-1.5z"/>',
};

/** The pictogram of a kind, as markup. */
export const kindPictogram = iconSet(KINDS, { grid: 16, size: 14, stroke: 1.4 });

const MARKS = {
  pin: '<path d="M10.2 1.6 14.4 5.8l-1.1 1.1-.9-.2-2.3 2.3.3 2.4-1.2 1.2-2.6-2.6-3.5 3.5-.9.2.2-.9 3.5-3.5L3.3 6.7l1.2-1.2 2.4.3 2.3-2.3-.2-.9z" fill="currentColor" stroke="none"/>',
  calendar: '<path d="M4.5 1.5v2M11.5 1.5v2M2 6.5h12M3.5 3h9A1.5 1.5 0 0 1 14 4.5v8A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8A1.5 1.5 0 0 1 3.5 3z"/>',
};
const mark = iconSet(MARKS, { grid: 16, size: 14, stroke: 1.3 });

/** A small mark of a control, for a Lit template. */
export function markIcon(name: keyof typeof MARKS, size = 14): TemplateResult {
  return html`${unsafeSVG(mark(name, size))}`;
}
