import { type DocumentElement } from "@corestone/editor";
import { StatePart } from "../../artifact-state";
import { type DocumentState } from "../state";

/**
 * A part of the document view's state: one concern of the document (the
 * entries placed in it, its files, what the sidebars show) with its data and
 * what is done with it.
 */
export abstract class DocumentPart extends StatePart {
  constructor(protected readonly d: DocumentState) { super(d.host); }
  /** The editor that shows the document, once it is on the page. */
  protected get editor(): DocumentElement | null { return this.d.editor; }
  /** The user changed something that waits for Save. */
  protected touch(): void { this.d.touch(); }
}
