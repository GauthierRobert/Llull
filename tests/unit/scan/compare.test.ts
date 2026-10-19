/**
 * cloud_to_model_deviation, check_asbuilt_clash, check_point_clouds (plant 10 §4.2, §5.9, §5.10, FR-SCN-17..20): design entities become
 * the right primitives in metres, the results come back in document units with reviewRequired (VC-SCN-52) and the named noise threshold,
 * and the health list reports unverified / stale / missing items (VC-SCN-51). Native answers are scripted (numerics: llull-cloud
 * tests/compare.rs, VC-SCN-40..43).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import { resolveDesign, tubeTriangles } from '@aec/scan/designPrimitives';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, opOk } from './fixturePort';

function context(answer: (op: CloudOp) => CloudOpResult, keys = [KEY_A]): { ctx: ExecutionContext; ops: CloudOp[] } {
  const port = fixturePort(
    keys.map((key) => ({ key, points: [[0, 0, 0]] })),
    answer,
  );
  return { ctx: { ...defaultContext(), pointClouds: port }, ops: port.ops };
}

const deviationAnswer = (op: CloudOp): CloudOpResult =>
  opOk({
    entities: ((op.params['entities'] as { id: string }[]) ?? []).map((e) => ({
      id: e.id,
      pointsUsed: 100,
      min: -0.025,
      max: 0.025,
      mean: 0,
      rms: 0.0176485,
      fractionBeyondThreshold: 0.744444,
      histogram: [1, 2],
      pipe: { fittedAxisOffset: 0.025, offsetVector: [0, 0.025, 0], radiusDelta: 0, fittedRadius: 0.10955 },
    })),
    pointsInRange: 100,
  });

const clashAnswer = (op: CloudOp): CloudOpResult =>
  opOk({
    results: ((op.params['entities'] as { id: string }[]) ?? []).map((e, i) => ({
      id: e.id,
      status: ['hard', 'clearance', 'clear'][i] ?? 'clear',
      minGap: [-0.0437, 0.0563, 0.3063][i] ?? null,
      location: [1, 0, 0.1],
      points: i < 2 ? 50 : 0,
      noisePoints: 0,
      excludedPoints: 0,
      clusters:
        i < 2 ? [{ points: 50, minGap: -0.0437, location: [1, 0, 0.1], bboxMin: [0, 0, 0], bboxMax: [2, 0.1, 0.1], status: 'hard' }] : [],
    })),
    spacing: 0.004,
    samplingBound: 0.002,
    pointsInRange: 1000,
  });

/** mm document: a cloud, a pipe run, a cylinder, a box, a sphere and a 2D polyline. */
function scene(ctx: ExecutionContext): {
  doc: CadDocument;
  cloudId: string;
  ids: Record<'pipe' | 'cylinder' | 'box' | 'sphere' | 'line', string>;
} {
  let doc = createEmptyDocument();
  const step = (name: string, params: unknown): string => {
    const result = execute(doc, name, params, ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    doc = result.document;
    return result.affected[0] ?? '';
  };
  const cloudId = step('attach_point_cloud', { assetKey: KEY_A });
  const ids = {
    pipe: step('add_pipe_run', {
      points: [
        [0, -25, 0],
        [2000, -25, 0],
      ],
      dn: 200,
    }),
    cylinder: step('add_cylinder', { radius: 100, height: 2000, axis: [1, 0, 0], position: [1000, 0, 500] }),
    box: step('add_box', { size: [100, 200, 300], position: [0, 0, 1000] }),
    sphere: step('add_sphere', { radius: 50, position: [0, 500, 0] }),
    line: step('draw_polyline', {
      points: [
        [0, 0],
        [100, 0],
      ],
    }),
  };
  return { doc, cloudId, ids };
}

describe('design primitives', () => {
  it('maps pipe runs, cylinders, boxes and spheres to metres, and tessellates with the sagitta bound', () => {
    const { ctx } = context(deviationAnswer);
    const { doc, ids } = scene(ctx);
    const pipe = resolveDesign(doc, ids.pipe, false, 24);
    expect(pipe.ok && pipe.entity.primitives[0]).toMatchObject({ kind: 'cylinder', start: [0, -0.025, 0], end: [2, -0.025, 0] });
    expect(pipe.ok && pipe.entity.pipe?.radius).toBeCloseTo(0.10955, 12);
    const tessellated = resolveDesign(doc, ids.pipe, true, 64);
    expect(tessellated.ok && tessellated.entity.modelErrorBound).toBeCloseTo(0.10955 * (1 - Math.cos(Math.PI / 64)), 15);
    const cylinder = resolveDesign(doc, ids.cylinder, false, 24);
    expect(cylinder.ok && cylinder.entity.primitives[0]?.kind).toBe('cylinder');
    const box = resolveDesign(doc, ids.box, false, 24);
    expect(box.ok && box.entity.primitives[0]).toMatchObject({ kind: 'box', half: [0.05, 0.1, 0.15] });
    expect(resolveDesign(doc, ids.box, true, 24)).toMatchObject({ ok: true, entity: { modelErrorBound: 0 } });
    expect(resolveDesign(doc, ids.sphere, false, 24)).toMatchObject({
      ok: true,
      entity: { primitives: [{ kind: 'sphere', radius: 0.05 }] },
    });
    expect(resolveDesign(doc, ids.sphere, true, 24)).toMatchObject({ ok: true, entity: { modelErrorBound: null } });
    expect(resolveDesign(doc, ids.cylinder, true, 32)).toMatchObject({ ok: true, entity: { primitives: [{ kind: 'mesh' }] } });
    expect(resolveDesign(doc, ids.line, false, 24)).toMatchObject({ ok: false, code: 'SCN_ENTITY_UNSUPPORTED' });
    expect(resolveDesign(doc, 'nope', false, 24)).toMatchObject({ ok: false, code: 'SCN_ENTITY_NOT_FOUND' });
    expect(tubeTriangles([0, 0, 0], [1, 0, 0], 1, 8, true)).toHaveLength(8 * 4 * 9);
  });
});

describe('cloud_to_model_deviation', () => {
  it('sends metres and reports in document units with the review flag (VC-SCN-41 / 52 shape)', () => {
    const { ctx, ops } = context(deviationAnswer);
    const { doc, cloudId, ids } = scene(ctx);
    const result = execute(doc, 'cloud_to_model_deviation', { cloudId, entityIds: [ids.pipe], maxDistance: 100, threshold: 10 }, ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(ops[0]?.params).toMatchObject({ maxDistance: 0.1, threshold: 0.01, signed: true, histogramBins: 20, device: 'cpu' });
    const data = result.data as { results: Record<string, unknown>[]; reviewRequired: { value: boolean; reason: string } };
    expect(data.results[0]).toMatchObject({ entityId: ids.pipe, modelErrorBound: 0 });
    expect(data.results[0]?.['max']).toBeCloseTo(25, 9);
    expect(data.results[0]?.['fittedAxisOffset']).toBeCloseTo(25, 9);
    expect(data.reviewRequired).toEqual({ value: true, reason: 'tie-in dimensions from a scan — field-verify before fabrication' });
    const tessellated = execute(
      doc,
      'cloud_to_model_deviation',
      { cloudId, entityIds: [ids.sphere], model: 'tessellated', maxDistance: 10, threshold: 1 },
      ctx,
    );
    expect((tessellated.data as { results: Record<string, unknown>[] }).results[0]?.['modelErrorBoundReason']).toBeDefined();
    expectPure(doc, () =>
      execute(doc, 'cloud_to_model_deviation', { cloudId, entityIds: [ids.pipe], maxDistance: 100, threshold: 10 }, ctx),
    );
  });

  it('refuses bad inputs with stable codes', () => {
    const { ctx } = context(deviationAnswer);
    const { doc, cloudId, ids } = scene(ctx);
    const code = (params: Record<string, unknown>): string | undefined =>
      execute(doc, 'cloud_to_model_deviation', { cloudId, maxDistance: 1, threshold: 1, ...params }, ctx).error?.code;
    expect(code({ entityIds: ['nope'] })).toBe('SCN_ENTITY_NOT_FOUND');
    expect(code({ entityIds: [ids.line] })).toBe('SCN_ENTITY_UNSUPPORTED');
    expect(code({ entityIds: [ids.pipe], maxDistance: 0 })).toBe('SCN_PARAM_INVALID');
    expect(code({ entityIds: [ids.pipe], model: 'tessellated', segments: 4 })).toBe('SCN_PARAM_INVALID');
    expect(
      execute(doc, 'cloud_to_model_deviation', { cloudId, entityIds: [ids.pipe], maxDistance: 1, threshold: 1 }, withoutPort()).error?.code,
    ).toBe('SCN_ASSET_UNAVAILABLE');
  });
});

const withoutPort = (): ExecutionContext => ({ ...defaultContext(), pointClouds: null });

describe('check_asbuilt_clash', () => {
  it('reports hard / clearance / clear with the named noise threshold and the review flag (VC-SCN-43 / 52 shape)', () => {
    const { ctx, ops } = context(clashAnswer);
    const { doc, cloudId, ids } = scene(ctx);
    const result = execute(doc, 'check_asbuilt_clash', { cloudId, entityIds: [ids.pipe, ids.cylinder, ids.box], clearance: 75 }, ctx);
    expect(ops[0]?.params).toMatchObject({ clearance: 0.075, minPointsInVolume: 10, searchDistance: 1, exclude: [null, null, null] });
    const data = result.data as {
      results: { status: string; minGap: number }[];
      minPointsInVolume: { value: number; defaulted: boolean };
      reviewRequired: { value: boolean };
      warnings: { code: string }[];
    };
    expect(data.results.map((r) => r.status)).toEqual(['hard', 'clearance', 'clear']);
    expect(data.results[0]?.minGap).toBeCloseTo(-43.7, 9);
    expect(data.minPointsInVolume).toMatchObject({ value: 10, defaulted: true });
    expect(data.reviewRequired.value).toBe(true);
    expect(data.warnings.map((w) => w.code)).toEqual(['SCN_CLASH_FOUND', 'SCN_CLEARANCE_VIOLATION']);
    expect(result.summary).toContain('not proof of absence');
    const named = execute(
      doc,
      'check_asbuilt_clash',
      { cloudId, entityIds: [ids.pipe], clearance: 75, minPointsInVolume: 3, searchDistance: 500 },
      ctx,
    );
    expect((named.data as { minPointsInVolume: { defaulted: boolean } }).minPointsInVolume.defaulted).toBe(false);
    expect(ops[1]?.params).toMatchObject({ minPointsInVolume: 3, searchDistance: 0.5 });
    expect(execute(doc, 'check_asbuilt_clash', { cloudId, entityIds: [ids.pipe], clearance: -1 }, ctx).error?.code).toBe(
      'SCN_PARAM_INVALID',
    );
    expect(
      execute(doc, 'check_asbuilt_clash', { cloudId, entityIds: [ids.pipe], clearance: 1, minPointsInVolume: 0 }, ctx).error?.code,
    ).toBe('SCN_PARAM_INVALID');
    expect(execute(doc, 'check_asbuilt_clash', { cloudId, entityIds: ['x'], clearance: 1 }, ctx).error?.code).toBe('SCN_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'check_asbuilt_clash', { cloudId, entityIds: [ids.pipe], clearance: 75 }, ctx));
  });
});

describe('check_point_clouds', () => {
  const fit = {
    axisPoint: [1, 0, 1],
    axisDirection: [1, 0, 0],
    radius: 0.05715,
    start: [0, 0, 1],
    end: [2, 0, 1],
    length: 2,
    rms: 0.001,
    threshold: { value: 0.003, spacing: 0.004 },
    warnings: [],
  };
  const extractAnswer = (op: CloudOp): CloudOpResult =>
    op.kind === 'extract_pipes' ? opOk({ extractions: [fit], rejected: [] }) : clashAnswer(op);

  it('lists unverified registrations with the derived runs, stale and unreviewed extractions (VC-SCN-51)', () => {
    const { ctx, ops } = context(extractAnswer, [KEY_A, KEY_B]);
    let doc = createEmptyDocument();
    const a = execute(doc, 'attach_point_cloud', { assetKey: KEY_A }, ctx);
    const b = execute(a.document, 'attach_point_cloud', { assetKey: KEY_B }, ctx);
    const cloudId = a.affected[0] ?? '';
    doc = execute(b.document, 'mark_registration_supplied', { cloudId }).document;
    const extracted = execute(doc, 'extract_pipes', { cloudId, region: { kind: 'all' } }, ctx).data as {
      extractions: { extraction: unknown }[];
    };
    const committed = execute(doc, 'commit_asbuilt_extraction', { extraction: extracted.extractions[0]?.extraction }, ctx);
    const [extractionId, pipeId] = committed.affected;
    const check = execute(committed.document, 'check_point_clouds', {}, ctx).data as {
      status: string;
      items: { code: string; ids: string[]; severity: string }[];
    };
    expect(check.status).toBe('warn');
    const unverified = check.items.find((i) => i.code === 'SCN_REGISTRATION_UNVERIFIED');
    expect(unverified?.ids).toEqual(expect.arrayContaining([cloudId, extractionId, pipeId]));
    expect(check.items.map((i) => i.code)).toEqual(
      expect.arrayContaining(['SCN_CLOUD_UNREGISTERED', 'SCN_EXTRACTION_UNVERIFIED', 'SCN_REVIEW_REQUIRED']),
    );
    const moved = execute(committed.document, 'update_point_cloud', {
      cloudId,
      transform: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    }).document;
    const stale = execute(moved, 'check_point_clouds', { cloudIds: [cloudId] }, ctx).data as { items: { code: string }[] };
    expect(stale.items.map((i) => i.code)).toContain('SCN_EXTRACTION_STALE');
    // The as-built run ignores its own surface in a clash on its source cloud.
    execute(committed.document, 'check_asbuilt_clash', { cloudId, entityIds: [pipeId], clearance: 50 }, ctx);
    expect((ops[ops.length - 1]?.params['exclude'] as number[])[0]).toBeCloseTo(0.012, 12);
    const noPort = execute(committed.document, 'check_point_clouds', {}, withoutPort()).data as { items: { code: string }[] };
    expect(noPort.items.map((i) => i.code)).toContain('SCN_ASSET_UNAVAILABLE');
    const missing = execute(committed.document, 'check_point_clouds', {}, { ...defaultContext(), pointClouds: fixturePort([]) }).data as {
      items: { code: string }[];
    };
    expect(missing.items.map((i) => i.code)).toContain('SCN_ASSET_MISSING');
    expect(execute(committed.document, 'check_point_clouds', { cloudIds: ['cloud-0.0'] }).error?.code).toBe('SCN_CLOUD_NOT_FOUND');
    expectPure(committed.document, () => execute(committed.document, 'check_point_clouds', {}, ctx));
  });

  it('passes an empty workspace', () => {
    expect((execute(createEmptyDocument(), 'check_point_clouds', {}).data as { status: string }).status).toBe('pass');
  });
});
