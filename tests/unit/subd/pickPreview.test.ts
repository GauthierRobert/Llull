import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { previewCageCommand } from '@core/commands/subdivision/preview';
import { localRay, nearestCageElements, nearestOnSegment, nearestOnTriangle, pickCage } from '@core/geometry/subd/pick';
import { expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();
function cubeDoc(params: object = {}): { doc: CadDocument; id: string; e: SubdivisionEntity } {
  const result = execute(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 3, ...params });
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: result.document.entities[id] as SubdivisionEntity };
}

describe('closest-point helpers', () => {
  it('projects onto segments and triangles', () => {
    expect(nearestOnSegment([2, 1, 0], [0, 0, 0], [1, 0, 0])).toEqual({ point: [1, 0, 0], distance: Math.SQRT2 });
    expect(nearestOnSegment([0.5, 1, 0], [0, 0, 0], [1, 0, 0]).distance).toBe(1);
    expect(nearestOnSegment([3, 3, 3], [1, 1, 1], [1, 1, 1]).distance).toBeCloseTo(Math.hypot(2, 2, 2), 12);
    const [a, b, c]: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(nearestOnTriangle([0.2, 0.2, 5], a, b, c).map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0.2, 0.2, 0]);
    expect(nearestOnTriangle([-1, -1, 0], a, b, c)).toEqual(a);
    expect(nearestOnTriangle([2, -1, 0], a, b, c)).toEqual(b);
    expect(nearestOnTriangle([-1, 2, 0], a, b, c)).toEqual(c);
    expect(nearestOnTriangle([0.5, -1, 0], a, b, c)).toEqual([0.5, 0, 0]);
    expect(nearestOnTriangle([-1, 0.5, 0], a, b, c)).toEqual([0, 0.5, 0]);
    expect(nearestOnTriangle([1, 1, 0], a, b, c)).toEqual([0.5, 0.5, 0]);
  });
});

describe('picking cage elements for the viewport', () => {
  const { e } = cubeDoc();
  it('finds the nearest vertex, edge and face of a point', () => {
    const near = nearestCageElements(e, [0.9, 0.95, 1.2]);
    expect(near.vertex).toMatchObject({ id: 'v-1.2', index: 2 });
    expect(near.edge?.distance).toBeCloseTo(Math.hypot(0.05, 0.2), 12);
    expect(near.face).toMatchObject({ id: 'f-1.0', index: 0 });
    expect(near.face?.point.map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0.9, 0.95, 1]);
  });
  it('picks the front face along a ray and the vertex / edge within the tolerance', () => {
    const ray = { origin: [0.95, 0.95, 5] as Vec3, direction: [0, 0, -1] as Vec3 };
    const pick = pickCage(e, ray, 0.1);
    expect(pick.face).toMatchObject({ id: 'f-1.0', distance: 4 });
    expect(pick.vertex).toMatchObject({ id: 'v-1.2' });
    expect(pick.edge?.distance).toBeLessThan(0.1);
    const centre = pickCage(e, { origin: [0, 0, 5], direction: [0, 0, -1] }, 0.1);
    expect(centre.face?.id).toBe('f-1.0');
    expect(centre.vertex).toBeNull();
    expect(centre.edge).toBeNull();
    const miss = pickCage(e, { origin: [5, 5, 5], direction: [0, 0, -1] }, 0.1);
    expect(miss).toEqual({ face: null, vertex: null, edge: null });
    const grazing = pickCage(e, { origin: [0, 0, 5], direction: [1, 0, 0] }, 0.1);
    expect(grazing.face).toBeNull();
    const behind = pickCage(e, { origin: [0, 0, 5], direction: [0, 0, 1] }, 0.1);
    expect(behind.face).toBeNull();
    const parallel = pickCage(e, { origin: [0.5, 1, 1], direction: [1, 0, 0] }, 0.01);
    expect(parallel.edge).not.toBeNull();
  });
  it('reports the ray parameter of vertex and edge hits for occlusion tests', () => {
    const pick = pickCage(e, { origin: [0.95, 0.95, 5], direction: [0, 0, -2] }, 0.1);
    expect(pick.vertex?.t).toBeCloseTo(2, 12);
    expect(pick.edge?.t).toBeCloseTo(2, 12);
    expect(pick.face?.distance).toBeCloseTo(2, 12);
    expect(nearestCageElements(e, [0, 0, 2]).vertex?.t).toBeUndefined();
  });
  it('maps a world ray into the entity frame', () => {
    const turned = cubeDoc({ position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] }).e;
    const local = localRay(turned, { origin: [10, 5, 0], direction: [0, -1, 0] });
    expect(local.origin[0]).toBeCloseTo(5, 12);
    expect(local.direction[0]).toBeCloseTo(-1, 12);
    expect(pickCage(turned, local, 0.1).face).not.toBeNull();
  });
});

describe('previewCageCommand', () => {
  const { doc, id } = cubeDoc();
  it('runs the commit command without keeping anything and mints the committed ids', () => {
    const preview = previewCageCommand(doc, 'extrude_cage_faces', { id, faces: [0], distance: 1 });
    expect(preview.ok).toBe(true);
    expect(preview.entity?.vertices).toHaveLength(12);
    expect(preview.displayLevels).toBe(3);
    expect(preview.triangles.length).toBeGreaterThan(0);
    const committed = execute(doc, 'extrude_cage_faces', { id, faces: [0], distance: 1 });
    expect(preview.entity?.elementIds).toEqual((committed.document.entities[id] as SubdivisionEntity).elementIds);
    expect(doc.featureHistory).toHaveLength(1);
  });
  it('returns triangles in world space with the full placement (rotation, then position)', () => {
    const turned = cubeDoc({ position: [10, 0, 0], rotation: [0, 0, Math.PI / 2] });
    const preview = previewCageCommand(turned.doc, 'edit_subdivision_cage', { id: turned.id, translate: [0, 0, 0.1] });
    const xs = preview.triangles.flat().map((p) => p[0]);
    const ys = preview.triangles.flat().map((p) => p[1]);
    expect(Math.min(...xs)).toBeGreaterThan(8.9);
    expect(Math.max(...xs)).toBeLessThan(11.1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2.2);
  });
  it('shows large cages at a reduced level and is pure', () => {
    const big = cubeDoc({ box: { size: [4, 4, 4], segments: [6, 6, 6] }, levels: 4 });
    const preview = previewCageCommand(big.doc, 'edit_subdivision_cage', { id: big.id, vertexIndices: [0], translate: [0, 0, 1] }, 2);
    expect(preview.displayLevels).toBe(2);
    expect(preview.entity?.levels).toBe(4);
    expectPure(big.doc, () => previewCageCommand(big.doc, 'edit_subdivision_cage', { id: big.id, translate: [0, 0, 1] }));
  });
  it('reports refusals and refuses commands that are not cage edits', () => {
    const refused = previewCageCommand(doc, 'extrude_cage_faces', { id, faces: [0], distance: 0 });
    expect(refused).toMatchObject({ ok: false, entity: null, triangles: [] });
    expect(refused.error?.code).toBe('DIR_DISTANCE_ZERO');
    expect(previewCageCommand(doc, 'delete_entities', { ids: [id] }).summary).toContain('not a previewable');
    expect(previewCageCommand(doc, 'edit_subdivision_cage', { translate: [1, 0, 0] }).ok).toBe(false);
  });
});
