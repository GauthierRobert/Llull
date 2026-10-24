import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type NurbsCurveEntity, type NurbsSurfaceEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { evaluateCurve, curveDomain } from '@lib/nurbs/evaluate';
import { evaluateSurface, surfaceDomain } from '@lib/nurbs/surface';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type RunData, WORLD_Z, addBox, dataOf, installKernel, meshEntity } from './harness';

afterEach(() => setGeometryKernel(null));

const BEND = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] } as const;
const LENGTH = (50 * Math.PI) / 2;

function line(doc: CadDocument = createEmptyDocument()): { doc: CadDocument; id: string } {
  const made = execute(doc, 'interpolate_curve', {
    points: [
      [0, 0, 0],
      [0, 0, LENGTH / 3],
      [0, 0, (2 * LENGTH) / 3],
      [0, 0, LENGTH],
    ],
    degree: 3,
  });
  return { doc: made.document, id: made.affected[0] as string };
}

function plate(doc: CadDocument = createEmptyDocument()): { doc: CadDocument; id: string } {
  const poles = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => [(j - 1.5) * 4, 0, (i * LENGTH) / 3]));
  const made = execute(doc, 'create_nurbs_surface', { degreeU: 3, degreeV: 3, poles });
  return { doc: made.document, id: made.affected[0] as string };
}

const curveOf = (doc: CadDocument, id: string): NurbsCurveEntity => doc.entities[id] as NurbsCurveEntity;
const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceEntity => doc.entities[id] as NurbsSurfaceEntity;

