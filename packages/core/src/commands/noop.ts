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
