import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type Entity, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { Triangle } from '@core/geometry/triangles';
import { draftAngle, canEditFaces, faceCommand, formatFaceValue, type FacePick } from '@ui/viewport/3d/faceEdit/faceEditModel';
import { faceKeyAction } from '@ui/viewport/3d/faceEdit/faceEditKeys';
import { grabsHandle, rayToSegmentDistance, snapFaceValue, travelAlongAxis } from '@ui/viewport/3d/faceEdit/faceDragMath';
import {
  diagonalOf,
  heightAbove,
  parallelPlaneOffsets,
  planarRegion,
  raycastTriangles,
  triangleAdjacency,
} from '@ui/viewport/3d/faceEdit/faceMesh';
import { dragValue, faceLabels, pickFaceAt, snapPlanes } from '@ui/viewport/3d/faceEdit/facePicking';

const built = execute(createEmptyDocument(), 'add_box', { size: [4, 2, 2] });
const box = built.document.entities[built.affected[0] as string] as Entity;
const triangles = entityToTriangles(box, { components: {} });
const source = { triangles, adjacency: triangleAdjacency(triangles), size: diagonalOf(triangles) };
const down = (origin: Vec3): { origin: Vec3; direction: Vec3 } => ({ origin, direction: [0, 0, -1] });
const top = box.position[2] + 1;

describe('face picking on display triangles', () => {
  it('hits the top face of a box and finds its two coplanar triangles', () => {
    const ray = down([box.position[0] + 0.5, box.position[1] + 0.2, 20]);
    const hit = raycastTriangles(triangles, ray);
    expect(hit?.point[2]).toBeCloseTo(top, 6);
    const picked = pickFaceAt(source, ray);
    expect(picked?.pick.normal).toEqual([0, 0, 1]);
    expect(picked?.region).toHaveLength(2);
    expect(picked?.pick.lever).toBeCloseTo(2, 6);
  });

  it('turns the normal toward the viewer, so a side face looked at from outside points outward', () => {
    const picked = pickFaceAt(source, { origin: [box.position[0] + 20, box.position[1], box.position[2]], direction: [-1, 0, 0] });
    expect(picked?.pick.normal[0]).toBeCloseTo(1, 9);
  });

  it('misses outside the solid', () => {
    expect(pickFaceAt(source, down([500, 500, 10]))).toBeNull();
  });

  it('the coplanar region of a face never leaks over an edge', () => {
    const hit = raycastTriangles(triangles, down([box.position[0], box.position[1], 20]));
    expect(planarRegion(triangles, source.adjacency, hit?.index ?? 0)).toHaveLength(2);
  });

  it('lists the parallel planes of the solid as snap offsets relative to the picked face', () => {
    const picked = pickFaceAt(source, down([box.position[0], box.position[1], 20]));
    expect(parallelPlaneOffsets(triangles, [0, 0, 1])).toHaveLength(2);
    const planes = snapPlanes(source, picked?.pick as FacePick);
    expect(planes).toHaveLength(1);
    expect(planes[0]).toBeCloseTo(-2, 6);
  });

  it('measures the height above the lowest point and the box diagonal', () => {
    expect(heightAbove(triangles, [0, 0, 1], [0, 0, top])).toBeCloseTo(2, 6);
    expect(diagonalOf(triangles)).toBeCloseTo(Math.hypot(4, 2, 2), 6);
    expect(diagonalOf([])).toBe(0);
  });
});

describe('face drag math', () => {
  it('measures the pointer travel along the normal and gives up on a parallel ray', () => {
    const travel = travelAlongAxis(
      [0, 0, 1],
      [0, 0, 1],
      { origin: [5, 0, 1], direction: [-1, 0, 0] },
      { origin: [5, 0, 3], direction: [-1, 0, 0] },
    );
    expect(travel).toBeCloseTo(2, 9);
    const along = down([0, 0, 10]);
    expect(travelAlongAxis([0, 0, 0], [0, 0, 1], along, along)).toBeNull();
  });

  it('grabs the handle within the tolerance only', () => {
    const origin: Vec3 = [0, 0, 0];
    const ray = { origin: [0.3, -5, 0.5] as Vec3, direction: [0, 1, 0] as Vec3 };
    expect(rayToSegmentDistance(ray, origin, [0, 0, 1])).toBeCloseTo(0.3, 9);
    expect(grabsHandle(ray, origin, [0, 0, 1], 1, 0.5)).toBe(true);
    expect(grabsHandle(ray, origin, [0, 0, 1], 1, 0.1)).toBe(false);
  });

  it('snaps to the step, and to a nearby plane first', () => {
    expect(snapFaceValue(1.23, 0.5, [], 0)).toBe(1);
    expect(snapFaceValue(1.9, 0.5, [2.2], 0.4)).toBe(2.2);
    expect(snapFaceValue(1.9, 0.5, [2.2], 0.1)).toBe(2);
    expect(snapFaceValue(1.23, 0, [], 0)).toBe(1.23);
  });

  it('turns the travel into a value per operation', () => {
    const pick: FacePick = { point: [0, 0, 1], normal: [1, 0, 0], lever: 2 };
    const rules = { op: 'push_pull', pick, step: 0.5, planes: [], planeTolerance: 0 } as const;
    expect(dragValue(rules, 1.3)).toBe(1.5);
    expect(dragValue({ ...rules, op: 'flush', planes: [1.4], planeTolerance: 0.2 }, 1.3)).toBe(1.4);
    expect(dragValue({ ...rules, op: 'draft' }, -2 * Math.tan((10 * Math.PI) / 180))).toBe(10);
  });
});

