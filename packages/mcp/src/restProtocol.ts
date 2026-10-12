/**
 * @layer mcp
 * REST wire types shared by `server/` (producer) and the web app (consumer): one definition per
 * JSON body so the two ends cannot drift. Types only — no runtime code.
 */

/**
 * Body of `POST /command`, `POST /undo` and `POST /redo`. The document itself is NOT in it — it
 * arrives via the `/live` SSE stream.
 * - `affected` — ids created/changed (empty for queries, undo/redo, and no-ops).
 * - `isError`  — `execute` rejected the call (unknown command, invalid params, kernel
 *   unavailable, derivation guard) or the command threw.
 * - `changed`  — the live document was replaced (also when `affected` is empty, e.g.
 *   `set_parameter`); a cached idempotent replay reports the original `changed`.
 * - `data`     — present only when the command returned data (queries, `build_project` reports).
 */
export interface CommandResponseBody {
  summary: string;
  affected: string[];
  isError: boolean;
  changed: boolean;
  data?: unknown;
  canUndo: boolean;
  canRedo: boolean;
}

/** Body of every non-2xx JSON reply. */
export interface ErrorResponseBody {
  readonly error: string;
}

/** Body of the public `GET /license`. */
export interface LicenseResponseBody {
  readonly mode: 'licensed' | 'evaluation';
  readonly customer: string | null;
  readonly seats: number;
  readonly expires: string | null;
  /** Short text for the UI status bar / banner. */
  readonly label: string;
  readonly evaluation: boolean;
  readonly warning?: string;
}

/** Target document layer of `POST /import/dwg?target=…`. */
export type DwgImportTarget = 'drawing' | 'survey';

/** Body of a successful `POST /import/dwg`: the import command's result plus conversion facts. */
export interface DwgImportResponseBody extends CommandResponseBody {
  readonly command: 'import_dxf' | 'import_survey_dxf';
  readonly dxfBytes: number;
}
