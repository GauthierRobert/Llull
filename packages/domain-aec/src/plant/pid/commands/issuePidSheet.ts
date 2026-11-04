import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { isoUtc } from '../../../shared/isoUtc';
import { runChecks } from '../checks/runChecks';
import { refusePid } from '../dexpi/codes';
import { PID_SHEET_STATUSES, type PidModel, type PidSheet } from '../model';
import { getPid, withPid } from '../state';

const ACT = 'pid:issue_pid_sheet';

/** SHA-256 of what a sheet shows: its identity fields, every item drawn on it in item order, the project symbols and the acceptances (status, revision and the issue stamp are not part of it). */
export function sheetContentSha256(pid: PidModel, sheet: PidSheet): string {
  const items = pid.itemOrder.flatMap((id) => {
    const item = pid.items[id];
    return item !== undefined && item.sheetId === sheet.id ? [item] : [];
  });
  return sha256Hex(
    jcsJson({
      id: sheet.id,
      number: sheet.number,
      title: sheet.title,
      paper: sheet.paper,
      items,
      symbols: pid.symbols ?? null,
      acceptances: pid.acceptances ?? null,
    }),
  );
}

/**
 * @affects plant.pid.sheets[sheet] (status, revision; issued_for_construction also the issue stamp: signer, time, signature id, signed payload hash, content hash); a metaHistory command: no feature step, sheet status and stamps are carried across a history replay
 * @invariant issued_for_construction is a human act: needs no unaccepted error finding on the sheet (checked first, so a signature is not spent on a refusal), then a signature verified AND spent by ctx.humanSignature over { act, sheet, revision, from, status, content hash, accepted errors, at, documentUid }; the other statuses are set by anyone and keep reviewRequired true; going back to draft clears the stamp; the stamp records the content hash (sheet, its items, project symbols, acceptances), so an edit afterwards is visible as a changed hash; a loaded file's issuedBy is validated for shape only and is NOT proof of a signature (the signature itself is never stored)
 * @failure unknown sheet -> PID_SHEET_NOT_FOUND; not a forward step nor draft -> PID_STATUS_TRANSITION; unaccepted errors -> PID_CHECK_FAILED; no valid human signature for issued_for_construction -> PID_HUMAN_GATE; document unchanged
 */
