import type { CadDocument } from '../model/types';
import type { CommandError, CommandResult } from './types';

/** Graceful rejection: the document is returned unchanged with nothing affected. */
export const noop = (doc: CadDocument, summary: string): CommandResult => ({ document: doc, summary, affected: [] });

/** A `CommandError`; `ids` / `paths` default to none. */
export const commandError = (
  code: string,
  remediation: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandError => ({ code, ids, paths, remediation });

/** `CMD_UNKNOWN`: no registered command has that name. */
export const unknownCommandError = (paths: readonly string[] = []): CommandError =>
  commandError('CMD_UNKNOWN', 'Find the right name with `llull search <keyword>` or the MCP tool list.', [], paths);

/** `noop` flagged as refused by the registry choke point (`CommandResult.rejected`), with its machine-readable reason. */
export const rejection = (doc: CadDocument, summary: string, error: CommandError): CommandResult => ({
  ...noop(doc, summary),
  rejected: true,
  error,
});

/** Reporter for a command's rejections: `fail(why)` -> no-op "<command>: <why>; no-op.". */
export const failer =
  (doc: CadDocument, command: string) =>
  (why: string): CommandResult =>
    noop(doc, `${command}: ${why}; no-op.`);

/** Like `failer`, worded "<command> failed: <why>" (used by the machine-element commands). */
export const failedWith =
  (doc: CadDocument, command: string) =>
  (why: string): CommandResult =>
    noop(doc, `${command} failed: ${why}`);

/** Result with no affected ids; `data` (when given) carries a query's structured answer. */
export const report = (document: CadDocument, summary: string, data?: unknown): CommandResult => ({
  ...noop(document, summary),
  ...(data === undefined ? {} : { data }),
});

/** Mutating result: `document` is the next state, `affected` the created/changed entity ids. */
export const changed = (document: CadDocument, summary: string, affected: string[]): CommandResult => ({ document, summary, affected });
