import type { Feature } from "../core/feature";
import { structureFeature, type DocumentHost } from "../core/structure";
import { codeFeature } from "./code";
import { contentsFeature } from "./contents";
import { diagramsFeature } from "./diagrams";
import { fileLinksFeature } from "./file-links";
import { formulasFeature } from "./formulas";
import { imagesFeature } from "./images";
import { linksFeature } from "./links";
import { tablesFeature } from "./tables";

/**
 * The features an editor has unless it is given others. Their order counts:
 * plugins and toolbar buttons follow it, and so do the questions "who takes
 * this click, this paste, this menu".
 */
export function builtinFeatures(o: {
  /** The address of the draw.io web app (asked each time; absent: no diagrams). */
  diagrams?: () => string | undefined;
  /** What the host does for a document; absent: the editor is a field's. */
  document?: () => DocumentHost | undefined;
}): Feature[] {
  return [
    codeFeature,
    fileLinksFeature, // (before links: pasted files are files even when an address comes with them)
    linksFeature, tablesFeature, imagesFeature, diagramsFeature(() => o.diagrams?.()), formulasFeature,
    // a document: its structure (its keys go before the text's own, so it is the last with plugins), and what it generates from it
    ...(o.document ? [structureFeature(o.document), contentsFeature(o.document)] : []),
  ];
}