export const issuePidSheet = defineCommand({
  name: 'issue_pid_sheet',
  description:
    'Set the revision and status of a P&ID sheet: draft, issued_for_review, issued_for_hazop, issued_for_construction. A sheet moves forward (any later status) or back to draft, which clears the issue stamp. ' +
    'issued_for_construction is a HUMAN act that an agent cannot perform: check_pid must report no unaccepted error on the sheet, then `confirmation` must be a signature object produced by a human in the desktop app ' +
    '(with a nonce field) over the act, the sheet, the revision, the previous and new status, the content hash of the sheet, the keys of the accepted errors and `at`, verified and spent once by the signing port. ' +
    'The stamp (signer, time, signature id, payload hash and content hash) is stored on the sheet; the status is NOT a lock: edit the sheet afterwards and its content hash no longer equals the stamped one. ' +
    '`at` is host-filled and part of what is signed. A document-state command, not a recipe step: a history replay keeps sheet statuses and stamps and never re-runs a signature. ' +
    'Returns data = { sheetId, number, revision, status, from, contentSha256, acceptedErrors[], signer?, signatureId?, payloadSha256?, at, reviewRequired }; reviewRequired is true until the sheet is signed for construction. ' +
    'Refusals (document unchanged): PID_SHEET_NOT_FOUND, PID_STATUS_TRANSITION, PID_CHECK_FAILED, PID_HUMAN_GATE.',
  annotations: { metaHistory: true },
  params: z.object({
    sheet: z.string().trim().min(1).describe('The sheet: its number (e.g. "PID-001") or its id.'),
    status: z.enum(PID_SHEET_STATUSES).describe('The new status. issued_for_construction needs a human signature.'),
    revision: z.string().trim().min(1).max(64).describe('Revision label printed with the status, e.g. "A" or "0".'),
    at: isoUtc.describe(
      'When the status was set: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it and it is part of the signed payload; commands never read a clock.',
    ),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation for issued_for_construction: a signature object (with a nonce field) produced in the desktop app over this act. An agent cannot give it: true or a missing value is refused with PID_HUMAN_GATE.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const pid = getPid(doc);
    const fail = (code: string, message: string, paths: readonly string[], ids: readonly string[] = []): CommandResult =>
      refusePid(doc, 'issue_pid_sheet', code, message, ids, paths);
    const sheet = Object.hasOwn(pid.sheets, params.sheet)
      ? pid.sheets[params.sheet]
      : Object.values(pid.sheets).find((candidate) => candidate.number === params.sheet);
    if (sheet === undefined) return fail('PID_SHEET_NOT_FOUND', `no sheet "${params.sheet}"`, ['sheet']);
    const order = (status: PidSheet['status']): number => PID_SHEET_STATUSES.indexOf(status);
    const forward = order(params.status) > order(sheet.status);
    if (!forward && !(params.status === 'draft' && sheet.status !== 'draft'))
      return fail(
        'PID_STATUS_TRANSITION',
        `sheet ${sheet.number} is ${sheet.status}: it cannot move to ${params.status}; allowed: ${[...PID_SHEET_STATUSES.slice(order(sheet.status) + 1), ...(sheet.status === 'draft' ? [] : ['draft'])].join(', ') || 'draft'}`,
        ['status'],
        [sheet.id],
      );
    const content = sheetContentSha256(pid, sheet);
    const gated = params.status === 'issued_for_construction';
    const run = gated ? runChecks(pid, { sheetId: sheet.id, includeAccepted: true }) : null;
    const errors = run?.findings.filter((finding) => finding.severity === 'error') ?? [];
    const openKeys = new Set(
      (gated ? runChecks(pid, { sheetId: sheet.id, includeAccepted: false }).findings : []).map((finding) => finding.findingKey),
    );
    const open = errors.filter((finding) => openKeys.has(finding.findingKey));
    if (open.length > 0)
      return fail(
        'PID_CHECK_FAILED',
        `check_pid reports ${open.length} unaccepted error(s) on sheet ${sheet.number}: ${[...new Set(open.map((finding) => finding.code))].join(', ')}`,
        ['sheet'],
        open.flatMap((finding) => finding.ids),
      );
    const acceptedErrors = errors
      .filter((finding) => !openKeys.has(finding.findingKey))
      .map((finding) => finding.findingKey)
      .sort();
    let signed: { readonly signer: string; readonly signatureId: string; readonly payloadSha256: string } | null = null;
    if (gated) {
      const details = withDocumentUid(
        {
          sheet: sheet.number,
          revision: params.revision,
          from: sheet.status,
          status: params.status,
          contentSha256: content,
          acceptedErrors,
          at: params.at,
        },
        doc,
      );
      const outcome = humanGate(ctx?.humanSignature ?? null, ACT, [sheet.id], params.confirmation, details);
      if (!outcome.cleared)
        return fail(
          'PID_HUMAN_GATE',
          `issue_pid_sheet to ${params.status} is a human act: ${outcome.reason}`,
          ['confirmation'],
          [sheet.id],
        );
      const nonce = (params.confirmation as { nonce: string }).nonce;
      signed = {
        signer: outcome.signer,
        signatureId: outcome.signatureId,
        payloadSha256: humanGatePayload(ACT, [sheet.id], details, nonce),
      };
    }
    const { issuedBy: _previous, ...rest } = sheet;
    const next: PidSheet = {
      ...rest,
      status: params.status,
      revision: params.revision,
      ...(signed === null
        ? {}
        : {
            issuedBy: {
              signer: signed.signer,
              at: params.at,
              signatureId: signed.signatureId,
              payloadSha256: signed.payloadSha256,
              contentSha256: content,
            },
          }),
    };
    return {
      document: withPid(doc, { ...pid, sheets: { ...pid.sheets, [sheet.id]: next } }),
      summary: `issue_pid_sheet: sheet ${sheet.number} ${sheet.status} -> ${params.status} at revision ${params.revision}${signed === null ? '' : ` by ${signed.signer} (signature ${signed.signatureId})`}; ${signed === null ? 'review required' : 'signed'}.`,
      affected: [sheet.id],
      data: {
        sheetId: sheet.id,
        number: sheet.number,
        revision: params.revision,
        status: params.status,
        from: sheet.status,
        contentSha256: content,
        acceptedErrors,
        ...(signed === null ? {} : { signer: signed.signer, signatureId: signed.signatureId, payloadSha256: signed.payloadSha256 }),
        at: params.at,
        reviewRequired: signed === null,
      },
    };
  },
});
