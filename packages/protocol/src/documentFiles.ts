/**
 * Names of llull document files, shared by the CLI, the desktop app and the web Open dialog so
 * the extensions and the default file cannot drift. Constants only.
 */

/** Extensions a document may carry: `part.llull`, `part.llull.json`, plain `part.json`. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['llull', 'json'];

/** Matches a path that looks like a document file. */
export const DOCUMENT_FILE_PATTERN = new RegExp(`\\.(${DOCUMENT_EXTENSIONS.join('|')})$`, 'i');

/** The `<input type=file accept>` value for a document. */
export const DOCUMENT_ACCEPT = `application/json,${DOCUMENT_EXTENSIONS.map((e) => `.${e}`).join(',')}`;

/** The document a local CLI run acts on when neither `--doc` nor `$LLULL_DOC` is given. */
export const DEFAULT_DOCUMENT_PATH = 'model.llull.json';

/** The file name the desktop Save dialog suggests. */
export const DEFAULT_SAVE_NAME = 'model.llull';
