/** dispose_fit_result: the human gate on a fit verdict (PHY-04 TR-TMC-32); recorded only with a signature verified by the signing port. */

import type { FitDispositions } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { analysisOf } from '../shared/access';
import { refuseTmc } from './refusal';

/**
 * @affects doc.analysis.fitDispositions[rowKey] (affected: [rowKey])
 * @invariant the signature is verified over sha256 of canonical JSON { rowKey, decision, justification, inputsHash }
 * @failure no signing port or signature rejected -> TMC_HUMAN_GATE; currentInputsHash != inputsHash -> TMC_FIT_INPUTS_CHANGED; empty
 *   justification -> FEA_PARAM_INVALID (refusals, document unchanged)
 */
export const disposeFitResult = defineCommand({
  name: 'dispose_fit_result',
  description:
    "HUMAN-ONLY. Record a qualified person's disposition (accepted, rejected, redesign) of one fit_at_temperature row, identified by its " +
    'rowKey. It is recorded only when the signature verifies against the signing port; an agent without a human signature always gets ' +
    'TMC_HUMAN_GATE and the document is unchanged, so do not retry: hand the row to the reviewer. inputsHash is the hash of the fit ' +
    'inputs the reviewer saw; pass currentInputsHash (hash of the recomputed inputs) so a changed fit is refused with TMC_FIT_INPUTS_CHANGED.',
  params: z.object({
    rowKey: z.string().min(1).describe('rowKey of the fit_at_temperature row being dispositioned.'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe("Reviewer's reason for the decision (required, non-empty)."),
    inputsHash: z.string().min(1).describe('Hash of the fit inputs the reviewer examined (stored with the disposition).'),
    currentInputsHash: z
      .string()
      .optional()
      .describe('Hash of the fit inputs as recomputed now; when it differs from inputsHash the call is refused.'),
    signature: z.unknown().describe('Human signature object produced by the signing system over the payload hash; verified by the host.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { rowKey, decision, justification, inputsHash, currentInputsHash, signature } = params;
    const fail = (code: string, message: string): CommandResult => refuseTmc(doc, 'dispose_fit_result', code, message, [rowKey]);
    const port = ctx?.humanSignature ?? null;
    if (port === null)
      return fail(
        'TMC_HUMAN_GATE',
        'no signing port is installed; only a human signature verified by the signing port can disposition a fit',
      );
    const signer = port.verify(signature, sha256Hex(canonicalJson({ rowKey, decision, justification, inputsHash })));
    if (signer === null) return fail('TMC_HUMAN_GATE', 'the signature did not verify for this disposition');
    if (justification.trim() === '') return fail('FEA_PARAM_INVALID', 'justification must not be empty');
    if (currentInputsHash !== undefined && currentInputsHash !== inputsHash)
      return fail('TMC_FIT_INPUTS_CHANGED', `the fit inputs changed since review (${inputsHash} -> ${currentInputsHash})`);
    const model = analysisOf(doc);
    const fitDispositions: FitDispositions = {
      ...model.fitDispositions,
      [rowKey]: { decision, justification, inputsHash, signer: signer.signer, signatureId: signer.signatureId },
    };
    return changed(
      { ...doc, analysis: { ...model, fitDispositions } },
      `dispose_fit_result: row '${rowKey}' ${decision} by ${signer.signer} (signature ${signer.signatureId}).`,
      [rowKey],
    );
  },
});
