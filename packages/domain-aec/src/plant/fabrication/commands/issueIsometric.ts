import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { humanGate } from '@core/model/humanGate';
import { nextId } from '@lib/id';
import { analyseLine, isAnalysis } from '../analysis';
import { checkLine } from '../check';
import { refuseIso } from '../codes';
import { basisOf } from '../issues';
import type { IssuedIsometric } from '../model';
import { getFabrication, withFabrication } from '../state';

/**
 * @affects plant.fabrication.issues[issueId] (one issue stamp: revision, purpose, signer, signature id, basis hash of the line content)
 * @invariant a human act: the stamp needs a signature verified by the signing port over { act, line, revision, purpose, content hash } and spent once; an agent, a bare true or a foreign signature never issues; any later edit of the line makes the stamp stale (the iso is NOT FOR CONSTRUCTION again)
 * @failure unknown line -> ISO_LINE_NOT_FOUND; check_isometric (style final) errors -> ISO_CHECK_FAILED; no valid human signature -> ISO_HUMAN_GATE; the document is unchanged
 */
export const issueIsometric = defineCommand({
  name: 'issue_isometric',
  description:
    'Issue the isometric of a pipe line for fabrication or construction: a HUMAN act that an agent cannot perform. The line must pass check_isometric with style final (no error: connected, SKEY set, welds numbered, spool limits met); ' +
    'then `confirmation` must be a signature object produced by a human in the desktop app (with a nonce field) over the act, the line, the revision, the purpose and the content hash of the line, verified by the signing port. ' +
    'On success the stamp is stored and export_isometric prints "ISSUED <purpose> REV <revision>" and the approver instead of NOT FOR CONSTRUCTION, with reviewRequired false; as soon as the line is edited the stamp is stale and ' +
    'the isometric is NOT FOR CONSTRUCTION with reviewRequired true again. Returns affected = [issueId] and data = { issueId, lineId, revision, purpose, signer, signatureId, basisSha256, reviewRequired: false }. ' +
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
    const outcome = humanGate(ctx?.humanSignature ?? null, 'plant:issue_isometric', [analysis.lineId], params.confirmation, {
      revision: params.revision,
      purpose: params.purpose,
      basisSha256: basis,
    });
    if (!outcome.cleared)
      return refuseIso(
        doc,
        'issue_isometric',
        'ISO_HUMAN_GATE',
        `issue_isometric is a human act: ${outcome.reason}`,
        [analysis.lineId],
        ['confirmation'],
      );
    const issue: IssuedIsometric = {
      id: nextId('iso-issue'),
      lineId: analysis.lineId,
      revision: params.revision,
      purpose: params.purpose,
      signer: outcome.signer,
      signatureId: outcome.signatureId,
      basisSha256: basis,
    };
    return {
      document: withFabrication(doc, { ...fabrication, issues: { ...fabrication.issues, [issue.id]: issue } }),
      summary: `issue_isometric: line ${analysis.name} issued ${params.purpose.replace('_', ' ')} at revision ${issue.revision} by ${issue.signer} (${issue.id}, signature ${issue.signatureId})`,
      affected: [issue.id],
      data: { issueId: issue.id, ...issue, reviewRequired: false },
    };
  },
});
