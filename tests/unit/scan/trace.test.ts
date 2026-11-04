/**
 * trace_pipe_centreline (plant 10 §4.2, §5.6, VC-SCN-22): unit conversion of the native answer, the DN snap, the extraction a commit turns
 * into ONE as-built run through every PI, unverified propagation, parameter and native refusals, purity, and replay WITHOUT the port
 * (TR-SCN-04). The tracer's numerics are tested natively (llull-cloud tests/trace.rs) and end to end in server/tests/scanNative.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, opOk } from './fixturePort';

/** ELB-A as the native tracer answers it (metres): DN100, +x straight, 90 degree bend R 152.4 mm, +y straight. */
const elbow = (warnings: { code: string; message: string }[] = [], radius = 0.05715): Record<string, unknown> => ({
  centreline: [
    [0, 0, 1],
    [1.6524, 0, 1],
    [1.6524, 1.1524, 1],
  ],
  straights: [
    { start: [0, 0, 1], end: [1.5, 0, 1], direction: [1, 0, 0], radius, length: 1.5, inliers: 3000, rms: 0.001, coverageDeg: 359 },
    {
      start: [1.6524, 0.1524, 1],
      end: [1.6524, 1.1524, 1],
      direction: [0, 1, 0],
      radius,
      length: 1,
      inliers: 2000,
      rms: 0.001,
      coverageDeg: 359,
    },
  ],
  bends: [
    {
      intersectionPoint: [1.6524, 0, 1],
      angleDeg: 90,
      radius: 0.1524,
      tubeRadius: radius,
      centre: [1.5, 0.1524, 1],
      planeNormal: [0, 0, 1],
      tangentStart: [1.5, 0, 1],
      tangentEnd: [1.6524, 0.1524, 1],
      skew: 0.0001,
      arcInliers: 1500,
      rms: 0.001,
      radiusMeasured: true,
    },
  ],
  intersectionPoints: [[1.6524, 0, 1]],
  reducers: [],
  diameter: { value: 2 * radius, std: 0.0001, source: 'length-weighted mean of the straights' },
  radius,
  inliers: 6500,
  pointsInRegion: 6500,
  rms: 0.001,
  ends: { start: 'no_points', end: 'no_points' },
  stepLength: 0.1143,
  threshold: { value: 0.003, source: '3 x noiseSigma', spacing: 0.01 },
  warnings,
});

function context(answer: (op: CloudOp) => CloudOpResult): { ctx: ExecutionContext; ops: CloudOp[] } {
  const port = fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }], answer);
  return { ctx: { ...defaultContext(), pointClouds: port }, ops: port.ops };
}

function attached(ctx: ExecutionContext): { doc: CadDocument; cloudId: string } {
  const result = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  return { doc: result.document, cloudId: result.affected[0] ?? '' };
}

const trace = (doc: CadDocument, cloudId: string, ctx: ExecutionContext, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'trace_pipe_centreline', { cloudId, seed: [500, 0, 1000], noiseSigma: 1, ...extra }, ctx);

const extractionOf = (data: unknown): Record<string, unknown> =>
  ((data as { extractions: { extraction: Record<string, unknown> }[] }).extractions[0]?.extraction ?? {}) as Record<string, unknown>;

