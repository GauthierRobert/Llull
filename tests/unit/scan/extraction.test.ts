/**
 * fit_primitive, extract_pipes, slice_cloud, commit / accept_asbuilt_extraction (plant 10 §4, §5.6): unit conversion, the DN snap on the
 * llull table (VC-SCN-21), unverified propagation (VC-SCN-51), tamper and duplicate refusals, the human gate, and replay WITHOUT the port
 * giving the same document (TR-SCN-04). Native answers are scripted (numerics: llull-cloud tests/fits.rs, VC-SCN-20 / 24).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { snapDn } from '@aec/scan/extraction';
import { extractionPayload } from '@aec/scan/extractionCommands';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, opOk } from './fixturePort';

/** A native cylinder fit of radius `r` (metres) between (0,0,1) and (2,0,1). */
const cylinderFit = (r: number, warnings: { code: string; message: string }[] = []): Record<string, unknown> => ({
  axisPoint: [1, 0, 1],
  axisDirection: [1, 0, 0],
  radius: r,
  start: [0, 0, 1],
  end: [2, 0, 1],
  length: 2,
  inliers: 4000,
  pointsInRegion: 4100,
  rms: 0.001,
  coverageDeg: 180,
  covariance: [[1e-8]],
  std: { radius: 3e-5, axisAngleDeg: 0.003, axisPosition: 8e-5 },
  crlb: { radius: 3e-5, axisAngleDeg: 0.003, axisPosition: 8e-5 },
  threshold: { value: 0.003, source: '3 x noiseSigma', spacing: 0.01 },
  ransacIterations: 40,
  warnings,
});

function context(answer: (op: CloudOp) => CloudOpResult): { ctx: ExecutionContext; ops: CloudOp[] } {
  const port = fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }], answer);
  return { ctx: { ...defaultContext(), pointClouds: port }, ops: port.ops };
}

const pipeAnswer =
  (r: number, warnings: { code: string; message: string }[] = []) =>
  (op: CloudOp): CloudOpResult =>
    op.kind === 'extract_pipes'
      ? opOk({ extractions: [cylinderFit(r, warnings)], rejected: [] })
      : opOk({ ...cylinderFit(r, warnings), kind: 'cylinder' });

