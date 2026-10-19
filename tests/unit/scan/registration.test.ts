/**
 * compute_registration / apply_registration / mark_registration_supplied / accept_registration (plant 10 §4, FR-SCN-08..10): the plugin's
 * op building, frames, gates, codes and the human gate, on a port whose native answers are scripted (the numerics: llull-cloud
 * tests/registration.rs, VC-SCN-30..32).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { defaultContext } from '@core/commands/context';
import { registrationPayload } from '@aec/scan/registrationCommands';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, opOk } from './fixturePort';

const shift = (x: number): number[] => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rotZ90 = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function scripted(answer: (op: CloudOp) => CloudOpResult): { ctx: ExecutionContext; ops: CloudOp[] } {
  const port = fixturePort(
    [
      { key: KEY_A, points: [[0, 0, 0]] },
      { key: KEY_B, points: [[0, 0, 0]] },
    ],
    answer,
  );
  return { ctx: { ...defaultContext(), pointClouds: port }, ops: port.ops };
}

const targets =
  (icp: Record<string, unknown> = {}) =>
  (op: CloudOp): CloudOpResult =>
    op.kind === 'register_targets'
      ? opOk({ transform: shift(0.5), rms: 0.0001, targets: [{ name: 'T1', residual: 0.0001 }] })
      : opOk({ transform: shift(0.5), rms: 0.0002, overlap: 0.8, iterations: 12, converged: true, fixedSpacing: 0.001, ...icp });

/** Fixed cloud at identity; moving cloud attached 2 m off in x (metres document). */
function twoClouds(ctx: ExecutionContext): { doc: CadDocument; fixed: string; moving: string } {
  const m: CadDocument = { ...createEmptyDocument(), units: 'm' };
  const a = execute(m, 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  const b = execute(a.document, 'attach_point_cloud', { assetKey: KEY_B, transform: shift(2) }, ctx);
  return { doc: b.document, fixed: a.affected[0] ?? '', moving: b.affected[0] ?? '' };
}

describe('compute_registration', () => {
  it('runs targets natively in document metres and returns a record in asset frames', () => {
    const { ctx, ops } = scripted(targets());
    const { doc, fixed, moving } = twoClouds(ctx);
    const pairs = ['T1', 'T2', 'T3'].map((name, i) => ({
      name,
      kind: 'sphere',
      fixedPoint: [i, 0, 0],
      movingPoint: [i + 1, 0, 0],
      radius: 0.0725,
    }));
    const result = execute(doc, 'compute_registration', { fixed, moving, method: 'targets', targets: pairs }, ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.document).toBe(doc);
    expect(ops[0]?.kind).toBe('register_targets');
    expect((ops[0]?.params['targets'] as unknown[])[0]).toEqual({
      name: 'T1',
      kind: 'sphere',
      fixed: [0, 0, 0],
      moving: [1, 0, 0],
      radius: 0.0725,
    });
    expect(ops[0]?.clouds.map((c) => c.toDocument[3])).toEqual([0, 2]);
    const data = result.data as {
      record: { transform: number[]; status: string; quality: { targetResiduals: unknown[] } };
      gates: unknown;
    };
    // delta = +0.5 in the document; record = fixed⁻¹ · delta · moving = +2.5 (moving asset -> fixed asset).
    expect(data.record.transform[3]).toBeCloseTo(2.5, 12);
    expect(data.record.status).toBe('computed');
    expect(data.record.quality.targetResiduals).toHaveLength(1);
    expect(JSON.stringify(data.gates)).toContain('"defaulted":true');
  });

  it('chains targets into ICP, starts ICP from an initial record, and flags gates as unverified', () => {
    const { ctx, ops } = scripted(targets({ rms: 0.01 }));
    const { doc, fixed, moving } = twoClouds(ctx);
    const pairs = ['A', 'B', 'C'].map((name, i) => ({ name, kind: 'point', fixedPoint: [i, i * i, 0], movingPoint: [i, i * i, 1] }));
    const chained = execute(doc, 'compute_registration', { fixed, moving, method: 'targets+icp', targets: pairs }, ctx);
    expect(ops.map((op) => op.kind)).toEqual(['register_targets', 'icp']);
    expect(ops[1]?.params['initial']).toEqual(shift(0.5));
    expect((chained.data as { record: { status: string } }).record.status).toBe('unverified');
    expect(JSON.stringify((chained.data as { warnings: unknown }).warnings)).toContain('SCN_REGISTRATION_UNVERIFIED');
    execute(
      doc,
      'compute_registration',
      { fixed, moving, method: 'icp_point_to_plane', initial: shift(-2), maxIterations: 5, trimRatio: 0.8 },
      ctx,
    );
    expect(ops[2]?.params).toMatchObject({ method: 'point_to_plane', maxIterations: 5, trimRatio: 0.8 });
    expect((ops[2]?.params['initial'] as number[])[3]).toBeCloseTo(-4, 12);
  });

  it('refuses non-convergence with the record in data, and bad inputs with stable codes (VC-SCN-32)', () => {
    const { ctx } = scripted(targets({ converged: true, overlap: 0.05 }));
    const { doc, fixed, moving } = twoClouds(ctx);
    const lowOverlap = execute(doc, 'compute_registration', { fixed, moving, method: 'icp_point_to_point' }, ctx);
    expect(lowOverlap.error?.code).toBe('SCN_REG_NOT_CONVERGED');
    expect((lowOverlap.data as { record: { quality: { converged: boolean } } }).record.quality.converged).toBe(false);
    expect(lowOverlap.document).toBe(doc);
    const code = (params: Record<string, unknown>, context = ctx): string | undefined =>
      execute(doc, 'compute_registration', params, context).error?.code;
    expect(code({ fixed, moving: fixed, method: 'targets' })).toBe('SCN_REG_SAME_CLOUD');
    expect(code({ fixed: 'cloud-0.0', moving, method: 'targets' })).toBe('SCN_CLOUD_NOT_FOUND');
    expect(code({ fixed, moving, method: 'icp_point_to_point', trimRatio: 0 })).toBe('SCN_PARAM_INVALID');
    expect(
      code({ fixed, moving, method: 'targets', targets: [{ name: 'x', kind: 'sphere', fixedPoint: [0, 0, 0], movingPoint: [0, 0, 0] }] }),
    ).toBe('SCN_PARAM_INVALID');
    expect(code({ fixed, moving, method: 'icp_point_to_point', region: { kind: 'box', min: [1, 0, 0], max: [0, 1, 1] } })).toBe(
      'SCN_CROP_INVALID',
    );
    const failing = scripted(() => ({ ok: false, code: 'SCN_REG_TARGETS_INSUFFICIENT', message: '2 target pair(s)' }));
    expect(code({ fixed, moving, method: 'targets', targets: [] }, failing.ctx)).toBe('SCN_REG_TARGETS_INSUFFICIENT');
    const missing = scripted(() => ({ ok: false, code: 'NATIVE_TOOL_MISSING', message: 'llull-compute not found' }));
    expect(code({ fixed, moving, method: 'icp_point_to_point' }, missing.ctx)).toBe('NATIVE_TOOL_MISSING');
  });

  it('is pure', () => {
    const { ctx } = scripted(targets());
    const { doc, fixed, moving } = twoClouds(ctx);
    expectPure(doc, () => execute(doc, 'compute_registration', { fixed, moving, method: 'icp_point_to_point' }, ctx));
  });
});

describe('apply / supplied / accept', () => {
  const recordFor = (fixed: string, moving: string, transform = rotZ90): Record<string, unknown> => ({
    fixed,
    moving,
    method: 'icp_point_to_point',
    transform,
    quality: { rms: 0.0002, overlap: 0.9, iterations: 10, converged: true },
    status: 'computed',
    provenance: { method: 'icp_point_to_point', algorithmVersion: 'llull-compute 0.1.0/register-1', device: 'cpu', deterministic: true },
  });

  it('applies a rigid record onto the fixed cloud and records it', () => {
    const { ctx } = scripted(targets());
    const { doc, fixed, moving } = twoClouds(ctx);
    const applied = execute(doc, 'apply_registration', { record: recordFor(fixed, moving) });
    const id = applied.affected[0] ?? '';
    expect(id).toMatch(/^reg-/);
    expect(applied.document.scan?.clouds[moving]).toMatchObject({ transform: rotZ90, registrationId: id });
    expect(applied.document.scan?.registrations[id]).toMatchObject({ status: 'computed', method: 'icp_point_to_point' });
  });

  it('refuses non-rigid, unconverged, unknown and same-cloud records', () => {
    const { ctx } = scripted(targets());
    const { doc, fixed, moving } = twoClouds(ctx);
    const code = (record: Record<string, unknown>): string | undefined => execute(doc, 'apply_registration', { record }).error?.code;
    expect(code(recordFor(fixed, moving, [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))).toBe('SCN_REG_NOT_RIGID');
    expect(code(recordFor(fixed, moving, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))).toBe('SCN_REG_NOT_RIGID');
    expect(code({ ...recordFor(fixed, moving), quality: { rms: 1, converged: false } })).toBe('SCN_REG_NOT_CONVERGED');
    expect(code(recordFor(fixed, 'cloud-0.0'))).toBe('SCN_CLOUD_NOT_FOUND');
    expect(code(recordFor(fixed, fixed))).toBe('SCN_REG_SAME_CLOUD');
  });

  it('marks supplied data unverified and accepts only with a verified human signature', () => {
    const { ctx } = scripted(targets());
    const { doc, moving } = twoClouds(ctx);
    const supplied = execute(doc, 'mark_registration_supplied', { cloudId: moving, reportRef: 'contractor report 7' });
    const id = supplied.affected[0] ?? '';
    expect(supplied.document.scan?.registrations[id]).toMatchObject({
      method: 'supplied',
      status: 'unverified',
      quality: null,
      fixed: 'document',
    });
    expect(execute(supplied.document, 'mark_registration_supplied', { cloudId: 'x' }).error?.code).toBe('SCN_CLOUD_NOT_FOUND');
    const agent = execute(supplied.document, 'accept_registration', { registrationId: id, signature: true });
    expect(agent.error?.code).toBe('SCN_HUMAN_GATE');
    expect(agent.document).toBe(supplied.document);
    const record = supplied.document.scan?.registrations[id];
    const signing: ExecutionContext = {
      ...defaultContext(),
      humanSignature: {
        verify: (signature, payload) =>
          signature === 'ok' && record !== undefined && payload === registrationPayload(record)
            ? { signer: 'pat', signatureId: 's1' }
            : null,
      },
    };
    expect(execute(supplied.document, 'accept_registration', { registrationId: id, signature: 'forged' }, signing).error?.code).toBe(
      'SCN_HUMAN_GATE',
    );
    expect(execute(supplied.document, 'accept_registration', { registrationId: 'reg-0.0', signature: 'ok' }, signing).error?.code).toBe(
      'SCN_REG_NOT_FOUND',
    );
    const accepted = execute(supplied.document, 'accept_registration', { registrationId: id, signature: 'ok' }, signing);
    expect(accepted.document.scan?.registrations[id]).toMatchObject({
      status: 'accepted',
      acceptedBy: { signer: 'pat', signatureId: 's1' },
    });
  });

  it('are pure', () => {
    const { ctx } = scripted(targets());
    const { doc, fixed, moving } = twoClouds(ctx);
    expectPure(doc, () => execute(doc, 'apply_registration', { record: recordFor(fixed, moving) }));
    expectPure(doc, () => execute(doc, 'mark_registration_supplied', { cloudId: moving }));
  });
});