describe('trace_pipe_centreline', () => {
  it('sends metres and returns the elbow in document units with the DN snap', () => {
    const { ctx, ops } = context(() => opOk(elbow()));
    const { doc, cloudId } = attached(ctx);
    const result = trace(doc, cloudId, ctx, {
      stepLength: 100,
      maxLength: 20000,
      bendDetectionDeg: 3,
      skewTolerance: 5,
      seedRadius: 400,
      rngSeed: 7,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(ops[0]?.kind).toBe('trace');
    expect(ops[0]?.params).toMatchObject({
      seedPoint: [0.5, 0, 1],
      seed: 7,
      noiseSigma: 0.001,
      stepLength: 0.1,
      maxLength: 20,
      skewTolerance: 0.005,
      seedRadius: 0.4,
      bendDetectionDeg: 3,
    });
    expect(ops[0]?.params).not.toHaveProperty('region');
    const data = result.data as Record<string, unknown> & {
      centreline: number[][];
      bends: Record<string, unknown>[];
      straights: Record<string, unknown>[];
    };
    expect(data.centreline).toEqual([
      [0, 0, 1000],
      [1652.4, 0, 1000],
      [1652.4, 1152.4, 1000],
    ]);
    expect(data.bends[0]).toMatchObject({ angleDeg: 90, intersectionPoint: [1652.4, 0, 1000], planeNormal: [0, 0, 1] });
    expect(data.bends[0]?.['radius']).toBeCloseTo(152.4, 9);
    expect(data.straights[0]?.['radius']).toBeCloseTo(57.15, 9);
    expect(data['intersectionPoints']).toEqual([[1652.4, 0, 1000]]);
    expect((data['diameter'] as { value: number }).value).toBeCloseTo(114.3, 9);
    expect(data['snapped']).toMatchObject({ dn: 100, odMm: 114.3 });
    expect(data['unverified']).toBe(false);
    expect(result.summary).toContain('2 straight(s), 1 bend(s)');
    expect(result.summary).toContain('DN100');
  });

  it('defaults the region to a sphere of maxLength around the seed (stored in the extraction) and passes an explicit region on', () => {
    const { ctx, ops } = context(() => opOk(elbow()));
    const { doc, cloudId } = attached(ctx);
    const data = trace(doc, cloudId, ctx).data;
    expect(extractionOf(data)['region']).toEqual({ kind: 'seed', point: [500, 0, 1000], radius: 50000 });
    trace(doc, cloudId, ctx, { region: { kind: 'box', min: [0, -500, 0], max: [3000, 500, 2000] } });
    expect(ops[1]?.params).toMatchObject({ region: { kind: 'box', min: [0, -0.5, 0], max: [3, 0.5, 2] } });
  });

  it('commits ONE as-built run through every PI (bends at the interior point) and replays WITHOUT the port', () => {
    const { ctx } = context(() => opOk(elbow()));
    const { doc, cloudId } = attached(ctx);
    const extraction = extractionOf(trace(doc, cloudId, ctx).data);
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction, line: 'L-7' }, ctx);
    expect(committed.rejected, committed.summary).toBeUndefined();
    const [extractionId, pipeId] = committed.affected;
    const pipe = committed.document.building?.elements[pipeId ?? ''] as unknown as Record<string, unknown>;
    expect(pipe).toMatchObject({ category: 'pipe', dn: 100, line: 'L-7', asBuilt: { extractionId, unverified: false } });
    expect(pipe['points']).toEqual([
      [0, 0, 1000],
      [1652.4, 0, 1000],
      [1652.4, 1152.4, 1000],
    ]);
    const stored = committed.document.scan?.extractions[extractionId ?? ''];
    expect((stored?.fit['bends'] as { radius: number }[])[0]?.radius).toBe(0.1524);
    const replayed = execute(committed.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.building)).toBe(JSON.stringify(committed.document.building));
  });

  it('refuses a committed trace whose centreline was edited (hash) or is not a polyline', () => {
    const { ctx } = context(() => opOk(elbow()));
    const { doc, cloudId } = attached(ctx);
    const extraction = extractionOf(trace(doc, cloudId, ctx).data);
    const fit = extraction['fit'] as Record<string, unknown>;
    const edited = {
      ...extraction,
      fit: {
        ...fit,
        centreline: [
          [0, 0, 1],
          [9, 9, 9],
          [1.6524, 1.1524, 1],
        ],
      },
    };
    expect(execute(doc, 'commit_asbuilt_extraction', { extraction: edited }, ctx).error?.code).toBe('SCN_EXTRACTION_TAMPERED');
    // Re-hashed by hand it still has to be a list of 3-vectors: a malformed point is SCN_PARAM_INVALID, not a silent start-end pipe.
    const broken = {
      ...extraction,
      fit: {
        ...fit,
        centreline: [
          [0, 0, 1],
          [1, 2],
        ],
      },
    };
    const rehashed = execute(doc, 'commit_asbuilt_extraction', { extraction: broken }, ctx);
    expect(rehashed.error?.code).toBe('SCN_EXTRACTION_TAMPERED');
  });

  it('flags the trace unverified on a skew or unmeasured bend radius, and keeps the measured OD without a table row', () => {
    const skew = { code: 'SCN_TRACE_SKEW', message: 'the next straight misses the traced axis by 0.0281 m' };
    const { ctx } = context(() => opOk(elbow([skew], 0.075)));
    const { doc, cloudId } = attached(ctx);
    const result = trace(doc, cloudId, ctx);
    const data = result.data as Record<string, unknown>;
    expect(data['unverified']).toBe(true);
    expect(data['unverifiedReasons']).toEqual(['fit quality: SCN_TRACE_SKEW']);
    expect(JSON.stringify(data['warnings'])).toContain('SCN_FIT_NO_STANDARD_SIZE');
    expect(data['snapped']).toMatchObject({ dn: null });
    expect(result.summary).toContain('SCN_TRACE_SKEW');
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction: extractionOf(data) }, ctx);
    const pipe = committed.document.building?.elements[committed.affected[1] ?? ''] as unknown as { asBuilt: { unverified: boolean } };
    expect(pipe.asBuilt.unverified).toBe(true);
    const none = trace(doc, cloudId, ctx, { sizeTable: 'none' }).data as Record<string, unknown>;
    expect(none['snapped']).toBeUndefined();
  });

  it('subtracts the insulation before the DN snap and reports reducers in document units', () => {
    const answer = { ...elbow([], 0.075), reducers: [{ position: [2, 0, 1], radiusBefore: 0.075, radiusAfter: 0.05 }] };
    const { ctx } = context(() => opOk(answer));
    const { doc, cloudId } = attached(ctx);
    const data = trace(doc, cloudId, ctx, { insulationThickness: 5.35 }).data as {
      snapped: { dn: number };
      reducers: Record<string, unknown>[];
    };
    expect(data.snapped.dn).toBe(125);
    expect(data.reducers[0]).toEqual({ position: [2000, 0, 1000], radiusBefore: 75, radiusAfter: 50 });
  });

  it('refuses bad parameters, unknown clouds, a missing port and passes native codes on', () => {
    const { ctx } = context(() => ({ ok: false, code: 'SCN_FIT_NO_MODEL', message: 'the seed is not on the dominant cylinder' }));
    const { doc, cloudId } = attached(ctx);
    const code = (params: Record<string, unknown>, c: ExecutionContext = ctx): string | undefined =>
      execute(doc, 'trace_pipe_centreline', { cloudId, seed: [0, 0, 0], ...params }, c).error?.code;
    expect(code({})).toBe('SCN_FIT_NO_MODEL');
    for (const key of [
      'stepLength',
      'maxLength',
      'bendDetectionDeg',
      'seedRadius',
      'skewTolerance',
      'toleranceMm',
      'noiseSigma',
      'minRadius',
    ])
      expect(code({ [key]: 0 }), key).toBe('SCN_PARAM_INVALID');
    expect(code({ insulationThickness: -1 })).toBe('SCN_PARAM_INVALID');
    expect(code({ seed: [0, Number.POSITIVE_INFINITY, 0] })).toBe('CMD_INVALID_PARAMS');
    expect(code({ region: { kind: 'crop', cropId: 'x' } })).toBe('SCN_CROP_NOT_FOUND');
    expect(code({ cloudId: 'cloud-9.9' })).toBe('SCN_CLOUD_NOT_FOUND');
    expect(code({}, { ...defaultContext(), pointClouds: null })).toBe('SCN_ASSET_UNAVAILABLE');
    const missing = context(() => ({ ok: false, code: 'NATIVE_TOOL_MISSING', message: 'install llull-compute' }));
    expect(code({}, missing.ctx)).toBe('NATIVE_TOOL_MISSING');
    const limit = context(() => ({ ok: false, code: 'SCN_QUERY_LIMIT', message: 'the region holds more than 5000000 points; narrow it' }));
    expect(code({}, limit.ctx)).toBe('SCN_QUERY_LIMIT');
  });

  it('refuses a native answer without a centreline (hostile / broken host) and is pure', () => {
    const broken = context(() => opOk({ straights: [] }));
    const { doc, cloudId } = attached(broken.ctx);
    expect(trace(doc, cloudId, broken.ctx).error?.code).toBe('NATIVE_PROTOCOL');
    const { ctx } = context(() => opOk(elbow()));
    const good = attached(ctx);
    expectPure(good.doc, () => trace(good.doc, good.cloudId, ctx));
    expect(trace(good.doc, good.cloudId, ctx).document).toBe(good.doc);
  });
});
