import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';

/** Graceful rejection: the document is returned unchanged with nothing affected. */
export const noop = (doc: CadDocument, summary: string): CommandResult => ({
  document: doc,
  summary,
  affected: [],
});

/** `noop` flagged as refused by the registry choke point (`CommandResult.rejected`). */
export const rejection = (doc: CadDocument, summary: string): CommandResult => ({
  ...noop(doc, summary),
  rejected: true,
});

/** Result with no affected ids; `data` (when given) carries a query's structured answer. */
export const report = (document: CadDocument, summary: string, data?: unknown): CommandResult => ({
  ...noop(document, summary),
  ...(data === undefined ? {} : { data }),
});

/** Mutating result: `document` is the next state, `affected` the created/changed entity ids. */
export const changed = (
  document: CadDocument,
  summary: string,
  affected: string[],
): CommandResult => ({
  document,
  summary,
  affected,
});
