/** Cursor paging of the detail lists of `analyze_pipe_stress` (07 PST §4 `cursor`): one offset into every requested list, bound to the input hash of the analysis. */

const PREFIX_LENGTH = 16;
const CURSOR = /^([0-9a-f]{16}):(0|[1-9][0-9]{0,8})$/;

/** The cursor of the page that starts at `offset`: the first 16 hex digits of the input hash and the offset. */
export const encodeCursor = (inputHash: string, offset: number): string => `${inputHash.slice(0, PREFIX_LENGTH)}:${offset}`;

export type CursorOutcome = { readonly ok: true; readonly offset: number } | { readonly ok: false; readonly stale: boolean };

/** The offset a cursor stands for; `stale` when it is well formed but was issued for other inputs. */
export function decodeCursor(cursor: string, inputHash: string): CursorOutcome {
  const match = CURSOR.exec(cursor);
  if (match === null) return { ok: false, stale: false };
  return match[1] === inputHash.slice(0, PREFIX_LENGTH) ? { ok: true, offset: Number(match[2]) } : { ok: false, stale: true };
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export const pageOf = <T>(list: readonly T[], offset: number, limit: number): Page<T> => ({
  items: list.slice(offset, offset + limit),
  total: list.length,
});
