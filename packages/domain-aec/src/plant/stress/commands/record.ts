/** `record_pipe_stress_results`, `approve_pipe_stress` (07 PST M3): the reviewable record and the human gate on it. */

import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { humanGate } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { isRecord } from '@lib/isRecord';
import { analyzeStressModel } from '../analysis';
import { refuse } from '../codes';
import type { RecordedResults } from '../model/schema';
import { edited, withModel } from '../model/store';
import { SOLVER_VERSION } from '../solve/run';
import { analysisRefusal, isRefusal, modelOr } from './common';

/**
 * @affects plant.stress.models[modelId].recorded: the summary, support loads and hashes of the current analysis; a previous approval is dropped (it covered the previous results)
 * @invariant deterministic: the same document records the same hashes; reviewRequired is always true; a failing or incomplete status is recorded as such
 * @failure unknown model -> PST_MODEL_NOT_FOUND; the analysis' own refusal code (PST_CONDITIONS_MISSING, PST_UNSTABLE, ...) with the document unchanged
 */
export const recordPipeStressResults = defineCommand({
  name: 'record_pipe_stress_results',
  description:
    'Record the current analysis of a stress model in the document so a reviewer can approve a fixed revision: status (pass, fail, incomplete), the findings, the governing stress ratio per code case, the support loads of every anchor and support per case, and the input hash and result hash. ' +
    'The analysis is rerun from the current pipes and supports (see analyze_pipe_stress); if it cannot run, the command is refused with the analysis code and nothing is recorded. ' +
    'Any later edit of the model, pipes, supports or material makes the record stale (check_pipe_stress reports PST_RESULTS_STALE) and approval refused until recorded again. A previous approval is dropped. reviewRequired is always true. Next: approve_pipe_stress (human).',
  params: z.object({ modelId: z.string().min(1).describe('Id of the stress model.') }),
  run: (doc, { modelId }): CommandResult => {
    const model = modelOr(doc, 'record_pipe_stress_results', modelId);
    if (isRefusal(model)) return model;
    const analysis = analyzeStressModel(doc, model);
    if (!analysis.ok) return analysisRefusal(doc, 'record_pipe_stress_results', analysis);
    const recorded: RecordedResults = {
      inputHash: analysis.inputHash,
      resultHash: analysis.resultHash,
      solverVersion: SOLVER_VERSION,
      rule: model.rule,
      status: analysis.status,
      reviewRequired: true,
      cases: analysis.states.map((state) => state.name),
      findings: analysis.findings.map((entry) => ({ code: entry.code, severity: entry.severity, ids: [...entry.ids] })),
      governing: analysis.governing.map((entry) => ({ ...entry })),
      supportLoads: analysis.supportLoads.map((load) => ({
        ...load,
        supportIds: [...load.supportIds],
        forceN: [...load.forceN],
        momentNmm: [...load.momentNmm],
      })),
    };
    return {
      ...changed(
        withModel(doc, edited(model, { recorded })),
        `record_pipe_stress_results: ${model.id} recorded, status ${recorded.status}, ${recorded.cases.length} case(s), result ${recorded.resultHash.slice(0, 12)}; review required.`,
        [model.id],
      ),
      data: {
        modelId: model.id,
        status: recorded.status,
        inputHash: recorded.inputHash,
        resultHash: recorded.resultHash,
        governing: recorded.governing,
        reviewRequired: true,
      },
    };
  },
});

/** The recorded form of a confirmation (`withoutConfirmations`): exactly { verified: true }. */
const isRecordedMarker = (confirmation: unknown): boolean =>
  isRecord(confirmation) && Object.keys(confirmation).length === 1 && confirmation['verified'] === true;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * @affects plant.stress.models[modelId].approval: { signer, signatureId, at, inputHash, resultHash }
 * @invariant `at` is host-stamped metadata outside the signed payload (the human signs before the host stamps the time; residual: an in-process caller holding a valid signature can choose `at`, which is a record of when, not authority);
 * a human act: confirmation is a signature verified by the signing port over { act plant:approve_pipe_stress, modelId, inputHash, resultHash } and spent once; recorded-ness, freshness (the analysis is rerun and must reproduce the stored input hash, result hash and status) and status are checked BEFORE a signature is spent;
 *   replay: the recorded step carries { verified: true } (the signature is never recorded); it is a no-op report only while the history replay re-runs it (ctx.replaying, never a param), a live { verified: true } is PST_HUMAN_GATE; replay_history / regenerate re-attach an approval whose recorded results are unchanged (plugin carry)
 * @failure unknown model -> PST_MODEL_NOT_FOUND; nothing recorded -> PST_NOT_RECORDED; inputs changed since the record -> PST_RESULTS_STALE; fail status -> PST_RESULTS_FAILING; incomplete -> PST_RESULTS_INCOMPLETE; no valid human signature or a live { verified: true } marker -> PST_HUMAN_GATE; the document is unchanged
 */