describe('face commands', () => {
  const pick: FacePick = { point: [1, 0.5, 2], normal: [0, 0, 1], lever: 2 };

  it('builds push_pull_face with a point on the face', () => {
    expect(faceCommand('push_pull', 'b1', pick, 1.5)).toEqual({
      name: 'push_pull_face',
      params: { id: 'b1', faceNear: [1, 0.5, 2], distance: 1.5 },
    });
  });

  it('builds replace_face with the target plane at the dragged distance', () => {
    expect(faceCommand('flush', 'b1', pick, -1)?.params).toEqual({
      id: 'b1',
      faceNear: [1, 0.5, 2],
      target: { origin: [1, 0.5, 1], normal: [0, 0, 1] },
    });
  });

  it('builds draft_faces and move_faces', () => {
    expect(faceCommand('draft', 'b1', pick, 5)).toEqual({ name: 'draft_faces', params: { id: 'b1', facesNear: [[1, 0.5, 2]], angle: 5 } });
    expect(faceCommand('offset', 'b1', pick, 2)).toEqual({
      name: 'move_faces',
      params: { id: 'b1', facesNear: [[1, 0.5, 2]], mode: 'offset', distance: 2 },
    });
  });

  it('commits nothing for a drag that moved nothing', () => {
    expect(faceCommand('push_pull', 'b1', pick, 0)).toBeNull();
    expect(faceCommand('draft', 'b1', pick, 0.0004)).toBeNull();
  });

  it('a face pushed in is a positive draft (narrower along +Z); the lever bounds the angle', () => {
    expect(draftAngle(-1, 1)).toBeCloseTo(45, 9);
    expect(draftAngle(1, 1)).toBeCloseTo(-45, 9);
    expect(draftAngle(5, 0)).toBe(0);
    expect(draftAngle(-100, 1)).toBe(45);
  });

  it('offers handles on exact solids only', () => {
    expect(canEditFaces(box)).toBe(true);
    expect(canEditFaces(undefined)).toBe(false);
    expect(canEditFaces({ ...box, kind: 'subdivision' } as unknown as Entity)).toBe(false);
  });

  it('formats the readout', () => {
    expect(formatFaceValue('push_pull', 2.5)).toBe('+2.5');
    expect(formatFaceValue('push_pull', -0.25)).toBe('-0.25');
    expect(formatFaceValue('draft', 5)).toBe('5.0°');
  });
});

describe('face keys', () => {
  it('escape peels one level at a time', () => {
    expect(faceKeyAction('Escape', { dragging: true, hasPick: true })).toEqual({ kind: 'cancel_drag' });
    expect(faceKeyAction('Escape', { dragging: false, hasPick: true })).toEqual({ kind: 'clear_pick' });
    expect(faceKeyAction('Escape', { dragging: false, hasPick: false })).toEqual({ kind: 'exit' });
  });

  it('digits choose the operation unless a drag runs', () => {
    expect(faceKeyAction('3', { dragging: false, hasPick: false })).toEqual({ kind: 'op', op: 'draft' });
    expect(faceKeyAction('3', { dragging: true, hasPick: true })).toBeNull();
    expect(faceKeyAction('q', { dragging: false, hasPick: false })).toBeNull();
  });
});

/** z component of the unit normal of a triangle: 0 on a vertical wall. */
function cross(triangle: Triangle): number {
  const [a, b, c] = triangle;
  const n = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const length = Math.hypot(
    ...[0, 1, 2].map(
      (k) =>
        ((b[(k + 1) % 3] as number) - (a[(k + 1) % 3] as number)) * ((c[(k + 2) % 3] as number) - (a[(k + 2) % 3] as number)) -
        ((b[(k + 2) % 3] as number) - (a[(k + 2) % 3] as number)) * ((c[(k + 1) % 3] as number) - (a[(k + 1) % 3] as number)),
    ),
  );
  return length === 0 ? 0 : n / length;
}

