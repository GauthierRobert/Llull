/** dispose_fit_result: the human gate on a fit verdict (PHY-04 TR-TMC-32); recorded only with a signature verified by the signing port. */

import type { FitDispositions } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { execute } from '@core/commands/registry';
import { verifyAndSpend } from '@core/model/humanGate';
import { analysisOf } from '../shared/access';
import { refuseTmc } from './refusal';

/**
 * @affects doc.analysis.fitDispositions[rowKey] (affected: [rowKey]); stores the verified signature next to the decision so a reader can re-verify it
 * @invariant the signature is verified over sha256 of canonical JSON { act, rowKey, decision, justification, inputsHash }; with `fitParams` the command
 *   re-runs fit_at_temperature itself and the row must hash to `inputsHash` (a client-given `currentInputsHash` is only a hint)
 * @failure no signing port or signature rejected -> TMC_HUMAN_GATE; currentInputsHash != inputsHash -> TMC_FIT_INPUTS_CHANGED; empty
 *   justification -> FEA_PARAM_INVALID (refusals, document unchanged)
 */
export const disposeFitResult = defineCommand({
  name: 'dispose_fit_result',
  description:
    "Record a qualified person's disposition (accepted, rejected, redesign) of one fit_at_temperature row, identified by its " +
    'rowKey. HUMAN-ONLY. It is recorded only when the signature verifies against the signing port; an agent without a human signature always gets ' +
    'TMC_HUMAN_GATE and the document is unchanged, so do not retry: hand the row to the reviewer. inputsHash is the hash of the fit ' +
    'inputs the reviewer saw; pass currentInputsHash (hash of the recomputed inputs) so a changed fit is refused with TMC_FIT_INPUTS_CHANGED.',
  params: z.object({
    rowKey: z.string().min(1).describe('rowKey of the fit_at_temperature row being dispositioned.'),
    decision: z.enum(['accepted', 'rejected', 'redesign']).describe("The reviewer's decision."),
    justification: z.string().describe("Reviewer's reason for the decision (required, non-empty)."),
    inputsHash: z.string().min(1).describe('Hash of the fit inputs the reviewer examined (stored with the disposition).'),
    fitParams: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'The params of the fit_at_temperature call that produced the row. The command re-runs it and requires sha256 of the row (JCS) to equal inputsHash, so a fit that changed is refused TMC_FIT_INPUTS_CHANGED.',
      ),
    currentInputsHash: z
      .string()
      .optional()
      .describe('Hash of the fit inputs as recomputed now; when it differs from inputsHash the call is refused.'),
    signature: z.unknown().describe('Human signature object produced by the signing system over the payload hash; verified by the host.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { rowKey, decision, justification, inputsHash, currentInputsHash, fitParams, signature } = params;
    const fail = (code: string, message: string): CommandResult => refuseTmc(doc, 'dispose_fit_result', code, message, [rowKey]);
    const port = ctx?.humanSignature ?? null;
    if (port === null)
      return fail(
        'TMC_HUMAN_GATE',
        'no signing port is installed; only a human signature verified by the signing port can disposition a fit',
      );
    const signer = verifyAndSpend(
      port,
      signature,
      sha256Hex(canonicalJson({ act: 'dispose_fit_result', rowKey, decision, justification, inputsHash })),
    );
    if (signer === null) return fail('TMC_HUMAN_GATE', 'the signature did not verify for this disposition');
    if (justification.trim() === '') return fail('FEA_PARAM_INVALID', 'justification must not be empty');
    if (currentInputsHash !== undefined && currentInputsHash !== inputsHash)
      return fail('TMC_FIT_INPUTS_CHANGED', `the fit inputs changed since review (${inputsHash} -> ${currentInputsHash})`);
    if (fitParams !== undefined) {
      const fit = execute(doc, 'fit_at_temperature', fitParams, ctx);
      const rows = (fit.data as { rows?: readonly { rowKey: string }[] } | undefined)?.rows ?? [];
      const row = rows.find((candidate) => candidate.rowKey === rowKey);
      if (row === undefined) return fail('TMC_FIT_INPUTS_CHANGED', `fit_at_temperature with fitParams no longer yields row '${rowKey}'`);
      const recomputed = sha256Hex(jcsJson(row));
      if (recomputed !== inputsHash)
        return fail(
          'TMC_FIT_INPUTS_CHANGED',
          `the fit row changed since review (${inputsHash} -> ${recomputed}); inputsHash is sha256 of the JCS row`,
        );
    }
    const model = analysisOf(doc);
    const fitDispositions: FitDispositions = {
      ...model.fitDispositions,
      [rowKey]: { decision, justification, inputsHash, signer: signer.signer, signatureId: signer.signatureId, signature },
    };
    return changed(
      { ...doc, analysis: { ...model, fitDispositions } },
      `dispose_fit_result: row '${rowKey}' ${decision} by ${signer.signer} (signature ${signer.signatureId}).`,
      [rowKey],
    );
  },
});