function attached(ctx: ExecutionContext): { doc: CadDocument; cloudId: string } {
  const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const extract = (
  doc: CadDocument,
  cloudId: string,
  ctx: ExecutionContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const result = execute(doc, 'extract_pipes', { cloudId, region: { kind: 'all' }, noiseSigma: 1, ...extra }, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  return result.data as Record<string, unknown>;
};

const firstExtraction = (data: Record<string, unknown>): Record<string, unknown> =>
  ((data['extractions'] as Record<string, unknown>[])[0]?.['extraction'] ?? {}) as Record<string, unknown>;

describe('DN snap (VC-SCN-21)', () => {
  it('snaps the CYL-A / B / C diameters and the 140 / 150 mm cases on the llull table', () => {
    expect(snapDn(114.3)).toMatchObject({ dn: 100, odMm: 114.3, toleranceMm: 1.5, defaulted: true });
    expect(snapDn(219.1).dn).toBe(200);
    expect(snapDn(60.3).dn).toBe(50);
    expect(snapDn(140).dn).toBe(125);
    expect(snapDn(150)).toMatchObject({ dn: null, odMm: 150 });
    expect(snapDn(150, 10)).toMatchObject({ dn: null, defaulted: false });
    expect(snapDn(165, 10).dn).toBe(150);
  });
});

describe('extract_pipes / fit_primitive', () => {
  it('converts to document units, snaps DN100 and returns a committable extraction', () => {
    const { ctx, ops } = context(pipeAnswer(0.05715));
    const { doc, cloudId } = attached(ctx);
    const data = extract(doc, cloudId, ctx, { minRadius: 10, maxRadius: 500, toleranceMm: 1.5 });
    expect(ops[0]?.params).toMatchObject({ noiseSigma: 0.001, minRadius: 0.01, maxRadius: 0.5, region: { kind: 'all' } });
    const first = (data['extractions'] as Record<string, unknown>[])[0] ?? {};
    expect(first['radius']).toBeCloseTo(57.15, 9);
    expect(first['start']).toEqual([0, 0, 1000]);
    expect(first['snapped']).toMatchObject({ dn: 100 });
    expect(first['unverified']).toBe(false);
    expect(firstExtraction(data)['extractionHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the measured OD with SCN_FIT_NO_STANDARD_SIZE, and subtracts the insulation before the snap', () => {
    const { ctx } = context(pipeAnswer(0.075));
    const { doc, cloudId } = attached(ctx);
    const data = extract(doc, cloudId, ctx);
    expect(JSON.stringify(data['warnings'])).toContain('SCN_FIT_NO_STANDARD_SIZE');
    const insulated = extract(doc, cloudId, ctx, { insulationThickness: 5.35 });
    expect(((insulated['extractions'] as Record<string, unknown>[])[0]?.['snapped'] as { dn: number }).dn).toBe(125);
    const none = extract(doc, cloudId, ctx, { sizeTable: 'none' });
    expect((none['extractions'] as Record<string, unknown>[])[0]?.['snapped']).toBeUndefined();
  });

  it('fit_primitive reports a cylinder with its extraction and low-coverage unverified flags', () => {
    const { ctx } = context(pipeAnswer(0.03, [{ code: 'SCN_FIT_LOW_COVERAGE', message: 'coverage 40 deg' }]));
    const { doc, cloudId } = attached(ctx);
    const result = execute(
      doc,
      'fit_primitive',
      { cloudId, kind: 'cylinder', region: { kind: 'seed', point: [0, 0, 1000], radius: 500 } },
      ctx,
    );
    const data = result.data as Record<string, unknown>;
    expect(data['unverified']).toBe(true);
    expect(data['unverifiedReasons']).toEqual(['fit quality: SCN_FIT_LOW_COVERAGE']);
    expect(data['extraction']).toBeDefined();
    expect(result.summary).toContain('SCN_FIT_LOW_COVERAGE');
    const plane = context(() => opOk({ kind: 'plane', point: [0, 0, 1], normal: [0, 0, 1], inliers: 50, rms: 0.0005, warnings: [] }));
    const p = attached(plane.ctx);
    const planeData = execute(p.doc, 'fit_primitive', { cloudId: p.cloudId, kind: 'plane', region: { kind: 'all' } }, plane.ctx)
      .data as Record<string, unknown>;
    expect(planeData['point']).toEqual([0, 0, 1000]);
    expect(planeData['extraction']).toBeUndefined();
  });

  it('refuse bad parameters and pass native codes on (VC-SCN-50: an empty region is SCN_FIT_TOO_FEW_POINTS)', () => {
    const { ctx } = context(() => ({ ok: false, code: 'SCN_FIT_TOO_FEW_POINTS', message: '0 point(s) in the region' }));
    const { doc, cloudId } = attached(ctx);
    const code = (name: string, params: Record<string, unknown>): string | undefined => execute(doc, name, params, ctx).error?.code;
    expect(code('extract_pipes', { cloudId, region: { kind: 'box', min: [9e6, 9e6, 9e6], max: [9e6 + 1, 9e6 + 1, 9e6 + 1] } })).toBe(
      'SCN_FIT_TOO_FEW_POINTS',
    );
    expect(code('extract_pipes', { cloudId, region: { kind: 'all' }, insulationThickness: -1 })).toBe('SCN_PARAM_INVALID');
    expect(code('extract_pipes', { cloudId, region: { kind: 'all' }, toleranceMm: 0 })).toBe('SCN_PARAM_INVALID');
    expect(code('fit_primitive', { cloudId, kind: 'plane', region: { kind: 'all' }, noiseSigma: -2 })).toBe('SCN_PARAM_INVALID');
    expect(code('fit_primitive', { cloudId, kind: 'plane', region: { kind: 'crop', cropId: 'x' } })).toBe('SCN_CROP_NOT_FOUND');
    expect(code('fit_primitive', { cloudId: 'cloud-9.9', kind: 'plane', region: { kind: 'all' } })).toBe('SCN_CLOUD_NOT_FOUND');
  });
});

describe('slice_cloud', () => {
  it('sends metres and returns sections in document units', () => {
    const { ctx, ops } = context(() =>
      opOk({
        uAxis: [0, 1, 0],
        vAxis: [0, 0, 1],
        count: 3,
        truncated: false,
        points: [[0.1, 0.2]],
        circles: [{ centre: [1.5, 0, 0], centreUv: [0, 0], radius: 0.10955, rms: 0.002, radiusStd: 0.0003, inliers: 40 }],
        lines: [{ start: [0, 0, 0], end: [1, 0, 0], startUv: [0, 0], endUv: [1, 0], rms: 0.001, inliers: 20 }],
        band: 0.006,
      }),
    );
    const { doc, cloudId } = attached(ctx);
    const result = execute(
      doc,
      'slice_cloud',
      { cloudId, origin: [1500, 0, 0], normal: [1, 0, 0], thickness: 20, fit: 'circle', noiseSigma: 2, minRadius: 10, maxRadius: 500 },
      ctx,
    );
    expect(ops[0]?.params).toMatchObject({ origin: [1.5, 0, 0], thickness: 0.02, fit: 'circle', noiseSigma: 0.002 });
    const data = result.data as { circles: { radius: number; centre: number[] }[]; points: number[][]; lines: unknown[] };
    expect(data.circles[0]?.radius).toBeCloseTo(109.55, 9);
    expect(data.circles[0]?.centre).toEqual([1500, 0, 0]);
    expect(data.points[0]).toEqual([100, 200]);
    expect(data.lines).toHaveLength(1);
    expect(execute(doc, 'slice_cloud', { cloudId, origin: [0, 0, 0], normal: [0, 0, 0], thickness: 1 }, ctx).error?.code).toBe(
      'SCN_PARAM_INVALID',
    );
    expect(execute(doc, 'slice_cloud', { cloudId, origin: [0, 0, 0], normal: [0, 0, 1], thickness: 0 }, ctx).error?.code).toBe(
      'SCN_PARAM_INVALID',
    );
    expect(
      execute(
        doc,
        'slice_cloud',
        { cloudId, origin: [0, 0, 0], normal: [0, 0, 1], thickness: 1, region: { kind: 'crop', cropId: 'c' } },
        ctx,
      ).error?.code,
    ).toBe('SCN_CROP_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'slice_cloud', { cloudId, origin: [0, 0, 0], normal: [0, 0, 1], thickness: 1 }, ctx));
  });
});

describe('commit_asbuilt_extraction / accept_asbuilt_extraction', () => {
  it('creates an as-built pipe run from the fit and replays identically WITHOUT the port (TR-SCN-04)', () => {
    const { ctx } = context(pipeAnswer(0.05715));
    const { doc, cloudId } = attached(ctx);
    const extraction = firstExtraction(extract(doc, cloudId, ctx));
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction, line: 'L-101' }, ctx);
    expect(committed.rejected, committed.summary).toBeUndefined();
    const [extractionId, pipeId] = committed.affected;
    const pipe = committed.document.building?.elements[pipeId ?? ''] as unknown as Record<string, unknown>;
    expect(pipe).toMatchObject({ category: 'pipe', dn: 100, line: 'L-101', asBuilt: { extractionId, unverified: false } });
    expect(pipe['diameter']).toBeCloseTo(114.3, 9);
    expect(pipe['points']).toEqual([
      [0, 0, 1000],
      [2000, 0, 1000],
    ]);
    expect(committed.document.scan?.extractions[extractionId ?? '']).toMatchObject({ status: 'computed', createdElementIds: [pipeId] });
    // Replay with no point-cloud port at all: same document.
    const replayed = execute(committed.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.scan)).toBe(JSON.stringify(committed.document.scan));
    expect(JSON.stringify(replayed.document.building)).toBe(JSON.stringify(committed.document.building));
  });

  it('refuses a tampered or duplicate extraction and an unknown cloud (VC-SCN-50 / 51 codes)', () => {
    const { ctx } = context(pipeAnswer(0.05715));
    const { doc, cloudId } = attached(ctx);
    const extraction = firstExtraction(extract(doc, cloudId, ctx));
    const code = (target: CadDocument, params: Record<string, unknown>): string | undefined =>
      execute(target, 'commit_asbuilt_extraction', params, ctx).error?.code;
    expect(code(doc, { extraction: { ...extraction, fit: { ...(extraction['fit'] as object), radius: 0.06 } } })).toBe(
      'SCN_EXTRACTION_TAMPERED',
    );
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx).document;
    expect(code(committed, { extraction })).toBe('SCN_EXTRACTION_DUPLICATE');
    const detached = execute(doc, 'detach_point_cloud', { cloudId }).document;
    expect(code(detached, { extraction })).toBe('SCN_CLOUD_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'commit_asbuilt_extraction', { extraction }, ctx));
  });

  it('marks the run unverified when the cloud registration is unverified (VC-SCN-51) and gates acceptance', () => {
    const { ctx } = context(pipeAnswer(0.05715));
    const { doc, cloudId } = attached(ctx);
    const supplied = execute(doc, 'mark_registration_supplied', { cloudId }).document;
    const data = extract(supplied, cloudId, ctx);
    expect((data['extractions'] as Record<string, unknown>[])[0]?.['unverified']).toBe(true);
    const committed = execute(supplied, 'commit_asbuilt_extraction', { extraction: firstExtraction(data) }, ctx);
    const [extractionId, pipeId] = committed.affected;
    expect(
      (committed.document.building?.elements[pipeId ?? ''] as unknown as { asBuilt: { unverified: boolean } }).asBuilt.unverified,
    ).toBe(true);
    const agent = execute(committed.document, 'accept_asbuilt_extraction', { extractionId, signature: true });
    expect(agent.error?.code).toBe('SCN_HUMAN_GATE');
    const record = committed.document.scan?.extractions[extractionId ?? ''];
    const signing: ExecutionContext = {
      ...defaultContext(),
      humanSignature: {
        verify: (s, payload) =>
          s === 'ok' && record !== undefined && payload === extractionPayload(record) ? { signer: 'pe', signatureId: 'x1' } : null,
      },
    };
    expect(execute(committed.document, 'accept_asbuilt_extraction', { extractionId, signature: 'no' }, signing).error?.code).toBe(
      'SCN_HUMAN_GATE',
    );
    expect(
      execute(committed.document, 'accept_asbuilt_extraction', { extractionId: 'ext-0.0', signature: 'ok' }, signing).error?.code,
    ).toBe('SCN_EXTRACTION_NOT_FOUND');
    const accepted = execute(committed.document, 'accept_asbuilt_extraction', { extractionId, signature: 'ok' }, signing);
    expect(accepted.document.scan?.extractions[extractionId ?? '']).toMatchObject({ status: 'accepted', acceptedBy: { signer: 'pe' } });
  });
});
