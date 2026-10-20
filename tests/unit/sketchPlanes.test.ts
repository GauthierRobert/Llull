/** SC-S3: sketch planes (world / face, offset, spin), sketches placed on them, linked edge projection, break link, lost links. */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { kernelFromOps, type FaceQueryOps } from '@core/geometry/shapeKernel';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { TETRA } from '../helpers/fakeKernel';
import { expectPure } from '../helpers/expectNoOp';
import { manifoldSuite } from '../helpers/featureSupport';

const close = (a: readonly number[], b: readonly number[]): void => a.forEach((value, i) => expect(value).toBeCloseTo(b[i] ?? NaN, 9));
const planeOf = (result: CommandResult): string => (result.data as { id: string }).id;

describe('world sketch planes', () => {
  it('xy offset 5, xz faces -Y, spin turns the x axis', () => {
    const xy = execute(createEmptyDocument(), 'create_sketch_plane', { plane: 'xy', offset: 5, name: 'Top' });
    expect(xy.document.sketchPlanes?.[planeOf(xy)]?.frame).toEqual({ origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] });
    const xz = execute(xy.document, 'create_sketch_plane', { plane: 'xz', spin: 90 });
    const frame = xz.document.sketchPlanes?.[planeOf(xz)]?.frame;
    close(frame?.normal ?? [], [0, -1, 0]);
    close(frame?.xDir ?? [], [0, 0, 1]);
  });

  it('places a 2D sketch on the plane: local x → plane x, local y → plane y, origin at the plane origin + at', () => {
    const plane = execute(createEmptyDocument(), 'create_sketch_plane', { plane: 'yz', offset: 3 });
    const rect = execute(plane.document, 'draw_rectangle', { width: 4, height: 2 });
    const placed = execute(rect.document, 'place_on_sketch_plane', { ids: rect.affected, plane: planeOf(plane), at: [1, 0] });
    const entity = placed.document.entities[rect.affected[0] ?? ''] as Entity;
    close(entityLocalToWorld(entity, [0, 0, 0]), [3, 1, 0]);
    close(entityLocalToWorld(entity, [1, 0, 0]), [3, 2, 0]);
    close(entityLocalToWorld(entity, [0, 1, 0]), [3, 1, 1]);
  });

  it('refuses an unknown plane, a 3D entity, and plane + face together', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(execute(doc.document, 'place_on_sketch_plane', { ids: doc.affected, plane: 'nope' }).summary).toMatch(/no sketch plane/);
    const plane = execute(doc.document, 'create_sketch_plane', { plane: 'xy' });
    expect(execute(plane.document, 'place_on_sketch_plane', { ids: doc.affected, plane: planeOf(plane) }).summary).toMatch(/not 2D/);
    expect(execute(doc.document, 'create_sketch_plane', { plane: 'xy', face: { id: doc.affected[0], faceIndex: 0 } }).summary).toMatch(
      /plane OR face/,
    );
  });

  it('round-trips through save / load', () => {
    const plane = execute(createEmptyDocument(), 'create_sketch_plane', { plane: 'xz', offset: 2 });
    expect(deserializeDocument(serializeDocument(plane.document)).sketchPlanes).toEqual(plane.document.sketchPlanes);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'create_sketch_plane', { plane: 'xy', offset: 1 }));
  });
});

