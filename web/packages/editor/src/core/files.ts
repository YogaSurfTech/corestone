// The files of the entry the text belongs to (pictures, linked files). The host
// application keeps the files (the editor knows nothing of where); new ones
// are handed to it, and it says under which name they are kept and where
// they can be seen.

/** The entry's files, as the host application offers them. */
export interface EntryFiles {
  /** Takes a new file (pasted, dropped or chosen); resolves with the name it is kept under.
   *  replace: keep it under its own name, in place of a file of that name (a changed diagram;
   *  the history keeps the old content). */
  add(file: File, replace?: boolean): Promise<string>;
  /** Where a file can be seen (for images) or opened. */
  url(name: string): string;
  /** The names of the entry's files, to pick one. */
  list(): Promise<string[]>;
  /** Removes a file no longer shown (a formula's old picture); Save removes a stored one. */
  remove?(name: string): Promise<void> | void;
  /** A file's content (to edit a diagram: draw.io reads the diagram from its PNG). */
  get?(name: string): Promise<Blob>;
}

export const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const isImageName = (n: string) => IMAGE.test(n);
export const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif" };
export const isImageFile = (f: File) => f.type in MIME_EXT;
