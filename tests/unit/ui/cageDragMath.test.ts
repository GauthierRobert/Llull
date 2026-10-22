import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  type DragStart,
  type WorldRay,
  crossedThreshold,
  dragGesture,
  insetThickness,
  quaternionAxisAngle,
  rayPlanePoint,
  unitsPerPixel,
} from '@ui/viewport/3d/cage/dragMath';
import {
  cageSegments,
  creaseSegments,
  loopCutSegments,
  selectedFaceTriangles,
  selectedSegments,
  symmetryPlanes,
  vertexPositions,
} from '@ui/viewport/3d/cage/cageGeometry';
import { EMPTY_CAGE_SELECTION } from '@ui/viewport/3d/cage/cageSelection';

const down = (x: number, y: number): WorldRay => ({ origin: [x, y, 10], direction: [0, 0, -1] });

describe('dragGesture', () => {
  const translate: DragStart = { kind: 'translate', ray: down(0, 0), origin: [0, 0, 1], axis: [0, 0, -1] };
  it('moves in the view plane by the pointer travel', () => {
    expect(dragGesture(translate, down(0.5, -0.25), null)).toEqual({ kind: 'translate', delta: [0.5, -0.25, 0] });
  });
  it('keeps only the locked axis component', () => {
    expect(dragGesture(translate, down(0.5, -0.25), 'x')).toEqual({ kind: 'translate', delta: [0.5, 0, 0] });
    expect(dragGesture(translate, down(0.5, -0.25), 'y')).toEqual({ kind: 'translate', delta: [0, -0.25, 0] });
  });
  it('extrudes along the face normal from where the press happened', () => {
    const extrude: DragStart = { kind: 'extrude', ray: { origin: [5, 0, 1], direction: [-1, 0, 0] }, origin: [0, 0, 1], axis: [0, 0, 1] };
    // pointer ray now crosses the axis line 0.75 higher
    const gesture = dragGesture(extrude, { origin: [5, 0, 1.75], direction: [-1, 0, 0] }, null);
    expect(gesture?.kind === 'extrude' && gesture.distance).toBeCloseTo(0.75, 9);
  });
  it('gives up on a ray parallel to the plane or the axis', () => {
    expect(dragGesture(translate, { origin: [0, 0, 10], direction: [1, 0, 0] }, null)).toBeNull();
    const extrude: DragStart = { kind: 'extrude', ray: down(0, 0), origin: [0, 0, 1], axis: [0, 0, 1] };
    expect(dragGesture(extrude, down(1, 0), null)).toBeNull();
  });
  it('plane hits behind the ray do not count', () => {
    expect(rayPlanePoint({ origin: [0, 0, 0], direction: [0, 0, 1] }, [0, 0, -1], [0, 0, 1])).toBeNull();
  });
});

describe('small helpers', () => {
  it('treats a short press as a click', () => {
    expect(crossedThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(crossedThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
  it('measures the pixel footprint', () => {
    expect(unitsPerPixel(10, 90, 1000)).toBeCloseTo(0.02, 9);
    expect(unitsPerPixel(10, 90, 0)).toBe(0);
  });
  it('converts a quaternion to a signed axis angle', () => {
    const half = Math.SQRT1_2;
    const quarter = quaternionAxisAngle({ x: 0, y: 0, z: half, w: half });
    expect(quarter.angleDeg).toBeCloseTo(90, 9);
    expect(quarter.axis[2]).toBeCloseTo(1, 9);
    expect(quaternionAxisAngle({ x: 0, y: 0, z: 0, w: 1 }).angleDeg).toBe(0);
    // the long way round is reported as the short negative angle
    expect(quaternionAxisAngle({ x: 0, y: 0, z: half, w: -half }).angleDeg).toBeCloseTo(-90, 9);
  });
  it('grows the inset with the pointer but never below the minimum', () => {
    expect(insetThickness(0.1, 50, 0.01, 0.02)).toBeCloseTo(0.6, 9);
    expect(insetThickness(0.1, -500, 0.01, 0.02)).toBe(0.02);
  });
});

describe('overlay buffers', () => {
  const result = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1 });
  const id = result.affected[0] as string;
  const withCage = (doc: CadDocument): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
  const cage = withCage(result.document);

  it('has one segment pair per cage edge and one point per vertex', () => {
    expect(cageSegments(cage).length).toBe(
      cage.vertices.length * 0 + 6 * cage.faces.length * 0 + (cage.vertices.length + cage.faces.length - 2) * 6,
    );
    expect(vertexPositions(cage).length).toBe(cage.vertices.length * 3);
    expect(vertexPositions(cage, [0]).length).toBe(3);
  });
  it('splits sharp and semi-sharp creases', () => {
    const a = cage.elementIds.vertices;
    const sharp = execute(result.document, 'set_cage_crease', { id, edges: [`e:${a[0]}|${a[1]}`], sharpness: 10 });
    const semi = execute(result.document, 'set_cage_crease', { id, edges: [`e:${a[0]}|${a[1]}`], sharpness: 2 });
    expect(creaseSegments(withCage(sharp.document)).sharp.length).toBe(6);
    expect(creaseSegments(withCage(semi.document)).semi.length).toBe(6);
    expect(creaseSegments(withCage(semi.document)).sharp.length).toBe(0);
  });
  it('draws selected faces as outline and fill', () => {
    const faceId = cage.elementIds.faces[0] as string;
    const selection = { ...EMPTY_CAGE_SELECTION, faces: [faceId] };
    expect(selectedSegments(cage, selection).length).toBe(4 * 6);
    expect(selectedFaceTriangles(cage, selection).length).toBe(2 * 9);
    expect(selectedSegments(cage, { ...EMPTY_CAGE_SELECTION, edges: ['e:nope|x'] }).length).toBe(0);
  });
  it('previews a loop cut as one segment per crossed edge, and nothing for an unknown edge', () => {
    const a = cage.elementIds.vertices;
    const edge = `e:${a[0]}|${a[1]}`;
    const segments = loopCutSegments(cage, edge);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.length % 6).toBe(0);
    expect(loopCutSegments(cage, 'e:nope|x').length).toBe(0);
    expect(loopCutSegments(cage, 'garbage').length).toBe(0);
  });
  it('shows a quad per mirror plane', () => {
    expect(symmetryPlanes(cage)).toEqual([]);
    const mirrored = execute(result.document, 'set_cage_symmetry', { id, planes: ['x', 'z'] }).document;
    const planes = symmetryPlanes(withCage(mirrored));
    expect(planes.map((p) => p.axis)).toEqual(['x', 'z']);
    expect(planes[0]?.triangles.length).toBe(18);
    expect(planes[0]?.outline.length).toBe(24);
  });
});
