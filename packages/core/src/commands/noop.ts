import { EXPORT_REMEDIATION, exportDocumentHash, exportGate, type ExportTarget } from '../model/exportGate';
import { humanGate } from '../model/humanGate';
import type { CadDocument } from '../model/types';
import type { CommandError, CommandResult, ExecutionContext } from './types';

/** Graceful rejection: the document is returned unchanged with nothing affected. */
export const noop = (doc: CadDocument, summary: string): CommandResult => ({ document: doc, summary, affected: [] });

/** A `CommandError`; `ids` / `paths` default to none, `detail` is omitted when absent. */
export const commandError = (
  code: string,
  remediation: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
  detail?: Readonly<Record<string, unknown>>,
): CommandError => ({ code, ids, paths, remediation, ...(detail === undefined ? {} : { detail }) });

/** `CMD_UNKNOWN`: no registered command has that name. */
export const unknownCommandError = (paths: readonly string[] = []): CommandError =>
  commandError('CMD_UNKNOWN', 'Find the right name with `llull search <keyword>` or `llull list`.', [], paths);

/** `noop` flagged as refused by the registry choke point (`CommandResult.rejected`), with its machine-readable reason. */
export const rejection = (doc: CadDocument, summary: string, error: CommandError): CommandResult => ({
  ...noop(doc, summary),
  rejected: true,
  error,
});

/** Coded rejection: summary "<command>: <code> — <message>; no-op." with its `CommandError` (stable code, ids, paths, one-line fix). */
export const codedRejection = (
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  remediation: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
  detail?: Readonly<Record<string, unknown>>,
): CommandResult => rejection(doc, `${command}: ${code} — ${message}; no-op.`, commandError(code, remediation, ids, paths, detail));

/** A coded rejection whose remediation comes from a lookup table. */
type TableRejection = (
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids?: readonly string[],
  paths?: readonly string[],
  detail?: Readonly<Record<string, unknown>>,
) => CommandResult;

/** `codedRejection` with the remediation registered for the code in `table`, else `fallback` (a text, or a lookup of the code in a parent table). */
export const tableRejection =
  (
    table: Readonly<Record<string, string>>,
    fallback: string | ((code: string) => string) = 'see the command description',
  ): TableRejection =>
  (doc, command, code, message, ids = [], paths = [], detail) =>
    codedRejection(
      doc,
      command,
      code,
      message,
      table[code] ?? (typeof fallback === 'string' ? fallback : fallback(code)),
      ids,
      paths,
      detail,
    );

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

/**
 * Refusal of an export of export-controlled content (TR-MAT-30 / 51), or null when the export may proceed. Every `export_*` command that emits
 * content runs it first with its `confirmExportControlled` param.
 * @failure controlled content without confirmation -> MAT_EXPORT_CONTROLLED; a bare true / no signing port / unverified signature -> MAT_HUMAN_GATE
 * @invariant the signature covers the act, the marked ids, the command and the hash of the exported document (`exportDocumentHash`) plus the nonce
 */
export function exportRefusal(
  doc: CadDocument,
  command: string,
  target: ExportTarget,
  confirmation: unknown,
  ctx: ExecutionContext | undefined,
  emitted: readonly string[] = [],
): CommandResult | null {
  const gate = exportGate(doc, target, emitted);
  if (!gate.controlled) return null;
  const refuse = (code: keyof typeof EXPORT_REMEDIATION, message: string, path: string): CommandResult =>
    rejection(
      doc,
      `${command}: ${code} — ${message}; nothing was exported; no-op.`,
      commandError(code, EXPORT_REMEDIATION[code], gate.ids, [path]),
    );
  const regime = gate.marking.regime;
  if (confirmation === undefined || confirmation === false)
    return refuse('MAT_EXPORT_CONTROLLED', `the document uses ${regime}-marked material(s) ${gate.ids.join(', ')}`, 'document');
  const outcome = humanGate(ctx?.humanSignature ?? null, `export of ${regime}-controlled content`, gate.ids, confirmation, {
    command,
    documentHash: exportDocumentHash(doc),
  });
  return outcome.cleared ? null : refuse('MAT_HUMAN_GATE', outcome.reason, 'confirmExportControlled');
}
