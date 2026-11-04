import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { humanGate, humanGatePayload } from '@core/model/humanGate';
import { isRecord } from '@lib/isRecord';
import { nextId } from '@lib/id';
import { isoUtc } from '../../../shared/isoUtc';
import { analyseLine, isAnalysis } from '../analysis';
import { checkLine } from '../check';
import { refuseIso } from '../codes';
import { snapshotOf } from '../compareIssue';
import { basisOf } from '../issues';
import type { IssueApproval, IssuedIsometric } from '../model';
import { getFabrication, withFabrication } from '../state';

/** The recorded form of a confirmation (`withoutConfirmations`): exactly { verified: true }. */
const isRecorded = (confirmation: unknown): boolean =>
  isRecord(confirmation) && Object.keys(confirmation).length === 1 && confirmation['verified'] === true;

/**
 * @affects plant.fabrication.issues[issueId] (one issue stamp: revision, purpose, signer, signature id, basis hash of the line content)
 * @invariant a human act: the stamp needs a signature verified by the signing port over { act, line, revision, purpose, content hash } and spent once; an agent, a bare true or a foreign signature never issues; any later edit of the line makes the stamp stale (the iso is NOT FOR CONSTRUCTION again)
 * @invariant replay: the recorded step carries confirmation { verified: true } (the signature is never recorded); it is honoured only while the history replay machinery re-runs the step (ctx.replaying, never a param: a direct call with { verified: true } is ISO_HUMAN_GATE) and only for an entry of the fabrication issue ledger with the same line, revision, purpose and content hash (stored signed records are self-asserted on load), so replay_history / regenerate re-apply a real issue and nothing else; `at` is host-filled and inside the signed payload
 * @failure unknown line -> ISO_LINE_NOT_FOUND; check_isometric (style final) errors -> ISO_CHECK_FAILED; no valid human signature -> ISO_HUMAN_GATE; the document is unchanged
 */
export const issueIsometric = defineCommand({
  name: 'issue_isometric',
  description:
    'Issue the isometric of a pipe line for fabrication or construction: a HUMAN act that an agent cannot perform. The line must pass check_isometric with style final (no error: connected, SKEY set, welds numbered, spool limits met); ' +
    'then `confirmation` must be a signature object produced by a human in the desktop app (with a nonce field) over the act, the line, the revision, the purpose and the content hash of the line, verified by the signing port. ' +
    'On success the stamp is stored and export_isometric prints "ISSUED <purpose> REV <revision>" and the approver instead of NOT FOR CONSTRUCTION, with reviewRequired false; as soon as the line is edited the stamp is stale and ' +
    'the isometric is NOT FOR CONSTRUCTION with reviewRequired true again. Returns affected = [issueId] and data = { issueId, lineId, revision, purpose, signer, signatureId, basisSha256, at, payloadSha256, reviewRequired: false }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_CHECK_FAILED (checked first, so a signature is not spent on a line that cannot be issued), ISO_HUMAN_GATE (an agent, true, no signing port, a signature that does not verify).',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    revision: z.string().trim().min(1).describe('Revision label printed in the title block, e.g. "A" or "0".'),
    purpose: z.enum(['for_construction', 'for_fabrication']).describe('What the isometric is issued for.'),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation: a signature object (with a nonce field) produced in the desktop app over the issue act. An agent cannot give it: true or a missing value is refused with ISO_HUMAN_GATE.',
      ),
    at: isoUtc.describe(
      'When the issue happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it and it is part of the signed payload; commands never read a clock.',
    ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const analysis = analyseLine(doc, 'issue_isometric', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const fabrication = getFabrication(doc);
    const paper = fabrication.isometrics?.[analysis.lineId]?.paper ?? 'A3';
    const errors = checkLine(doc, analysis.lineId, { style: 'final', paper }).filter((issue) => issue.severity === 'error');
    if (errors.length > 0)
      return refuseIso(
        doc,
        'issue_isometric',
        'ISO_CHECK_FAILED',
        `check_isometric (final) reports ${errors.length} error(s) on line ${analysis.name}: ${[...new Set(errors.map((issue) => issue.code))].join(', ')}`,
        errors.flatMap((issue) => issue.ids),
        ['lineId'],
      );
    const basis = basisOf(analysis);
    const recorded: IssueApproval | undefined =
      ctx?.replaying === true && isRecorded(params.confirmation)
        ? fabrication.issueLedger?.find(
            (entry) =>
              entry.lineId === analysis.lineId &&
              entry.revision === params.revision &&
              entry.purpose === params.purpose &&
              entry.basisSha256 === basis,
          )
        : undefined;
    const details = { revision: params.revision, purpose: params.purpose, basisSha256: basis, at: params.at };
    const outcome =
      recorded !== undefined
        ? ({ cleared: true, signer: recorded.signer, signatureId: recorded.signatureId } as const)
        : humanGate(ctx?.humanSignature ?? null, 'plant:issue_isometric', [analysis.lineId], params.confirmation, details);
    if (!outcome.cleared)
      return refuseIso(
        doc,
        'issue_isometric',
        'ISO_HUMAN_GATE',
        `issue_isometric is a human act: ${outcome.reason}`,
        [analysis.lineId],
        ['confirmation'],
      );
    const nonce = isRecord(params.confirmation) ? params.confirmation['nonce'] : undefined;
    const approval: IssueApproval = recorded ?? {
      lineId: analysis.lineId,
      revision: params.revision,
      purpose: params.purpose,
      signer: outcome.signer,
      signatureId: outcome.signatureId,
      basisSha256: basis,
      at: params.at,
      payloadSha256: humanGatePayload('plant:issue_isometric', [analysis.lineId], details, typeof nonce === 'string' ? nonce : ''),
    };
    const issue: IssuedIsometric = { id: nextId('iso-issue'), ...approval };
    return {
      document: withFabrication(doc, {
        ...fabrication,
        issues: { ...fabrication.issues, [issue.id]: issue },
        issueSnapshots: { ...fabrication.issueSnapshots, [issue.id]: snapshotOf(analysis) },
        ...(recorded === undefined ? { issueLedger: [...(fabrication.issueLedger ?? []), approval] } : {}),
      }),
      summary: `issue_isometric: line ${analysis.name} issued ${params.purpose.replace('_', ' ')} at revision ${issue.revision} by ${issue.signer} (${issue.id}, signature ${issue.signatureId})`,
      affected: [issue.id],
      data: { issueId: issue.id, ...issue, reviewRequired: false },
    };
  },
});
