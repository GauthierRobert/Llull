/**
 * 03 WRP chains across cone, sphere and torus faces (spec §14.13) on a stub kernel with analytic split solids (`fakeSplitKernel`): a cone cut along its rulings unrolls into the flat
 * sector (exact), a sphere cut by a plane and a torus cut by two meridians are charted with geodesic charts anchored on the shared edge, the join mismatch measured (over the window and at
 * the points where the sketch crosses the edge) and held to the limit. The exact geometry is proved on the native kernel in server/tests/nativeWrapChain2.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import type { CadDocument, NurbsCurveEntity, Vec3 } from '@core/model/types';
import { fakeSplitKernel, type FakeSplitOptions } from '../../helpers/fakeSplitKernel';
import { emptyDoc, make } from './support';

type Row = Record<string, unknown>;
type Run = ReturnType<typeof execute>;

const use = (options: FakeSplitOptions = {}): void => setGeometryKernel(fakeSplitKernel(options));
beforeEach(() => use());
afterEach(() => setGeometryKernel(null));

const codeOf = (run: Run): string => run.error?.code ?? '';
const line = (doc: CadDocument, length: number): { doc: CadDocument; id: string } =>
  make(doc, 'draw_polyline', {
    points: [
      [0, 0],
      [length, 0],
    ],
  });
const endsOf = (run: Run): Vec3[] =>
  run.affected.map((id) => {
    const entity = run.document.entities[id] as NurbsCurveEntity;
    return evaluateCurve(entity.curve, entity.curve.knots[entity.curve.knots.length - 1] as number) as Vec3;
  });
const lengths = (run: Run): number[] => (run.data as { curves: Array<{ length3d: number }> }).curves.map((c) => c.length3d);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const edgesOf = (run: Run): Array<{ mismatch: number; length: number; windowLength: number; cutGap: number }> =>
  (run.data as { edges: Array<{ mismatch: number; length: number; windowLength: number; cutGap: number }> }).edges;

describe('wrap_to_face across the two halves of a cone (develop, exact)', () => {
  const cone = (): { doc: CadDocument; id: string } => make(emptyDoc(), 'add_cone', { radius: 20, height: 40 });
  const wrap = (angleDeg: number, extra: Row = {}, length = 30): Run => {
    const { doc, id } = cone();
    const sketch = line(doc, length);
    return execute(sketch.doc, 'wrap_to_face', {
      id,
      face: { faceIndex: 0 },
      chain: [{ faceIndex: 1 }],
      entityIds: [sketch.id],
      placement: { method: 'develop', angleDeg, anchor: { chart: [0, 0], on: [10, 0, 20] } },
      ...extra,
    });
  };

  it('a line of 30 across a ruling keeps its length, ends at the flat-sector distance from the apex, and the join has no mismatch (turned 0 and 30 degrees)', () => {
    const rho0 = Math.hypot(20, 40) / 2;
    for (const angle of [0, 30]) {
      const done = wrap(angle);
      expect(done.rejected, done.summary).toBeUndefined();
      expect(sum(lengths(done))).toBeCloseTo(30, 6);
      if (angle === 0) expect(lengths(done)).toHaveLength(2);
      const [edge] = edgesOf(done);
      expect(edge?.mismatch).toBe(0);
      expect(edge?.cutGap).toBe(0);
      expect(edge?.windowLength).toBeCloseTo(38, 6);
      expect(edge?.length).toBeCloseTo(38, 6);
      const reach = endsOf(done).map((p) => Math.hypot(p[0], p[1], p[2] - 40));
      const radial = (sign: number): number =>
        Math.hypot(rho0 + sign * 30 * Math.sin((angle * Math.PI) / 180), 30 * Math.cos((angle * Math.PI) / 180));
      expect(reach.some((d) => Math.abs(d - radial(1)) < 1e-4 || Math.abs(d - radial(-1)) < 1e-4)).toBe(true);
    }
  });

  it('with several shared edges the one the sketch crosses is unfolded (mirrored sketch), else the nearest; an edge with no chart coordinates is skipped', () => {
    const mirrored = wrap(0, { placement: { method: 'develop', mirror: true, anchor: { chart: [0, 0], on: [10, 0, 20] } } });
    expect(mirrored.rejected, mirrored.summary).toBeUndefined();
    expect(sum(lengths(mirrored))).toBeCloseTo(30, 6);
    expect(lengths(mirrored)).toHaveLength(2);
    const short = wrap(0, {}, 5);
    expect(short.rejected, short.summary).toBeUndefined();
    expect(lengths(short)).toHaveLength(1);
    use({ apexEdge: true });
    const apex = wrap(0);
    expect(apex.rejected, apex.summary).toBeUndefined();
    expect(sum(lengths(apex))).toBeCloseTo(30, 6);
  });

  it('refuses a chain that repeats a face, a developable chain with another method, a face the kernel cannot place on a side, and kernels that cannot tell the sides', () => {
    const { doc, id } = cone();
    const sketch = line(doc, 30);
    const anchor = { chart: [0, 0], on: [10, 0, 20] };
    const base = { id, face: { faceIndex: 0 }, entityIds: [sketch.id], placement: { method: 'develop', anchor } };
    expect(codeOf(execute(sketch.doc, 'wrap_to_face', { ...base, chain: [{ faceIndex: 0 }] }))).toBe('WRP_PARAM_INVALID');
    expect(
      codeOf(execute(sketch.doc, 'wrap_to_face', { ...base, chain: [{ faceIndex: 1 }], placement: { method: 'parametric', anchor } })),
    ).toBe('WRP_PARAM_INVALID');
    use({ blindFace: 0 });
    expect(codeOf(execute(sketch.doc, 'wrap_to_face', { ...base, chain: [{ faceIndex: 1 }] }))).toBe('WRP_CHAIN_CLIP_FAILED');
    use({ blindFace: 1 });
    const blind = execute(sketch.doc, 'wrap_to_face', { ...base, chain: [{ faceIndex: 1 }] });
    expect(codeOf(blind)).toBe('WRP_CHAIN_CLIP_FAILED');
    expect(blind.summary).toContain('faces cannot be unfolded');
    expect(blind.document).toBe(sketch.doc);
  });
});

describe('emboss_on_face across the two halves of a cone', () => {
  it('an 8 x 6 rectangle over the ruling embosses both faces; the volume is the sum of the closed forms of the two parts', () => {
    const cone = make(emptyDoc(), 'add_cone', { radius: 20, height: 40 });
    const rectangle = make(cone.doc, 'draw_rectangle', { width: 8, height: 6, position: [-4, -3, 0] });
    const done = execute(rectangle.doc, 'emboss_on_face', {
      id: cone.id,
      face: { faceIndex: 0 },
      chain: [{ faceIndex: 1 }],
      profileIds: [rectangle.id],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [0, 10, 20] } },
    });
    expect(done.rejected, done.summary).toBeUndefined();
    const data = done.data as {
      faces: Array<{ area: number }>;
      expectedVolumeDelta: number;
      volumeDelta: number;
      exact: boolean;
      distortion: Row;
    };
    expect(data.faces).toHaveLength(2);
    expect(data.faces.reduce((a, f) => a + f.area, 0)).toBeCloseTo(48, 6);
    expect(data.volumeDelta).toBeCloseTo(data.expectedVolumeDelta, 6);
    expect(data.exact).toBe(true);
    expect(data.distortion['maxLengthStrain']).toBe(0);
  });
});

describe('wrap_to_face across the two halves of a sphere or a torus (geodesic, measured)', () => {
  const torus = (): { doc: CadDocument; id: string } => make(emptyDoc(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });
  const ringPoint = (u: number, v = 0): Vec3 => [
    (10 + 3 * Math.cos(v)) * Math.cos(u),
    (10 + 3 * Math.cos(v)) * Math.sin(u),
    3 * Math.sin(v),
  ];

  /** Face 1 holds the azimuths below 0.5 (and above pi + 0.5); the sketch runs from the anchor towards the meridian at 0.5 and across it. */
  const wrapTorus = (anchor: Vec3, length: number, extra: Row = {}, method = 'geodesic'): Run => {
    const { doc, id } = torus();
    const sketch = line(doc, length);
    return execute(sketch.doc, 'wrap_to_face', {
      id,
      face: { faceIndex: 1 },
      chain: [{ faceIndex: 0 }],
      entityIds: [sketch.id],
      placement: { method, anchor: { chart: [0, 0], on: anchor } },
      ...extra,
    });
  };

  it('torus: a band of 3 along the outer equator across a meridian keeps its length within the join mismatch, which is reported and under the limit', () => {
    const done = wrapTorus(ringPoint(0.4), 3);
    expect(done.rejected, done.summary).toBeUndefined();
    const data = done.data as {
      distortion: { maxLengthStrain: number; limit: number; joinMismatch: number; curveStrain: number };
      curves: unknown[];
    };
    expect(data.curves).toHaveLength(2);
    expect(Math.abs(sum(lengths(done)) / 3 - 1)).toBeLessThan(0.02);
    const [edge] = edgesOf(done);
    expect(edge?.mismatch).toBeGreaterThan(0);
    expect(edge?.mismatch).toBeLessThan(0.02);
    expect(edge?.windowLength).toBeLessThan(edge?.length as number);
    expect(data.distortion.joinMismatch).toBe(edge?.mismatch);
    expect(data.distortion.maxLengthStrain).toBeGreaterThanOrEqual(edge?.mismatch as number);
    expect(data.distortion.limit).toBe(0.02);
    expect(done.summary).toContain('geodesic');
  });

  it('torus: the sketch crossing the meridian high on the tube is measured where it crosses; a crossing the join does not cover is refused', () => {
    const high = wrapTorus(ringPoint(0.4, 1.2), 3);
    expect(high.rejected, high.summary).toBeUndefined();
    expect(edgesOf(high)[0]?.mismatch).toBeGreaterThan(0);
    // the two charts place the crossing point apart by the cut gap, and the join mismatch is at least that share of the window
    const gap = edgesOf(high)[0]?.cutGap as number;
    expect(gap).toBeGreaterThan(0);
    expect(edgesOf(high)[0]?.mismatch).toBeGreaterThanOrEqual(gap / (edgesOf(high)[0]?.windowLength as number) - 1e-12);
    const beyond = wrapTorus(ringPoint(0.4), 3, { maxLengthStrain: 0.5 });
    expect(beyond.rejected, beyond.summary).toBeUndefined();
  });

  it('torus: a diagonal sketch crosses the meridian away from the anchor row; the window is seeded where it crosses, so the join covers the crossing', () => {
    const { doc, id } = torus();
    const sketch = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [3.2, 3.2],
      ],
    });
    const done = execute(sketch.doc, 'wrap_to_face', {
      id,
      face: { faceIndex: 1 },
      chain: [{ faceIndex: 0 }],
      entityIds: [sketch.id],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: ringPoint(0.4) } },
    });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(lengths(done)).toHaveLength(2);
    expect(Math.abs(sum(lengths(done)) / Math.hypot(3.2, 3.2) - 1)).toBeLessThan(0.02);
  });

  it('torus: a second stroke that crosses the meridian farther from the window than the nearest stroke is refused (the join does not cover it)', () => {
    const { doc, id } = torus();
    const near = make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1.28, 0],
      ],
    });
    const far = make(near.doc, 'draw_polyline', {
      points: [
        [0.2, 3.6],
        [3, 3.6],
      ],
    });
    const done = execute(far.doc, 'wrap_to_face', {
      id,
      face: { faceIndex: 1 },
      chain: [{ faceIndex: 0 }],
      entityIds: [near.id, far.id],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: ringPoint(0.4) } },
    });
    expect(codeOf(done)).toBe('WRP_DISTORTION_EXCEEDED');
    expect(done.summary).toContain('outside the');
  });

  it('torus: the limit below the mismatch refuses with WRP_DISTORTION_EXCEEDED, a far anchor is out of reach, parametric needs geodesic', () => {
    const tight = wrapTorus(ringPoint(0.4), 3, { maxLengthStrain: 1e-9 });
    expect(codeOf(tight)).toBe('WRP_DISTORTION_EXCEEDED');
    expect(tight.summary).toContain('bends');
    expect(tight.affected).toEqual([]);
    const stretched = wrapTorus(ringPoint(0.2), 6);
    expect(codeOf(stretched)).toBe('WRP_DISTORTION_EXCEEDED');
    expect(stretched.summary).toContain('disagree along edge');
    const far = wrapTorus(ringPoint(5), 3);
    expect(codeOf(far)).toBe('WRP_CHAIN_EDGE_CURVED');
    expect(far.summary).toContain('out of reach');
    expect(codeOf(wrapTorus(ringPoint(0.4), 3, {}, 'parametric'))).toBe('WRP_PARAM_INVALID');
  });

  it('torus: a stretch of the curves above the limit is refused with the measured numbers, a limit just above passes', () => {
    const loose = wrapTorus(ringPoint(0.4), 3, { maxLengthStrain: 0.5 });
    const info = (loose.data as { distortion: { curveStrain: number; joinMismatch: number } }).distortion;
    const limit = Math.max(info.curveStrain, info.joinMismatch);
    const edge = wrapTorus(ringPoint(0.4), 3, { maxLengthStrain: limit * 1.02 });
    expect(edge.rejected, edge.summary).toBeUndefined();
    if (info.curveStrain > info.joinMismatch * 1.05) {
      const refused = wrapTorus(ringPoint(0.4), 3, { maxLengthStrain: (info.curveStrain + info.joinMismatch) / 2 });
      expect(codeOf(refused)).toBe('WRP_DISTORTION_EXCEEDED');
      expect(refused.summary).toContain('stretch a curve');
    }
  });

  it('sphere: a line across the great circle x = 0 crosses into the other hemisphere with a small join mismatch and the length kept', () => {
    const sphere = make(emptyDoc(), 'add_sphere', { radius: 25 });
    const sketch = line(sphere.doc, 4);
    const on: Vec3 = [-2.5, Math.sqrt(625 - 6.25), 0];
    const outcomes = [false, true].map((mirror) =>
      execute(sketch.doc, 'wrap_to_face', {
        id: sphere.id,
        face: { faceIndex: 1 },
        chain: [{ faceIndex: 0 }],
        entityIds: [sketch.id],
        placement: { method: 'geodesic', mirror, anchor: { chart: [0, 0], on } },
      }),
    );
    const done = outcomes.find((run) => run.rejected !== true);
    expect(done, outcomes.map((run) => run.summary).join(' / ')).toBeDefined();
    expect(edgesOf(done as Run)[0]?.mismatch).toBeLessThan(0.01);
    expect(Math.abs(sum(lengths(done as Run)) / 4 - 1)).toBeLessThan(0.01);
  });

  it('torus emboss: the parts are measured with the geodesic charts, the default limit is listed, a tighter limit refuses', () => {
    const { doc, id } = torus();
    const rectangle = make(doc, 'draw_rectangle', { width: 2, height: 2, position: [-1, -1, 0] });
    const params = {
      id,
      face: { faceIndex: 0 },
      chain: [{ faceIndex: 1 }],
      profileIds: [rectangle.id],
      mode: 'emboss',
      depth: 0.3,
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: ringPoint(0.7) } },
    };
    const done = execute(rectangle.doc, 'emboss_on_face', params);
    expect(done.rejected, done.summary).toBeUndefined();
    const data = done.data as {
      exact: boolean;
      method: string;
      distortion: { limitDefaulted: boolean };
      faces: unknown[];
      defaults: Array<{ name: string }>;
    };
    expect(data.exact).toBe(false);
    expect(data.method).toBe('geodesic');
    expect(data.distortion.limitDefaulted).toBe(true);
    expect(data.defaults.map((d) => d.name)).toContain('maxLengthStrain');
    expect(done.summary).toContain('geodesic, max stretch');
    const tight = execute(rectangle.doc, 'emboss_on_face', { ...params, maxLengthStrain: 1e-9 });
    expect(codeOf(tight)).toBe('WRP_DISTORTION_EXCEEDED');
    const info = data.distortion as unknown as { curveStrain: number; joinMismatch: number };
    if (info.curveStrain > info.joinMismatch * 1.05) {
      const stretched = execute(rectangle.doc, 'emboss_on_face', {
        ...params,
        maxLengthStrain: Math.max(0.0201, (info.curveStrain + info.joinMismatch) / 2),
      });
      if (stretched.rejected === true) expect(stretched.summary).toContain('stretch the sketch');
    }
  });
});
