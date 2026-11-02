/**
 * PST-M3 record / approve (VC-PST-18): the human gate bound to the input and result hashes, spent once and checked after recorded-ness, freshness and status;
 * staleness of recorded results after any design edit; the approval through replay, regenerate-by-replay and save / load.
 */

import { describe, expect, it, vi } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import { pipeStressDocument } from '@aec/plant/stress/model/document';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { baseDoc, cases, conditioned, DN100, recordedModel, withModel, withPipe } from './m3Fixtures';

const AT = '2026-11-02T09:30:00Z';

function portFor(): HumanSignaturePort & { verify: ReturnType<typeof vi.fn>; spend: ReturnType<typeof vi.fn> } {
  const spent = new Set<string>();
  const verify = vi.fn((signature: unknown, payload: string) =>
    (signature as { payload?: string }).payload === payload ? { signer: 'alice', signatureId: `sig-${payload.slice(0, 6)}` } : null,
  );
  const spend = vi.fn((signature: unknown) => !spent.has(JSON.stringify(signature)) && (spent.add(JSON.stringify(signature)), true));
  return { verify, spend };
}
const ctxWith = (humanSignature: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature });

const recorded = recordedModel;

/** The signature a human would produce for the recorded results of `id` in `doc`. */
function sign(doc: CadDocument, id: string, nonce = 'n1'): { payload: string; nonce: string } {
  const results = doc.plant?.stress?.models[id]?.recorded;
  if (results === undefined) throw new Error('not recorded');
  return {
    payload: humanGatePayload('plant:approve_pipe_stress', [id], { inputHash: results.inputHash, resultHash: results.resultHash }, nonce),
    nonce,
  };
}

const approve = (doc: CadDocument, id: string, nonce = 'n1', port = portFor()): CadDocument =>
  execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: sign(doc, id, nonce), at: AT }, ctxWith(port)).document;