describe('curves and sheets (01 DEF M3, FR-DEF-17)', () => {
  it('bend_body refits a straight curve to the quarter circle it should become (VC-DEF-24)', async () => {
    await installKernel('none');
    const { doc, id } = line();
    const result = execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90, frame: BEND, output: { tolerance: 0.001 } });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toEqual([id]);
    expect(result.document.order).toEqual(doc.order);
    const bent = curveOf(result.document, id);
    const [first, last] = curveDomain(bent.curve);
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      const p = evaluateCurve(bent.curve, first + ((last - first) * i) / 40);
      worst = Math.max(worst, Math.abs(Math.hypot(p[1] - 50, p[2]) - 50));
    }
    expect(worst).toBeLessThan(0.001);
    expect(dataOf<RunData & { method: string }>(result).method).toBe('refit');
    expect(result.summary).toContain('fit error');
    expectPure(doc, () => execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90, frame: BEND, output: { tolerance: 0.001 } }));
  });

  it('an affine map moves the poles exactly, and keepSource adds a copy', async () => {
    await installKernel('none');
    const { doc, id } = line();
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 2], center: [0, 0, 0], keepSource: true });
    expect(scaled.error, scaled.summary).toBeUndefined();
    const copy = scaled.affected[0] as string;
    expect(copy).not.toBe(id);
    expect(scaled.document.order).toEqual([...doc.order, copy]);
    expect(curveOf(scaled.document, id)).toBe(curveOf(doc, id));
    expect(curveOf(scaled.document, copy).curve.poles.map((pole) => pole[2])).toEqual(
      curveOf(doc, id).curve.poles.map((pole) => (pole[2] as number) * 2),
    );
    expect(dataOf<{ method: string }>(scaled).method).toBe('exact (poles mapped)');
    expect(execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 2], output: { mode: 'exact' } }).error).toBeUndefined();
    expect(execute(doc, 'twist_body', { id, angleDeg: 40, output: { mode: 'exact' } }).error?.code).toBe('DEF_EXACT_UNAVAILABLE');
  });

  it('twists a sheet by refitting it and keeps its extent along the axis', async () => {
    await installKernel('none');
    const { doc, id } = plate();
    const result = execute(doc, 'twist_body', {
      id,
      angleDeg: 60,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
      region: { start: 0, end: LENGTH, falloff: 'linear' },
      output: { tolerance: 0.01 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const twisted = surfaceOf(result.document, id).surface;
    const [[u0, u1], [v0, v1]] = surfaceDomain(twisted);
    const corner = evaluateSurface(twisted, u1, v1);
    expect(corner[2]).toBeCloseTo(LENGTH, 1);
    expect(Math.hypot(corner[0], corner[1])).toBeCloseTo(6, 1);
    expect(evaluateSurface(twisted, u0, v0)[0]).toBeCloseTo(-6, 1);
    expect(Math.abs(Math.atan2(corner[1], corner[0]) - Math.atan2(0, 6) - Math.PI / 3)).toBeLessThan(0.05);
  });

  it('refuses a trimmed sheet under a non-affine map and a fit it cannot make', async () => {
    await installKernel('none');
    const { doc, id } = plate();
    const trimmed: CadDocument = {
      ...doc,
      entities: {
        ...doc.entities,
        [id]: {
          ...surfaceOf(doc, id),
          trims: [
            {
              outer: true,
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            },
          ],
        } as NurbsSurfaceEntity,
      },
    };
    const refused = execute(trimmed, 'bend_body', { id, radius: 50, angleDeg: 40, frame: BEND });
    expectNoOp(refused, trimmed, 'trimmed');
    expect(refused.error?.code).toBe('DEF_TARGET_UNSUPPORTED');
    expect(execute(trimmed, 'scale_nonuniform', { id, factors: [1, 1, 2] }).error).toBeUndefined();
    const curve = line();
    const offAxis = execute(createEmptyDocument(), 'interpolate_curve', {
      points: [
        [3, 0, 0],
        [3, 0, LENGTH / 3],
        [3, 0, (2 * LENGTH) / 3],
        [3, 0, LENGTH],
      ],
      degree: 3,
    });
    const impossible = execute(offAxis.document, 'twist_body', {
      id: offAxis.affected[0],
      angleDeg: 36000,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
      region: { start: 0, end: LENGTH },
      output: { tolerance: 1e-9 },
    });
    expect(impossible.error?.code).toBe('DEF_APPROX_TOLERANCE');
    expect(
      execute(curve.doc, 'deform_by_point', {
        id: curve.id,
        point: [0, 0, 1],
        direction: [1, 0, 0],
        distance: 1,
        radius: 5,
        output: { preserveAnalytic: true },
      }).error?.code,
    ).toBe('DEF_EXACT_UNAVAILABLE');
  });
});

describe('several bodies and keepSource (VC-DEF-31)', () => {
  it('ids deform each body with its own defaults in one feature step; one bad body leaves everything unchanged', async () => {
    await installKernel('manifold');
    const first = addBox([10, 10, 100]);
    const second = execute(first.doc, 'add_box', { size: [8, 8, 60], anchor: 'base-center', position: [50, 0, 0] });
    const ids = [first.id, second.affected[0] as string];
    const result = execute(second.document, 'twist_body', { ids, angleDeg: 45, frame: WORLD_Z, output: { tolerance: 0.05 } });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toHaveLength(2);
    expect(result.document.order).toHaveLength(2);
    for (const id of result.affected) expect(meshEntity(result.document, id).brep).toMatchObject({ op: 'deform', law: { kind: 'twist' } });
    expect((result.data as { bodies: unknown[] }).bodies).toHaveLength(2);
    expect(result.summary).toContain('2 bodies');
    const bad = execute(second.document, 'twist_body', { ids: [first.id, 'ghost'], angleDeg: 45 });
    expectNoOp(bad, second.document, 'ghost');
    expect(bad.error?.code).toBe('DEF_ENTITY_NOT_FOUND');
    const none = execute(second.document, 'twist_body', { angleDeg: 45 });
    expectNoOp(none, second.document, 'id or ids');
    const duplicate = execute(second.document, 'twist_body', { id: first.id, ids: [first.id], angleDeg: 45, output: { tolerance: 0.05 } });
    expect(duplicate.affected).toHaveLength(1);
  });

  it('keepSource leaves the original next to the result on the mesh and on the kernel paths', async () => {
    for (const kind of ['none', 'warp'] as const) {
      await installKernel(kind);
      const { doc, id } = addBox();
      const kept = execute(doc, 'taper_body', { id, scaleEnd: 0.5, keepSource: true, output: { tolerance: 0.05 } });
      expect(kept.error, kept.summary).toBeUndefined();
      const copy = kept.affected[0] as string;
      expect(kept.document.entities[id]).toBe(doc.entities[id]);
      expect(kept.document.order).toEqual([id, copy]);
    }
  });
});

describe('rotated entities, rational curves and impossible fits', () => {
  it('deforms a rotated, placed curve in world coordinates, a conic exactly under an affine map, and refuses a fit it cannot reach on a sheet', async () => {
    await installKernel('none');
    const { doc, id } = line();
    const placed: CadDocument = {
      ...doc,
      entities: {
        ...doc.entities,
        [id]: { ...(doc.entities[id] as NurbsCurveEntity), position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] } as NurbsCurveEntity,
      },
    };
    const scaled = execute(placed, 'scale_nonuniform', { id, factors: [2, 2, 2], center: [0, 0, 0] });
    expect(scaled.error, scaled.summary).toBeUndefined();
    const moved = curveOf(scaled.document, id);
    expect(moved.position).toEqual([0, 0, 0]);
    expect(moved.curve.poles[0]?.[0]).toBeCloseTo(20, 9);
    const conic = execute(createEmptyDocument(), 'create_conic', {
      start: [1, 0, 0],
      apex: [1, 1, 0],
      end: [0, 1, 0],
      rho: Math.SQRT2 - 1,
    });
    const stretched = execute(conic.document, 'scale_nonuniform', { id: conic.affected[0], factors: [1, 3, 1], center: [0, 0, 0] });
    const weights = curveOf(stretched.document, conic.affected[0] as string).curve.weights;
    expect(weights).toEqual(curveOf(conic.document, conic.affected[0] as string).curve.weights);
    const sheet = plate();
    const impossible = execute(sheet.doc, 'twist_body', {
      id: sheet.id,
      angleDeg: 90000,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
      region: { start: 0, end: LENGTH },
      output: { tolerance: 1e-9 },
    });
    expect(impossible.error?.code).toBe('DEF_APPROX_TOLERANCE');
    const ghost = execute(sheet.doc, 'bend_body', { id: sheet.id, radius: 50, angleDeg: 30, frame: BEND, output: { tolerance: -1 } });
    expect(ghost.error?.code).toBe('DEF_TOLERANCE_INVALID');
    const degenerate = execute(sheet.doc, 'bend_body', {
      id: sheet.id,
      radius: 50,
      angleDeg: 30,
      frame: { origin: [0, 0, 0], axis: [0, 0, 0], reference: [0, 1, 0] },
    });
    expect(degenerate.error?.code).toBe('DEF_FRAME_DEGENERATE');
    const exactAffine = execute(sheet.doc, 'scale_nonuniform', { id: sheet.id, factors: [1, 1, 1] });
    expect(exactAffine.error?.code).toBe('DEF_NO_EFFECT');
  });

  it('flow_along_curve refuses a curve of zero length', async () => {
    await installKernel('none');
    const bar = addBox([10, 10, 20]);
    const point = execute(bar.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [100, 0, 0],
        [100, 0, 0],
      ],
    });
    if (point.error !== undefined) return;
    const result = execute(point.document, 'flow_along_curve', { id: bar.id, targetId: point.affected[0] });
    expect(result.error?.code).toBe('DEF_CURVE_INVALID');
  });
});