describe('curved faces and feature moves', () => {
  const made = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
  const cylinder = made.document.entities[made.affected[0] as string] as Entity;
  const round = entityToTriangles(cylinder, { components: {} });
  const roundSource = { triangles: round, adjacency: triangleAdjacency(round), size: diagonalOf(round) };

  it('a pick on the wall of a cylinder highlights the whole wall (a smooth patch), not the one facet nor the caps', () => {
    const origin: Vec3 = [cylinder.position[0] + 30, cylinder.position[1], cylinder.position[2]];
    const picked = pickFaceAt(roundSource, { origin, direction: [-1, 0, 0] });
    expect(picked).not.toBeNull();
    const region = picked?.region ?? [];
    expect(region.length).toBeGreaterThan(8);
    // every triangle of the patch is on the wall: no z-normal (cap) triangle
    expect(region.every((index) => Math.abs(cross(round[index] as Triangle)) < 1e-6)).toBe(true);
    expect(region.length).toBeLessThan(round.length);
  });

  it('a feature move is ONE move_faces translate naming the picked face and every Shift-clicked face; it waits for a drag vector', () => {
    const pick: FacePick = { point: [1, 2, 3], normal: [1, 0, 0], lever: 0 };
    expect(faceCommand('move_feature', 'e1', pick, 4, { also: [[1, 2, 0]], vector: null })).toBeNull();
    expect(faceCommand('move_feature', 'e1', pick, 4)).toBeNull();
    expect(faceCommand('move_feature', 'e1', pick, 0, { also: [], vector: [0, 0, 0] })).toBeNull();
    expect(faceCommand('move_feature', 'e1', pick, 4, { also: [[1, 2, 0]], vector: [4, 0, 0] })).toEqual({
      name: 'move_faces',
      params: {
        id: 'e1',
        facesNear: [
          [1, 2, 3],
          [1, 2, 0],
        ],
        mode: 'translate',
        vector: [4, 0, 0],
      },
    });
    expect(faceKeyAction('5', { dragging: false, hasPick: false })).toEqual({ kind: 'op', op: 'move_feature' });
  });
});

/** A strip of quads (2 triangles each) along y in [0, 1] through the points of `profile` in the (x, z) plane. */
function strip(profile: ReadonlyArray<readonly [number, number]>): Triangle[] {
  const out: Triangle[] = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const [a, b] = [profile[i] as readonly [number, number], profile[i + 1] as readonly [number, number]];
    const [p0, p1, p2, p3]: [Vec3, Vec3, Vec3, Vec3] = [
      [a[0], 0, a[1]],
      [b[0], 0, b[1]],
      [b[0], 1, b[1]],
      [a[0], 1, a[1]],
    ];
    out.push([p0, p1, p2], [p0, p2, p3]);
  }
  return out;
}
const sourceOf = (triangles: Triangle[]): { triangles: Triangle[]; adjacency: number[][]; size: number } => ({
  triangles,
  adjacency: triangleAdjacency(triangles),
  size: diagonalOf(triangles),
});

describe('which triangles a pick highlights', () => {
  it('with the kernel labels the face is exactly the labelled triangles (a planar face with a hole, a fillet tangent to it)', () => {
    const s = sourceOf(
      strip([
        [0, 0],
        [2, 0],
        [4, 0],
        [4, 2],
      ]),
    );
    const labels = faceLabels([0, 0, 0, 0, 1, 1]);
    const ray = { origin: [3, 0.5, 5] as Vec3, direction: [0, 0, -1] as Vec3 };
    expect(pickFaceAt(s, ray, labels)?.region.sort()).toEqual([0, 1, 2, 3]);
    expect(pickFaceAt(s, { origin: [5, 0.5, 1] as Vec3, direction: [-1, 0, 0] as Vec3 }, labels)?.region).toEqual([4, 5]);
  });

  it('without labels a regular cylinder facet strip is one face, a flat 2-triangle face next to a tangent fillet is not, and a slot side wall stays alone', () => {
    const ring = Array.from({ length: 25 }, (_, i) => [3 * Math.cos((i * Math.PI) / 12), 3 * Math.sin((i * Math.PI) / 12)] as const);
    const cylinder = sourceOf(strip(ring));
    const inside = { origin: [0, 0.5, 0] as Vec3, direction: [1, 0, 0] as Vec3 };
    expect(pickFaceAt(cylinder, inside)?.region).toHaveLength(48);
    // plane z = 0 (x -2..0), a quarter fillet of radius 1 in 6 chords (15 degrees each), then a vertical wall down to z = -3
    const arc = Array.from({ length: 7 }, (_, i) => [Math.sin((i * 15 * Math.PI) / 180), -1 + Math.cos((i * 15 * Math.PI) / 180)] as const);
    const profile: Array<readonly [number, number]> = [[-2, 0], ...arc, [arc[6]![0], -3]];
    const part = sourceOf(strip(profile));
    expect(pickFaceAt(part, { origin: [-1, 0.5, 5] as Vec3, direction: [0, 0, -1] as Vec3 })?.region).toHaveLength(2);
    const fillet = pickFaceAt(part, { origin: [0.55, 0.5, 5] as Vec3, direction: [0, 0, -1] as Vec3 });
    expect(fillet?.region.length).toBeGreaterThan(2);
    expect(fillet?.region.length).toBeLessThanOrEqual(12);
    expect(fillet?.region.every((t) => t >= 2 && t < 14)).toBe(true);
    const slot = sourceOf(
      strip([
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ]),
    );
    expect(pickFaceAt(slot, { origin: [-3, 0.5, 1] as Vec3, direction: [1, 0, 0] as Vec3 })?.region).toHaveLength(2);
    expect(pickFaceAt(slot, { origin: [1, 0.5, 5] as Vec3, direction: [0, 0, -1] as Vec3 })?.region).toHaveLength(2);
  });
});