describe('record_pipe_stress_results', () => {
  it('records status, governing ratios, support loads and the hashes; reviewRequired is always true', () => {
    const { doc, id } = recorded();
    const results = doc.plant?.stress?.models[id]?.recorded;
    expect(results).toMatchObject({ status: 'pass', reviewRequired: true, rule: 'B31.3-2018', cases: ['SUS', 'OPE', 'EXP'] });
    expect(results?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(results?.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(results?.governing.map((entry) => entry.case)).toEqual(['SUS', 'EXP']);
    expect(results?.supportLoads.length).toBe(6); // 2 anchor nodes x 3 cases
    expect(results?.findings.some((finding) => finding.code === 'PST_FRICTION_DEFAULTED')).toBe(true);
  });

  it('is deterministic: recording twice (or in a replayed history) gives the same hashes', () => {
    const { doc, id } = recorded();
    const again = apply(doc, 'record_pipe_stress_results', { modelId: id });
    expect(again.plant?.stress?.models[id]?.recorded).toEqual(doc.plant?.stress?.models[id]?.recorded);
    expect(execute(doc, 'replay_history', {}).document.plant?.stress?.models[id]?.recorded).toEqual(
      doc.plant?.stress?.models[id]?.recorded,
    );
  });

  it('records a failing status as fail (the evidence is kept), and is refused with the analysis code when the analysis cannot run', () => {
    const { doc, id } = recorded();
    const failing = apply(
      apply(doc, 'set_pipe_operating_conditions', {
        modelId: id,
        ...{
          installTempC: 21.1,
          temperatures: [{ name: 'T1', tempC: 400 }],
          wallMm: DN100.wallMm,
          material: { youngsModulusMPa: 200000, ShMPa: 1, ScMPa: 1, thermal: { table: 'carbon-steel-c1' } },
        },
      }),
      'record_pipe_stress_results',
      { modelId: id },
    );
    expect(failing.plant?.stress?.models[id]?.recorded?.status).toBe('fail');
    const noConditions = withModel(
      withPipe(
        baseDoc(),
        [
          [0, 0, 3000],
          [4000, 0, 3000],
        ],
        DN100.odMm,
      ).doc,
      ['pipe-1'],
    );
    expectRefusal(noConditions.doc, 'record_pipe_stress_results', { modelId: noConditions.id }, 'PST_CONDITIONS_MISSING');
    expectRefusal(doc, 'record_pipe_stress_results', { modelId: 'ghost' }, 'PST_MODEL_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'record_pipe_stress_results', { modelId: id }));
  });
});

describe('staleness: a design edit makes recorded results stale, never a silent pass', () => {
  it('a model edit, an added support and a changed material each raise PST_RESULTS_STALE in check_pipe_stress and analyze_pipe_stress', () => {
    const { doc, id, pipeId } = recorded();
    const fresh = data<{ items: { code: string }[] }>(doc, 'check_pipe_stress', { modelId: id });
    expect(fresh.items.map((item) => item.code)).not.toContain('PST_RESULTS_STALE');
    expect(data<{ recorded: { stale: boolean } }>(doc, 'analyze_pipe_stress', { modelId: id }).recorded.stale).toBe(false);
    const edits: CadDocument[] = [
      apply(doc, 'update_stress_model', { modelId: id, frictionCoefficient: 0.1 }),
      apply(doc, 'add_pipe_support', { pipeId, at: [[2000, 0, 3000]], type: 'shoe' }),
      conditioned(doc, id, { temperatures: [{ name: 'T1', tempC: 61 }] }),
      apply(doc, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 2000 }, kind: 'rest' }),
    ];
    for (const edited of edits) {
      const check = data<{ items: { code: string; severity: string }[] }>(edited, 'check_pipe_stress', { modelId: id });
      expect(check.items.find((item) => item.code === 'PST_RESULTS_STALE')?.severity).toBe('warn');
      expect(data<{ recorded: { stale: boolean } }>(edited, 'analyze_pipe_stress', { modelId: id }).recorded.stale).toBe(true);
    }
  });

  it('a pipe that moved (the pipe element edited) also makes the record stale', () => {
    const { doc, id, pipeId } = recorded();
    const moved = apply(doc, 'move_building_element', { elementIds: [pipeId], delta: [0, 0] });
    const check = data<{ items: { code: string }[] }>(moved, 'check_pipe_stress', { modelId: id });
    // an unchanged position is not an edit: the record stays fresh
    expect(check.items.map((item) => item.code)).not.toContain('PST_RESULTS_STALE');
    const shifted = apply(doc, 'move_building_element', { elementIds: [pipeId], delta: [0, 500] });
    expect(data<{ items: { code: string }[] }>(shifted, 'check_pipe_stress', { modelId: id }).items.map((item) => item.code)).toContain(
      'PST_RESULTS_STALE',
    );
  });

  it('loading a document reports a stale record (afterLoad) and none when fresh', () => {
    const { doc, id } = recorded();
    expect(pipeStressDocument.afterLoad?.(doc)).toEqual([]);
    const edited = apply(doc, 'update_stress_model', { modelId: id, frictionCoefficient: 0.1 });
    expect(pipeStressDocument.afterLoad?.(edited)?.[0]).toContain('PST_RESULTS_STALE');
    const approvedEdit = apply(approve(doc, id), 'update_stress_model', { modelId: id, frictionCoefficient: 0.2 });
    expect(pipeStressDocument.afterLoad?.(approvedEdit)?.[0]).toContain('stale');
  });
});

describe('approve_pipe_stress (VC-PST-18): a human act', () => {
  it('a valid signature over { act, model, inputHash, resultHash } approves, stores signer, signature id, host time and hashes', () => {
    const { doc, id } = recorded();
    const port = portFor();
    const result = execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: sign(doc, id), at: AT }, ctxWith(port));
    expect(result.rejected).toBeUndefined();
    const approval = result.document.plant?.stress?.models[id]?.approval;
    const results = doc.plant?.stress?.models[id]?.recorded;
    expect(approval).toEqual({
      signer: 'alice',
      signatureId: expect.stringMatching(/^sig-/),
      at: AT,
      inputHash: results?.inputHash,
      resultHash: results?.resultHash,
    });
    expect(result.affected).toEqual([id]);
    expect(port.spend).toHaveBeenCalledTimes(1);
    expectPure(doc, () => execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: sign(doc, id), at: AT }, ctxWith(portFor())));
  });

  it('an agent (true, nothing, no port, a bare object, a signature for other content) is refused with PST_HUMAN_GATE and approves nothing', () => {
    const { doc, id } = recorded();
    const gate = (confirmation: unknown, port: HumanSignaturePort | null = portFor()): void => {
      const result = execute(
        doc,
        'approve_pipe_stress',
        { modelId: id, ...(confirmation === undefined ? {} : { confirmation }), at: AT },
        ctxWith(port),
      );
      expect(result.error?.code).toBe('PST_HUMAN_GATE');
      expect(result.document).toBe(doc);
    };
    gate(true);
    gate(undefined);
    gate(sign(doc, id), null);
    gate({ nonce: 'x' });
    gate({ payload: humanGatePayload('plant:approve_pipe_stress', ['other'], {}, 'n1'), nonce: 'n1' });
    gate({ payload: sign(doc, id).payload }); // no nonce
  });

  it('freshness, status and recorded-ness are checked BEFORE a signature is spent', () => {
    const { doc, id } = recorded();
    const port = portFor();
    const run = (target: CadDocument, code: string): void => {
      const result = execute(target, 'approve_pipe_stress', { modelId: id, confirmation: sign(doc, id), at: AT }, ctxWith(port));
      expect(result.error?.code).toBe(code);
      expect(result.document).toBe(target);
    };
    const stale = apply(doc, 'update_stress_model', { modelId: id, frictionCoefficient: 0.1 });
    run(stale, 'PST_RESULTS_STALE');
    const unrecorded = apply(execute(doc, 'delete_stress_model', { modelId: id }).document, 'create_stress_model', {
      name: 'n',
      pipeIds: [doc.plant?.stress?.models[id]?.scope.ids[0]],
      rule: 'B31.3-2018',
    });
    const freshId = unrecorded.plant?.stress?.modelOrder[0] as string;
    expectRefusal(unrecorded, 'approve_pipe_stress', { modelId: freshId, confirmation: sign(doc, id), at: AT }, 'PST_NOT_RECORDED');
    const failing = apply(
      conditioned(doc, id, { temperatures: [{ name: 'T1', tempC: 400 }] }, { ShMPa: 1, ScMPa: 1 }),
      'record_pipe_stress_results',
      { modelId: id },
    );
    expect(failing.plant?.stress?.models[id]?.recorded?.status).toBe('fail');
    expect(
      execute(failing, 'approve_pipe_stress', { modelId: id, confirmation: sign(failing, id), at: AT }, ctxWith(port)).error?.code,
    ).toBe('PST_RESULTS_FAILING');
    const incomplete = apply(cases(doc, id, [{ name: 'SUS', type: 'SUS', basic: ['W'] }]), 'record_pipe_stress_results', { modelId: id });
    expect(
      execute(incomplete, 'approve_pipe_stress', { modelId: id, confirmation: sign(incomplete, id), at: AT }, ctxWith(port)).error?.code,
    ).toBe('PST_RESULTS_INCOMPLETE');
    expect(port.verify).not.toHaveBeenCalled();
    expect(port.spend).not.toHaveBeenCalled();
    expectRefusal(doc, 'approve_pipe_stress', { modelId: 'ghost', at: AT }, 'PST_MODEL_NOT_FOUND');
  });

  it('a signature is spent once: reusing it after the approval was dropped by a re-record is refused', () => {
    const { doc, id } = recorded();
    const port = portFor();
    const approved = approve(doc, id, 'n1', port);
    const rerecorded = apply(approved, 'record_pipe_stress_results', { modelId: id });
    expect(rerecorded.plant?.stress?.models[id]?.approval).toBeUndefined();
    const reuse = execute(rerecorded, 'approve_pipe_stress', { modelId: id, confirmation: sign(rerecorded, id), at: AT }, ctxWith(port));
    expect(reuse.error?.code).toBe('PST_HUMAN_GATE');
    expect(approve(rerecorded, id, 'n2', port).plant?.stress?.models[id]?.approval).toBeDefined();
  });

  it('approving an approved record again changes nothing; the at param must be ISO UTC (the host fills it)', () => {
    const { doc, id } = recorded();
    const approved = approve(doc, id);
    const again = execute(
      approved,
      'approve_pipe_stress',
      { modelId: id, confirmation: sign(approved, id, 'n2'), at: AT },
      ctxWith(portFor()),
    );
    expect(again.document).toBe(approved);
    expect(again.data).toMatchObject({ approved: true, unchanged: true, signer: 'alice' });
    expect(
      execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: sign(doc, id), at: 'yesterday' }, ctxWith(portFor())).rejected,
    ).toBe(true);
  });

  it('every edit drops the approval; the recorded results stay as stale evidence', () => {
    const { doc, id, pipeId } = recorded();
    const approved = approve(doc, id);
    const edits = [
      apply(approved, 'update_stress_model', { modelId: id, name: 'renamed' }),
      conditioned(approved, id),
      apply(approved, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 1000 }, kind: 'rest' }),
      cases(approved, id, [{ name: 'SUS', type: 'SUS', basic: ['W'] }]),
    ];
    for (const edited of edits) {
      expect(edited.plant?.stress?.models[id]?.approval).toBeUndefined();
      expect(edited.plant?.stress?.models[id]?.recorded).toBeDefined();
    }
    expect(ok(approved, 'update_stress_model', { modelId: id, name: 'r' }).data).toMatchObject({ approvalDropped: true });
  });
});

