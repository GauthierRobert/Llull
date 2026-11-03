/** PST-GATE / PST-HARDEN: a recorded { verified: true } approves only inside the history replay; a non-finite stress is refused, never recorded; carry checks the result hash. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { pipeStressDocument } from '@aec/plant/stress/model/document';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { anchorAt, baseDoc, cases, conditioned, DN100, recordedModel, withModel, withPipe } from './m3Fixtures';

const AT = '2026-11-02T09:30:00Z';
const marker = (id: string): Record<string, unknown> => ({ modelId: id, confirmation: { verified: true }, at: AT });

describe('approve_pipe_stress with a recorded marker (PST-GATE)', () => {
  it('a live { verified: true } is refused with PST_HUMAN_GATE and the document is untouched', () => {
    const { doc, id } = recordedModel();
    const result = expectRefusal(doc, 'approve_pipe_stress', marker(id), 'PST_HUMAN_GATE', 'confirmation');
    expect(result.document.plant?.stress?.models[id]?.approval).toBeUndefined();
  });

  it('is a no-op report while replaying (ctx.replaying)', () => {
    const { doc, id } = recordedModel();
    const result = execute(doc, 'approve_pipe_stress', marker(id), { ...defaultContext(), replaying: true });
    expect(result.rejected).not.toBe(true);
    expect(result.document).toBe(doc);
    expect(result.data).toMatchObject({ approved: false, marker: true });
  });

  it('the real replay path re-applies the recorded approval step without refusing it', () => {
    const { doc, id } = recordedModel();
    const signed = { ...doc };
    const model = doc.plant?.stress?.models[id];
    if (model?.recorded === undefined) throw new Error('not recorded');
    const approval = {
      signer: 'alice',
      signatureId: 'sig-1',
      at: AT,
      inputHash: model.recorded.inputHash,
      resultHash: model.recorded.resultHash,
    };
    const withApproval: CadDocument = {
      ...signed,
      plant: { ...doc.plant, stress: { ...doc.plant?.stress, models: { ...doc.plant?.stress?.models, [id]: { ...model, approval } } } },
    } as CadDocument;
    const live = {
      ...withApproval,
      featureHistory: [
        ...withApproval.featureHistory,
        { id: 'step-x', name: 'approve_pipe_stress', params: { modelId: id, confirmation: { verified: true }, at: AT } },
      ],
    } as CadDocument;
    const replayed = execute(live, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(replayed.summary).not.toMatch(/PST_HUMAN_GATE|fail/i);
    expect(replayed.document.plant?.stress?.models[id]?.approval).toEqual(approval);
  });
});

describe('carry (PST-HARDEN)', () => {
  const approvedFrom = (doc: CadDocument, id: string, resultHash: string): CadDocument => {
    const model = doc.plant?.stress?.models[id];
    if (model?.recorded === undefined) throw new Error('not recorded');
    const approval = { signer: 'alice', signatureId: 's', at: AT, inputHash: model.recorded.inputHash, resultHash };
    return {
      ...doc,
      plant: { ...doc.plant, stress: { ...doc.plant?.stress, models: { ...doc.plant?.stress?.models, [id]: { ...model, approval } } } },
    } as CadDocument;
  };

  it('re-attaches an approval whose result hash equals the replayed record', () => {
    const { doc, id } = recordedModel();
    const hash = doc.plant?.stress?.models[id]?.recorded?.resultHash as string;
    const carried = pipeStressDocument.carry?.(approvedFrom(doc, id, hash), doc);
    expect(carried?.plant?.stress?.models[id]?.approval?.resultHash).toBe(hash);
  });

  it('drops an approval whose stored result hash differs from the replayed record', () => {
    const { doc, id } = recordedModel();
    const carried = pipeStressDocument.carry?.(approvedFrom(doc, id, 'f'.repeat(64)), doc);
    expect(carried).toBe(doc);
    expect(carried?.plant?.stress?.models[id]?.approval).toBeUndefined();
  });
});

describe('a non-finite governing ratio is refused (PST-HARDEN)', () => {
  function degenerate(): { doc: CadDocument; id: string } {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId]);
    let d = conditioned(doc, id, { temperatures: [{ name: 'T1', tempC: 60 }] }, { ShMPa: 1e-320, ScMPa: 1e-320 });
    d = anchorAt(anchorAt(d, id, pipeId, 0), id, pipeId, 4000);
    d = cases(d, id, [
      { name: 'SUS', type: 'SUS', basic: ['W'] },
      { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
      {
        name: 'EXP',
        type: 'EXP',
        combine: [
          { case: 'OPE', factor: 1 },
          { case: 'SUS', factor: -1 },
        ],
      },
    ]);
    return { doc: d, id };
  }

  it('analyze, check and record refuse with PST_STRESS_NOT_FINITE; nothing is recorded', () => {
    const { doc, id } = degenerate();
    for (const name of ['analyze_pipe_stress', 'check_pipe_stress', 'record_pipe_stress_results'])
      expectRefusal(doc, name, { modelId: id }, 'PST_STRESS_NOT_FINITE', 'conditions.material');
    expect(apply(doc, 'update_stress_model', { modelId: id, name: 'r' }).plant?.stress?.models[id]?.recorded).toBeUndefined();
  });
});

describe('a non-finite solve is refused by the frame backstop (PST-HARDEN)', () => {
  it('an overflowing force gives PST_UNSTABLE on analyze and record; nothing is recorded', () => {
    const { doc, id, pipeId } = recordedModel();
    const overflow = apply(doc, 'set_stress_load_cases', {
      modelId: id,
      cases: [
        { name: 'SUS', type: 'SUS', basic: ['W'] },
        { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
        { name: 'OCC', type: 'OCC', basic: ['W', 'F1'] },
        {
          name: 'EXP',
          type: 'EXP',
          combine: [
            { case: 'OPE', factor: 1 },
            { case: 'SUS', factor: -1 },
          ],
        },
      ],
      forces: [{ name: 'F1', pipeId, atMm: 2000, forceN: [0, 0, 1e308] }],
    });
    expectRefusal(overflow, 'analyze_pipe_stress', { modelId: id }, 'PST_UNSTABLE');
    expectRefusal(overflow, 'record_pipe_stress_results', { modelId: id }, 'PST_UNSTABLE');
  });
});