describe('a sketch placed on a vertical plane extrudes along the plane normal (Manifold)', () => {
  const kernel = manifoldSuite();
  it('a 4 x 2 rectangle on xz (normal -Y) extruded 3 with plane fills y in [-3, 0]; without plane the documented flat extrusion is unchanged', () => {
    setGeometryKernel(kernel());
    const plane = execute(createEmptyDocument(), 'create_sketch_plane', { plane: 'xz' });
    const rect = execute(plane.document, 'draw_rectangle', { width: 4, height: 2 });
    const placed = execute(rect.document, 'place_on_sketch_plane', { ids: rect.affected, plane: planeOf(plane) });
    const solid = execute(placed.document, 'extrude_profile', { id: rect.affected[0], depth: 3, plane: planeOf(plane) });
    const id = solid.affected[0] ?? '';
    const volume = (execute(solid.document, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
    expect(volume).toBeCloseTo(24, 6);
    const box = execute(solid.document, 'measure_bounding_box', { entityId: id }).data as { min: number[]; max: number[] };
    expect(box.min[1]).toBeCloseTo(-3, 6);
    expect(box.max[1]).toBeCloseTo(0, 6);
    expect(box.max[2]! - box.min[2]!).toBeCloseTo(2, 6);
    const flat = execute(placed.document, 'extrude_profile', { id: rect.affected[0], depth: 3 });
    const flatBox = execute(flat.document, 'measure_bounding_box', { entityId: flat.affected[0] }).data as { size: number[] };
    expect(flatBox.size).toEqual([4, 2, 3]);
    expect(execute(placed.document, 'extrude_profile', { id: rect.affected[0], depth: 3, plane: 'nope' }).summary).toMatch(
      /no sketch plane/,
    );
    expect(
      execute(placed.document, 'extrude_profile', { id: rect.affected[0], depth: 3, plane: planeOf(plane), axis: [0, 0, 1] }).summary,
    ).toMatch(/plane OR rotation/);
    setGeometryKernel(null);
  });
});

/** A fake exact kernel: a box of size s has its top face 'b:z+' at z = s/2 and one vertical edge e(b:x+|b:y+) at x = y = s/2. */
function namedKernel(options: { topName?: (size: number) => string } = {}): void {
  type Shape = { readonly size: number };
  const kernel = kernelFromOps<Shape>({
    solid: (entity) => ({ size: entity.kind === 'box' ? entity.size[2] : 1 }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    tessellate: () => TETRA,
    topology: (shape): ShapeTopology => {
      const h = shape.size / 2;
      return {
        solids: 1,
        faces: [{ index: 0, name: options.topName?.(shape.size) ?? 'b:z+', surface: 'plane', area: 1, normal: [0, 0, 1] }],
        edges: [
          {
            index: 0,
            name: 'e(b:x+|b:y+)',
            curve: 'line',
            length: 2 * h,
            start: [h, h, -h],
            end: [h, h, h],
            mid: [h, h, 0],
            seam: false,
            degenerate: false,
          },
          {
            index: 1,
            name: 'e(b:x+|b:z+)',
            curve: 'line',
            length: 2 * h,
            start: [h, -h, h],
            end: [h, h, h],
            mid: [h, 0, h],
            seam: false,
            degenerate: false,
          },
        ],
        vertices: 8,
        volume: shape.size ** 3,
      };
    },
    exportStep: () => null,
    release: () => undefined,
    faceQuery: {
      distance: (_shape: Shape, points: readonly unknown[]) => points.map(() => ({ distance: 0, signed: 0, face: 0 })),
      faceDetails: (shape: Shape) => [
        { index: 0, surface: 'plane', area: 1, centroid: [0, 0, shape.size / 2], normal: [0, 0, 1], samples: [] },
      ],
    } as unknown as FaceQueryOps<Shape>,
  });
  setGeometryKernel(kernel as GeometryKernel);
}

afterEach(() => setGeometryKernel(null));

function onTopFace(size = 4): { doc: CadDocument; box: string; plane: string; boxStep: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [size, size, size] });
  const plane = execute(box.document, 'create_sketch_plane', { face: { id: box.affected[0], faceIndex: 0 }, offset: 1 });
  return { doc: plane.document, box: box.affected[0] ?? '', plane: planeOf(plane), boxStep: box.document.featureHistory[0]?.id ?? '' };
}

describe('a sketch plane on a face', () => {
  it('sits on the face, offset along its normal, and records the face name', () => {
    namedKernel();
    const { doc, plane } = onTopFace();
    expect(doc.sketchPlanes?.[plane]?.frame.origin).toEqual([0, 0, 3]);
    expect(doc.sketchPlanes?.[plane]?.base).toEqual({ kind: 'face', entityId: expect.any(String), faceName: 'b:z+' });
    expect(doc.featureHistory.at(-1)?.params).toMatchObject({ faceNames: ['b:z+'] });
  });

  it('follows the face when the solid is edited upstream, together with the sketch placed on it', () => {
    namedKernel();
    const { doc, plane, boxStep } = onTopFace();
    const rect = execute(doc, 'draw_rectangle', { width: 1, height: 1 });
    const placed = execute(rect.document, 'place_on_sketch_plane', { ids: rect.affected, plane });
    const edited = execute(placed.document, 'edit_step_params', { stepId: boxStep, params: { size: [10, 10, 10] } });
    expect(edited.document.sketchPlanes?.[plane]?.frame.origin).toEqual([0, 0, 6]);
    expect(edited.document.entities[rect.affected[0] ?? '']?.position).toEqual([0, 0, 6]);
  });

  it('fails the step with REF_LOST when the face it was on is gone', () => {
    namedKernel({ topName: (size) => (size > 5 ? 'b:other' : 'b:z+') });
    const { doc, boxStep } = onTopFace();
    const edited = execute(doc, 'edit_step_params', { stepId: boxStep, params: { size: [10, 10, 10] } });
    expect(edited.summary).toContain('REF_LOST face b:z+');
  });
});

describe('linked edge projection', () => {
  it('projects named edges onto the plane, follows them after an edit, and records the link', () => {
    namedKernel();
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const plane = execute(box.document, 'create_sketch_plane', { plane: 'xy', offset: 10 });
    const projected = execute(plane.document, 'project_edges_to_sketch', { plane: planeOf(plane), id: box.affected[0], edgeIndices: [1] });
    const id = projected.affected[0] ?? '';
    const entity = projected.document.entities[id];
    expect(entity?.kind === 'polyline' ? entity.points : null).toEqual([
      [2, -2],
      [2, 2],
    ]);
    expect(projected.document.sketchLinks?.[id]).toMatchObject({ source: { edgeNames: ['e(b:x+|b:z+)'] }, mode: 'project' });
    const edited = execute(projected.document, 'edit_step_params', { stepId: 'step-1', params: { size: [6, 6, 6] } });
    const moved = edited.document.entities[id];
    expect(moved?.kind === 'polyline' ? moved.points : null).toEqual([
      [3, -3],
      [3, 3],
    ]);
  });

  it('intersect mode puts a point where an edge crosses the plane', () => {
    namedKernel();
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const plane = execute(box.document, 'create_sketch_plane', { plane: 'xy', offset: 1 });
    const cut = execute(plane.document, 'project_edges_to_sketch', {
      plane: planeOf(plane),
      id: box.affected[0],
      edgeIndices: [0],
      mode: 'intersect',
    });
    expect(cut.document.entities[cut.affected[0] ?? '']?.position).toEqual([2, 2, 1]);
    const miss = execute(plane.document, 'project_edges_to_sketch', {
      plane: planeOf(plane),
      id: box.affected[0],
      edgeIndices: [1],
      mode: 'intersect',
    });
    expect(miss.summary).toMatch(/no picked edge crosses/);
  });

  it('break_sketch_link freezes the geometry: an upstream edit no longer moves it; check_model reports a lost link until broken', () => {
    namedKernel();
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const plane = execute(box.document, 'create_sketch_plane', { plane: 'xy', offset: 10 });
    const projected = execute(plane.document, 'project_edges_to_sketch', { plane: planeOf(plane), id: box.affected[0], edgeIndices: [1] });
    const id = projected.affected[0] ?? '';
    const deleted = execute(projected.document, 'delete_entities', { ids: box.affected });
    const codes = (execute(deleted.document, 'check_model', {}).data as { issues: { code: string }[] }).issues.map((issue) => issue.code);
    expect(codes).toContain('sketch_link_lost');
    const broken = execute(projected.document, 'break_sketch_link', { id });
    expect(broken.document.sketchLinks?.[id]).toBeUndefined();
    const edited = execute(broken.document, 'edit_step_params', { stepId: 'step-1', params: { size: [6, 6, 6] } });
    const kept = edited.document.entities[id];
    expect(kept?.kind === 'polyline' ? kept.points : null).toEqual([
      [2, -2],
      [2, 2],
    ]);
    expect(execute(broken.document, 'break_sketch_link', { id }).summary).toMatch(/not linked/);
  });

  it('needs an exact kernel', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [4, 4, 4] });
    const plane = execute(box.document, 'create_sketch_plane', { plane: 'xy' });
    expect(execute(plane.document, 'project_edges_to_sketch', { plane: planeOf(plane), id: box.affected[0] }).document).toBe(
      plane.document,
    );
  });
});