describe('the approval through replay, regenerate and save / load', () => {
  it('the history records confirmation { verified: true } only; replay and replay_history re-attach the same approval for unchanged results', () => {
    const { doc, id } = recorded();
    const approved = approve(doc, id);
    expect(approved.featureHistory.find((step) => step.name === 'approve_pipe_stress')?.params).toMatchObject({
      confirmation: { verified: true },
    });
    const replayed = execute(approved, 'replay_history', {}).document;
    expect(replayed.plant?.stress?.models[id]?.approval).toEqual(approved.plant?.stress?.models[id]?.approval);
    expect(replayed.plant?.stress?.models[id]?.recorded).toEqual(approved.plant?.stress?.models[id]?.recorded);
  });

  it('a replay after a later edit does not resurrect the approval, and a forged { verified: true } approves nothing', () => {
    const { doc, id } = recorded();
    const edited = apply(approve(doc, id), 'update_stress_model', { modelId: id, frictionCoefficient: 0.1 });
    expect(execute(edited, 'replay_history', {}).document.plant?.stress?.models[id]?.approval).toBeUndefined();
    const forged = execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: { verified: true }, at: AT }, ctxWith(portFor()));
    expect(forged.document).toBe(doc);
    expect(forged.data).toMatchObject({ approved: false, marker: true });
    expect(forged.document.plant?.stress?.models[id]?.approval).toBeUndefined();
  });

  it('a replay whose recorded results changed (a different history) keeps no approval for them', () => {
    const { doc, id } = recorded();
    const approved = approve(doc, id);
    const changed = apply(approved, 'record_pipe_stress_results', { modelId: id });
    expect(execute(changed, 'replay_history', {}).document.plant?.stress?.models[id]?.approval).toBeUndefined();
  });

  it('the approval is saved and loaded; a malformed approval is rejected on load', () => {
    const { doc, id } = recorded();
    const approved = approve(doc, id);
    expect(deserializeDocument(serializeDocument(approved)).plant?.stress?.models[id]?.approval).toEqual(
      approved.plant?.stress?.models[id]?.approval,
    );
    const broken = JSON.parse(serializeDocument(approved)) as {
      document: { plant: { stress: { models: Record<string, { approval: { signer: string } }> } } };
    };
    (broken.document.plant.stress.models[id] as { approval: { signer: string } }).approval.signer = '';
    expect(() => deserializeDocument(JSON.stringify(broken))).toThrow();
  });
});