export const approvePipeStress = defineCommand({
  name: 'approve_pipe_stress',
  description:
    'Approve the recorded pipe stress results of a model: a HUMAN act that an agent cannot perform (a qualified engineer reviews and signs). ' +
    'Needs record_pipe_stress_results first; refused with PST_RESULTS_STALE when the model, pipes, supports or material changed since the record, PST_RESULTS_FAILING when the status is fail, PST_RESULTS_INCOMPLETE when it is incomplete (all checked before any signature is spent). ' +
    '`confirmation` must be a signature object produced by a human in the desktop app (with a nonce field) over the act, the model id, the input hash and the result hash, verified by the signing port and spent once; true or a missing value is refused with PST_HUMAN_GATE. ' +
    'The approval stays valid through replay and regenerate while the recorded results are unchanged; any edit drops it. Returns data { modelId, approved, signer, signatureId, inputHash, resultHash }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    confirmation: z
      .union([z.boolean(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Human confirmation: a signature object (with a nonce field) produced in the desktop app over the approve act. An agent cannot give it.',
      ),
    at: z
      .string()
      .regex(ISO_UTC, 'must be ISO-8601 UTC like 2026-11-02T09:30:00Z')
      .describe(
        'When the approval happened: ISO-8601 UTC, e.g. 2026-11-02T09:30:00Z. The host (UI / llull CLI) fills it; commands never read a clock.',
      ),
  }),
  run: (doc, { modelId, confirmation, at }, ctx): CommandResult => {
    const model = modelOr(doc, 'approve_pipe_stress', modelId);
    if (isRefusal(model)) return model;
    if (isRecordedMarker(confirmation)) {
      if (ctx?.replaying !== true)
        return refuse(
          doc,
          'approve_pipe_stress',
          'PST_HUMAN_GATE',
          'approve_pipe_stress is a human act: a recorded { verified: true } marker is honoured only while the history replays; a live caller needs a signature',
          [modelId],
          ['confirmation'],
        );
      return report(
        doc,
        `approve_pipe_stress: ${modelId} recorded-approval marker; nothing changed here (replay re-attaches a real approval when the recorded results are unchanged).`,
        { modelId, approved: model.approval !== undefined, marker: true },
      );
    }
    const recorded = model.recorded;
    const fail = (code: string, message: string): CommandResult =>
      refuse(doc, 'approve_pipe_stress', code, message, [modelId], ['modelId']);
    if (recorded === undefined) return fail('PST_NOT_RECORDED', `model ${modelId} has no recorded results: run record_pipe_stress_results`);
    // the stored hashes and status are data a file can carry: the analysis is rerun and must reproduce them before a signature is spent
    const fresh = analyzeStressModel(doc, model);
    if (!fresh.ok || fresh.inputHash !== recorded.inputHash || fresh.resultHash !== recorded.resultHash || fresh.status !== recorded.status)
      return fail(
        'PST_RESULTS_STALE',
        `the inputs of ${modelId} changed since its results were recorded, or the stored record does not reproduce`,
      );
    if (recorded.status === 'fail') return fail('PST_RESULTS_FAILING', `the recorded results of ${modelId} fail the code check`);
    if (recorded.status === 'incomplete')
      return fail('PST_RESULTS_INCOMPLETE', `the recorded results of ${modelId} lack a sustained or expansion case`);
    if (model.approval?.resultHash === recorded.resultHash)
      return report(doc, `approve_pipe_stress: ${modelId} is already approved by ${model.approval.signer}; nothing changed.`, {
        modelId,
        approved: true,
        unchanged: true,
        signer: model.approval.signer,
        signatureId: model.approval.signatureId,
        inputHash: recorded.inputHash,
        resultHash: recorded.resultHash,
      });
    const gate = humanGate(
      ctx?.humanSignature ?? null,
      'plant:approve_pipe_stress',
      [modelId],
      confirmation,
      withDocumentUid({ inputHash: recorded.inputHash, resultHash: recorded.resultHash }, doc),
    );
    if (!gate.cleared) return fail('PST_HUMAN_GATE', `approve_pipe_stress is a human act: ${gate.reason}`);
    const approval = {
      signer: gate.signer,
      signatureId: gate.signatureId,
      at,
      inputHash: recorded.inputHash,
      resultHash: recorded.resultHash,
    };
    return {
      ...changed(
        withModel(doc, { ...model, approval }),
        `approve_pipe_stress: ${modelId} approved by ${gate.signer} (signature ${gate.signatureId}); result ${recorded.resultHash.slice(0, 12)}.`,
        [modelId],
      ),
      data: {
        modelId,
        approved: true,
        signer: gate.signer,
        signatureId: gate.signatureId,
        inputHash: recorded.inputHash,
        resultHash: recorded.resultHash,
      },
    };
  },
});
