// Line icons: every set of them is drawn the same way, as an <svg> in the
// colour of the text. A set gives the paths and the grid they are drawn on;
// what comes back is markup, for code that builds DOM by hand and (through
// unsafeSVG) for Lit templates alike.

export interface IconStyle {
  /** The side of the square the paths are drawn on. */
  grid: number;
  /** The side in pixels an icon has unless asked otherwise. */
  size: number;
  /** The width of the lines, in units of the grid. */
  stroke: number;
  /** A class on the <svg>. */
  cls?: string;
}

/** A set of icons: called with a name (and a size) it gives the icon's markup; an unknown name gives an empty icon. */
export function iconSet<K extends string>(paths: Record<K, string>, style: IconStyle): (name: K, size?: number) => string {
  const cls = style.cls ? `class="${style.cls}" ` : "";
  return (name, size = style.size) =>
    `<svg ${cls}width="${size}" height="${size}" viewBox="0 0 ${style.grid} ${style.grid}" fill="none" stroke="currentColor" stroke-width="${style.stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
