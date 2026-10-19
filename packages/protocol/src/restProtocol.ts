/**
 * REST wire types shared by `server/` (producer) and the web app (consumer): one definition per
 * JSON body so the two ends cannot drift. The only runtime code is the pure `parseCommandResponse`
 * (the one reader of a command-bus body, used by every non-browser client).
 */

import type { CommandError } from '@core/commands/types';
import { isRecord } from '@lib/isRecord';

/**
 * The outcome of one command, whichever surface ran it (in-process `execute`, the command bus, a
 * REST reply). The single result shape of the CLI, the command bus, REST and the exchange tools.
 */
export interface CommandOutcome {
  summary: string;
  affected: string[];
  isError: boolean;
  /** The document was replaced (and saved, for a local CLI backend not in dry-run). */
  changed: boolean;
  data?: unknown;
  /**
   * Machine-readable reason (`code`, `ids`, `paths`, `remediation`): on every rejection (`isError`), and also with `isError: false` on a
   * failure the command reported itself (an aborted or refused `build_project`, a command's own coded no-op).
   */
  error?: CommandError;
}

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
export interface CommandResponseBody extends CommandOutcome {
  canUndo: boolean;
  canRedo: boolean;
}

/** Body of every non-2xx JSON reply. */
export interface ErrorResponseBody {
  readonly error: string;
}

/** Target document layer of `POST /import/dwg?target=…`. */
export type DwgImportTarget = 'drawing' | 'survey';

/** Body of a successful `POST /import/dwg`: the import command's result plus conversion facts. */
export interface DwgImportResponseBody extends CommandResponseBody {
  readonly command: 'import_dxf' | 'import_survey_dxf';
  readonly dxfBytes: number;
}

/**
 * A `CommandOutcome` out of a command-bus JSON body (`/command`, `/undo`, `/redo`, `/exchange`).
 * A body without a `summary` (proxy page, `{ error }` reply) becomes an error outcome naming the
 * HTTP status; status >= 400 forces `isError`.
 */
export function parseCommandResponse(body: unknown, status: number): CommandOutcome {
  if (!isRecord(body) || typeof body['summary'] !== 'string') {
    const message = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : '';
    return {
      summary: `Server answered HTTP ${status}${message !== '' ? `: ${message}` : ''}.`,
      affected: [],
      isError: true,
      changed: false,
    };
  }
  const affected = Array.isArray(body['affected']) ? body['affected'].filter((id): id is string => typeof id === 'string') : [];
  return {
    summary: body['summary'],
    affected,
    isError: body['isError'] === true || status >= 400,
    changed: body['changed'] === true,
    ...(body['data'] !== undefined ? { data: body['data'] } : {}),
    ...(isCommandError(body['error']) ? { error: body['error'] } : {}),
  };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCommandError(value: unknown): value is CommandError {
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    typeof value['remediation'] === 'string' &&
    isStringList(value['ids']) &&
    isStringList(value['paths'])
  );
}
