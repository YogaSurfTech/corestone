import { TextSelection, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Feature } from "../feature";
import { isImageFile, type EntryFiles } from "../files";
import { schema } from "../schema";
import { insertImage } from "./images";

// Files put into the text: pasted, dropped or chosen files are stored with
// the entry; an image shows as an image, any other file as a link to it.

/** Inserts a link to a file of the entry, its name as text. */
export function insertFileLink(name: string): Command {
  return (state, dispatch) => {
    const mark = schema.marks.link.create({ file: name });
    dispatch?.(state.tr.replaceSelectionWith(schema.text(name, [mark]), false).removeStoredMark(schema.marks.link).scrollIntoView());
    return true;
  };
}

/** Stores files the user pasted, dropped or chose, and puts them into the text: images as
 *  images, other files as file links. */
export async function addFiles(view: EditorView, files: EntryFiles, list: File[], notice: (msg: string) => void, pos?: number) {
  for (const f of list) {
    let name: string;
    try {
      name = await files.add(f);
    } catch (e) {
      notice(`${f.name || "The file"} could not be added${e instanceof Error && e.message ? ": " + e.message : "."}`);
      continue;
    }
    if (pos != null) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))));
      pos = undefined;
    }
    (isImageFile(f) ? insertImage(name) : insertFileLink(name))(view.state, view.dispatch);
  }
  view.focus();
}

/** Pasted or dropped files (a screenshot, files from the file manager) are added to the
 *  entry and put into the text; HTML with text (e.g. from Word, which adds a picture of
 *  the selection) is pasted as text instead. */
export const fileLinksFeature: Feature = (ctx) => ({
  id: "file-links",
  paste(view, data, pos) {
    const list = [...data.files];
    if (!list.length) return false;
    const html = data.getData("text/html");
    if (html && new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()) return false;
    const files = ctx.files();
    if (!files) { ctx.notice("Files are kept with a saved item; they cannot be added here."); return true; }
    void addFiles(view, files, list, ctx.notice, pos);
    return true;
  },
});
