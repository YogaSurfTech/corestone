import { svg, type SVGTemplateResult } from "lit";

// The application's own icons (the editor has its own set): 24×24, drawn with the current colour.

const PATHS = {
  outline: svg`<path d="M4 6h2M4 12h2M4 18h2M9 6h11M11 12h9M13 18h7"/>`,
  props: svg`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`,
  entry: svg`<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>`,
  rel: svg`<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.3 10.8 15.7 7.2M8.3 13.2l7.4 3.6"/>`,
  comments: svg`<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>`,
  versions: svg`<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4M12 8v4l3 2"/>`,
  save: svg`<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  grip: svg`<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>`,
  close: svg`<path d="M6 6l12 12M18 6 6 18"/>`,
  open: svg`<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
  send: svg`<path d="M4 12 20 4l-5 16-3-7-8-1z"/><path d="m12 13 8-9"/>`,
  reload: svg`<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>`,
};

export type AppIcon = keyof typeof PATHS;

export function appIcon(name: AppIcon, size = 18): SVGTemplateResult {
  return svg`<svg class="app-icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
