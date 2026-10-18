import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity, type InstanceEntity, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { applyEulerXYZ, composeEulerXYZ } from '@lib/eulerRotation';

const ORIGIN: Vec3 = [0, 0, 0];
const BOX_CENTER: Vec3 = [5, 1, -2];
const CHILD_ROTATION: Vec3 = [0.3, 0, 0];
const MID = { rotation: [0, 0.5, 0.7] as Vec3, position: [1, 2, 3] as Vec3 };
const OUTER = { rotation: [0.4, -0.9, 0.2] as Vec3, position: [3, -1, 2] as Vec3 };

/** Box component (offset, rotated) -> instance `MID` -> wrapped as component B -> instance `OUTER`; `innerScale` is MID's scale. */
function nestedDoc(innerScale?: Vec3): { doc: CadDocument; outerId: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 3, 4], position: BOX_CENTER, rotation: CHILD_ROTATION });
  const a = execute(box.document, 'create_component', { name: 'A', entityIds: [box.affected[0]!], componentId: 'comp-a' });
  const mid = execute(a.document, 'insert_instance', {
    componentId: 'comp-a',
    ...MID,
    ...(innerScale !== undefined ? { scale: innerScale } : {}),
  });
  const b = execute(mid.document, 'create_component', { name: 'B', entityIds: [mid.affected[0]!], componentId: 'comp-b' });
  const outer = execute(b.document, 'insert_instance', { componentId: 'comp-b', ...OUTER });
  return { doc: outer.document, outerId: outer.affected[0]! };
}

function mid(points: readonly Vec3[]): Vec3 {
  const axis = (k: 0 | 1 | 2): number => {
    const values = points.map((point) => point[k]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  return [axis(0), axis(1), axis(2)];
}

/** Centre of the (centrally symmetric) box: midpoint of its world-space triangle vertices. */
function triangleCenter(doc: CadDocument, id: string): Vec3 {
  return mid(entityToTriangles(doc.entities[id]!, doc).flat() as Vec3[]);
}

function oracleCenter(): Vec3 {
  const rotateAbout = (v: Vec3, rotation: Vec3, position: Vec3): Vec3 => {
    const r = applyEulerXYZ(v, ORIGIN, rotation);
    return [r[0] + position[0], r[1] + position[1], r[2] + position[2]];
  };
  return rotateAbout(rotateAbout(BOX_CENTER, MID.rotation, MID.position), OUTER.rotation, OUTER.position);
}

function expectClose(actual: Vec3, expected: Vec3): void {
  const scale = Math.max(1, ...expected.map(Math.abs));
  actual.forEach((value, k) => expect(Math.abs(value - expected[k]!) / scale).toBeLessThan(1e-6));
}

describe('instance rotation composes (R_world = R_instance . R_child)', () => {
  it('parametric expansion == baked-mesh path == mass_properties centroid == matrix oracle (nested oblique rotations)', () => {
    const parametric = nestedDoc();
    // A scale a hair off 1 forces the inner level onto the baked-mesh path without moving the centre measurably.
    const baked = nestedDoc([1, 1, 1 + 1e-12]);
    const expected = oracleCenter();
    const a = triangleCenter(parametric.doc, parametric.outerId);
    const b = triangleCenter(baked.doc, baked.outerId);
    const massOf = (doc: CadDocument, id: string): Vec3 => {
      const result = execute(doc, 'mass_properties', { entityId: id });
      expect(result.affected).toEqual([]);
      return (result.data as { centroid: Vec3 }).centroid;
    };
    const c = massOf(parametric.doc, parametric.outerId);
    expectClose(a, expected);
    expectClose(b, expected);
    expectClose(c, expected);
    expectClose(massOf(baked.doc, baked.outerId), expected);
    const bounds = entityBoundsInDoc(parametric.doc, parametric.doc.entities[parametric.outerId] as InstanceEntity);
    expect(bounds.max[0]).toBeGreaterThan(bounds.min[0]);
  });

  it('differs from naive Euler addition for oblique rotations', () => {
    const added: Vec3 = [CHILD_ROTATION[0] + MID.rotation[0], MID.rotation[1], MID.rotation[2]];
    const composed = composeEulerXYZ(MID.rotation, CHILD_ROTATION);
    expect(Math.abs(composed[1] - added[1])).toBeGreaterThan(1e-3);
  });

  it('is pure: expansion leaves the document untouched', () => {
    const { doc, outerId } = nestedDoc();
    const before = JSON.stringify(doc);
    entityToTriangles(doc.entities[outerId] as Entity, doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('composeEulerXYZ round trips', () => {
  const rotate = (v: Vec3, e: Vec3): Vec3 => applyEulerXYZ(v, ORIGIN, e);
  const cases: Array<[string, Vec3, Vec3]> = [
    ['oblique', [0.4, -0.9, 0.2], [0.3, 1.1, -0.7]],
    ['gimbal lock +90 deg Y (inner)', [0.2, 0.1, 0.3], [0.4, Math.PI / 2, 0.5]],
    ['gimbal lock -90 deg Y (result)', [0, -Math.PI / 2, 0], [0.6, 0, 0.9]],
    ['half turns', [Math.PI, 0, 0], [0, Math.PI, 0]],
  ];
  it.each(cases)('%s: composed Euler rotates a vector like the two rotations in sequence', (_name, outer, inner) => {
    const composed = composeEulerXYZ(outer, inner);
    const v: Vec3 = [1, -2, 3];
    expectClose(rotate(v, composed), rotate(rotate(v, inner), outer));
    expect(composed.every(Number.isFinite)).toBe(true);
  });
});
