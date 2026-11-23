/** LIM-1 #5: set_entity_color (with pattern copies) and per-face colours of mesh solids (set_face_color, viewport data, render_view, glTF). */
import { describe, it, expect } from 'vitest';
import {
  createEmptyDocument,
  type CadDocument,
  type Component,
  type Entity,
  type InstanceEntity,
  type MeshData,
  type MeshSolidEntity,
  type Vec3,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { faceColorMesh, faceColorTriangles } from '@core/geometry/faceColors';
import { localTriangles } from '@core/geometry/solidTriangles';
import { expandInstance } from '@core/geometry/instanceExpansion';
import { tessellateEntity } from '@core/commands/render/polygons';
import { cross3, sub3 } from '@lib/vec3';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';
import { parsedGltf } from '../helpers/gltfExport';
import { validateEntityValue } from '@core/commands/persistence/guards';

/** Unit cube [0,1]^3, welded (8 vertices, 12 outward triangles: 2 per side). */
const CUBE: MeshData = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
};

function withMesh(mesh: MeshData = CUBE, position: Vec3 = [10, 0, 0]): { doc: CadDocument; id: string } {
  const base = createEmptyDocument();
  const id = 'mesh-1';
  const entity: MeshSolidEntity = { id, kind: 'mesh', position, rotation: [0, 0, 0], layerId: 'layer-default', color: '#cccccc', mesh };
  return { doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [...base.order, id] }, id };
}

const faceColorsOf = (doc: CadDocument, id: string): MeshSolidEntity['faceColors'] => (doc.entities[id] as MeshSolidEntity).faceColors;

describe('set_entity_color', () => {
  it('recolours the targets, skips unknown ids with a note and leaves geometry alone', () => {
    const { doc, ids } = build(['add_box', { size: [1, 1, 1] }], ['add_sphere', { radius: 2 }]);
    const r = execute(doc, 'set_entity_color', { entityIds: [...ids, 'ghost'], color: '#ff8800' });
    expect(r.affected).toEqual(ids);
    for (const id of ids) expect(r.document.entities[id]?.color).toBe('#ff8800');
    expect(r.document.entities[ids[0] as string]?.position).toEqual(doc.entities[ids[0] as string]?.position);
    expect(r.summary).toContain('2 entities set to #ff8800');
    expect(r.summary).toContain('Missing ids skipped: ghost');
  });

  it('reaches pattern copies that still carry the seed colour, not a copy recoloured on its own', () => {
    const { doc, ids } = build(['add_cylinder', { radius: 5, height: 10, position: [20, 0, 0] }]);
    const seed = ids[0] as string;
    const pattern = execute(doc, 'array_polar', { id: seed, count: 4, center: [0, 0, 0] });
    const [own, ...followers] = pattern.affected;
    const custom = execute(pattern.document, 'set_entity_color', { entityIds: [own], color: '#00ff00' }).document;
    const r = execute(custom, 'set_entity_color', { entityIds: [seed], color: '#123456' });
    expect(r.affected).toEqual([seed, ...followers]);
    expect(r.document.entities[own as string]?.color).toBe('#00ff00');
    for (const id of followers) expect(r.document.entities[id]?.color).toBe('#123456');
    expect(r.summary).toContain('2 pattern copies');
  });

  it('notes entities whose assigned material colour wins in the viewport', () => {
    const { doc, ids } = build(
      ['add_box', { size: [1, 1, 1] }],
      ['create_material', { name: 'Steel', density: 0.00785, color: '#888888' }],
    );
    const assigned = execute(doc, 'assign_material', { materialName: 'Steel', entityIds: [ids[0]] }).document;
    expect(execute(assigned, 'set_entity_color', { entityIds: [ids[0]], color: '#ff0000' }).summary).toContain('assigned material colour');
  });

  it('rejects a malformed colour or no existing target, and is pure', () => {
    const { doc, ids } = build(['add_box', { size: [1, 1, 1] }]);
    expectNoOp(execute(doc, 'set_entity_color', { entityIds: ids, color: 'red' }), doc, '#rrggbb');
    expectNoOp(execute(doc, 'set_entity_color', { entityIds: ids, color: '#ff00' }), doc, '#rrggbb');
    expectNoOp(execute(doc, 'set_entity_color', { entityIds: ['ghost'], color: '#ff0000' }), doc, 'missing: ghost');
    expectNoOp(execute(doc, 'set_entity_color', { entityIds: [], color: '#ff0000' }), doc);
    expectPure(doc, () => execute(doc, 'set_entity_color', { entityIds: ids, color: '#ff0000' }));
  });
});

describe('set_face_color', () => {
  it('colours the picked face (stored in the entity frame) and only its triangles', () => {
    const { doc, id } = withMesh();
    const r = execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: '#ff0000' });
    expect(r.affected).toEqual([id]);
    expect(faceColorsOf(r.document, id)).toEqual([{ near: [0.5, 0.5, 1], color: '#ff0000' }]);
    const colors = faceColorTriangles(CUBE, faceColorsOf(r.document, id) ?? []);
    expect(colors.map((color, t) => (color === undefined ? -1 : t)).filter((t) => t >= 0)).toEqual([2, 3]);
    expect(r.summary).toContain('set #ff0000 on 1 face(s) of mesh-1');
  });

  it('scale_entity scales the stored face pick points with the mesh', () => {
    const { doc, id } = withMesh();
    const coloured = execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: '#ff0000' }).document;
    const scaled = execute(coloured, 'scale_entity', { id, factor: 2 }).document;
    expect(faceColorsOf(scaled, id)).toEqual([{ near: [1, 1, 2], color: '#ff0000' }]);
  });

  it('recolouring a face replaces its entry; omitting color clears it; points off the solid are skipped', () => {
    const { doc, id } = withMesh();
    const red = execute(doc, 'set_face_color', {
      id,
      faceNear: [
        [10.5, 0.5, 1],
        [10.5, 0, 0.5],
      ],
      color: '#ff0000',
    }).document;
    const blue = execute(red, 'set_face_color', {
      id,
      faceNear: [
        [10.25, 0.75, 1],
        [50, 50, 50],
      ],
      color: '#0000ff',
    });
    expect(faceColorsOf(blue.document, id)).toEqual([
      { near: [0.5, 0, 0.5], color: '#ff0000' },
      { near: [0.25, 0.75, 1], color: '#0000ff' },
    ]);
    expect(blue.summary).toContain('Skipped points off the solid: [50, 50, 50]');
    const partly = execute(blue.document, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]] });
    expect(faceColorsOf(partly.document, id)).toEqual([{ near: [0.5, 0, 0.5], color: '#ff0000' }]);
    expect(partly.summary).toContain('cleared the colour of 1 face(s)');
    const cleared = execute(partly.document, 'set_face_color', { id, faceNear: [[10.5, 0, 0.5]] });
    expect(cleared.document.entities[id]).not.toHaveProperty('faceColors');
  });

  it('faces of an exact-kernel mesh (separate vertices per B-rep face) do not merge even when coplanar', () => {
    // Two coplanar unit squares side by side, each with its own vertices (as the OCC tessellation emits per face).
    const split: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0],
      indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    };
    expect(faceColorTriangles(split, [{ near: [0.5, 0.5, 0], color: '#ff0000' }])).toEqual(['#ff0000', '#ff0000', undefined, undefined]);
    const soup: MeshData = { positions: split.indices.flatMap((i) => split.positions.slice(i * 3, i * 3 + 3)), indices: [] };
    expect(faceColorTriangles(soup, [{ near: [0.5, 0.5, 0], color: '#ff0000' }])).toEqual(['#ff0000', '#ff0000', '#ff0000', '#ff0000']);
    expect(faceColorTriangles(split, [])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('render_view and export_gltf draw the face colour', () => {
    const { doc, id } = withMesh();
    const coloured = execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: '#ff0000' }).document;
    const svgOf = (d: CadDocument): string => (execute(d, 'render_view', { mode: 'vector', view: 'top' }).data as { svg: string }).svg;
    const red = /fill="rgb\([1-9]\d*,0,0\)"/;
    expect(svgOf(coloured)).toMatch(red);
    expect(svgOf(doc)).not.toMatch(red);
    const gltf = parsedGltf<{ nodes: Array<{ name?: string }>; materials: Array<{ name?: string }> }>(coloured);
    expect(gltf.nodes.map((node) => node.name)).toContain('mesh-1/face #ff0000');
    expect(gltf.materials.map((material) => material.name)).toEqual(expect.arrayContaining(['#cccccc', '#ff0000']));
  });

  it('rejects an unknown id, a non-mesh solid, a malformed colour and picks off the solid; is pure', () => {
    const { doc, id } = withMesh();
    const box = execute(doc, 'draw_rectangle', { width: 1, height: 1 });
    const boxId = box.affected[0] as string;
    expect(box.document.entities[boxId]?.kind).toBe('rectangle');
    expectNoOp(execute(doc, 'set_face_color', { id: 'ghost', faceNear: [[0, 0, 0]], color: '#ff0000' }), doc, 'does not exist');
    expectNoOp(
      execute(box.document, 'set_face_color', { id: boxId, faceNear: [[0, 0, 0]], color: '#ff0000' }),
      box.document,
      'set_entity_color',
    );
    expect(box.affected).toHaveLength(1);
    expectNoOp(execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: 'red' }), doc, '#rrggbb');
    expectNoOp(execute(doc, 'set_face_color', { id, faceNear: [[0, 0, 0]], color: '#ff0000' }), doc, 'no point lies on');
    expectPure(doc, () => execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: '#ff0000' }));
  });

  it('stored face colours are validated on load', () => {
    const { doc, id } = withMesh();
    const coloured = execute(doc, 'set_face_color', { id, faceNear: [[10.5, 0.5, 1]], color: '#ff0000' }).document;
    expect(validateEntityValue(coloured.entities[id])).toBeNull();
    expect(validateEntityValue({ ...coloured.entities[id], faceColors: [{ near: [0, 0], color: '#ff0000' }] })).toContain('faceColors');
    expect(validateEntityValue({ ...coloured.entities[id], faceColors: [{ near: [0, 0, 0], color: 'red' }] })).toContain('faceColors');
  });
});

describe('set_face_color on parametric primitives', () => {
  const boxDoc = (): { doc: CadDocument; id: string } => {
    const { doc, ids } = build(['add_box', { size: [2, 3, 4] }]);
    return { doc, id: ids[0] as string };
  };
  const faceColors = (doc: CadDocument, id: string): MeshSolidEntity['faceColors'] =>
    (doc.entities[id] as unknown as MeshSolidEntity).faceColors;

  it('colours one side of a box and keeps the parameters', () => {
    const { doc, id } = boxDoc();
    const box = doc.entities[id] as unknown as { position: Vec3; size: Vec3 };
    const top: Vec3 = [box.position[0] + 1, box.position[1] + 1, box.position[2] + 2];
    const r = execute(doc, 'set_face_color', { id, faceNear: [top], color: '#ff0000' });
    expect(r.affected).toEqual([id]);
    expect(r.document.order).toEqual(doc.order);
    expect(r.document.entities[id]).toMatchObject({ kind: 'box', size: box.size, position: box.position });
    expect(faceColors(r.document, id)).toHaveLength(1);
    expect(r.summary).toContain('1 face(s)');
  });

  it('draws only the picked side in render_view and splits the glTF node by colour', () => {
    const { doc, id } = boxDoc();
    const [x, y, z] = (doc.entities[id] as unknown as { position: Vec3 }).position;
    const coloured = execute(doc, 'set_face_color', { id, faceNear: [[x, y, z + 2]], color: '#ff0000' }).document;
    const gltf = parsedGltf<{ nodes: Array<{ name?: string }> }>(coloured);
    expect(gltf.nodes.map((node) => node.name).some((name) => name?.endsWith('/face #ff0000'))).toBe(true);
    const svgOf = (d: CadDocument): string => (execute(d, 'render_view', { mode: 'vector', view: 'top' }).data as { svg: string }).svg;
    expect(svgOf(coloured)).toMatch(/fill="rgb\([1-9]\d*,0,0\)"/);
    expect(svgOf(doc)).not.toMatch(/fill="rgb\([1-9]\d*,0,0\)"/);
  });

  it('recolours and clears the same face without stacking entries', () => {
    const { doc, id } = boxDoc();
    const [x, y, z] = (doc.entities[id] as unknown as { position: Vec3 }).position;
    const pick: Vec3 = [x, y, z + 2];
    const red = execute(doc, 'set_face_color', { id, faceNear: [pick], color: '#ff0000' }).document;
    const blue = execute(red, 'set_face_color', { id, faceNear: [pick], color: '#0000ff' }).document;
    expect(faceColors(blue, id)?.map((f) => f.color)).toEqual(['#0000ff']);
    const cleared = execute(blue, 'set_face_color', { id, faceNear: [pick] }).document;
    expect(faceColors(cleared, id)).toBeUndefined();
  });

  it('works on a cylinder and scale_entity carries the picks', () => {
    const { doc, ids } = build(['add_cylinder', { radius: 1, height: 2 }]);
    const id = ids[0] as string;
    const [x, y, z] = (doc.entities[id] as unknown as { position: Vec3 }).position;
    const r = execute(doc, 'set_face_color', { id, faceNear: [[x, y, z + 1]], color: '#00ff00' });
    expect(r.affected).toEqual([id]);
    const scaled = execute(r.document, 'scale_entity', { id, factor: 2 });
    expect(faceColors(scaled.document, id)?.[0]?.near).toEqual(faceColors(r.document, id)?.[0]?.near.map((c) => c * 2));
  });

  it('rejects a pick off the solid and a malformed colour; is pure; stored colours are validated', () => {
    const { doc, id } = boxDoc();
    expectNoOp(execute(doc, 'set_face_color', { id, faceNear: [[500, 500, 500]], color: '#ff0000' }), doc, 'no point lies on');
    expectNoOp(execute(doc, 'set_face_color', { id, faceNear: [[0, 0, 0]], color: 'red' }), doc, '#rrggbb');
    const entity = doc.entities[id] as unknown as { position: Vec3 };
    expectPure(doc, () => execute(doc, 'set_face_color', { id, faceNear: [entity.position], color: '#ff0000' }));
    expect(validateEntityValue({ ...doc.entities[id], faceColors: [{ near: [0, 0], color: '#ff0000' }] })).toContain('faceColors');
    expect(validateEntityValue({ ...doc.entities[id], faceColors: [{ near: [0, 0, 0], color: '#ff0000' }] })).toBeNull();
  });
});

describe('primitive face colours survive regeneration, instancing and drawing', () => {
  const redBox = (): { doc: CadDocument; id: string } => {
    const { doc, ids } = build(['add_box', { size: [2, 3, 4] }]);
    return { doc, id: ids[0] as string };
  };
  const colouredPatchNormals = (e: Entity): Vec3[] => {
    const colors = faceColorTriangles(faceColorMesh(e), (e as MeshSolidEntity).faceColors ?? []);
    return localTriangles(e).flatMap(([a, b, c], t) => {
      if (colors[t] === undefined) return [];
      const n = cross3(sub3(b, a), sub3(c, a));
      const l = Math.hypot(...n);
      return [[n[0] / l, n[1] / l, n[2] / l] as Vec3];
    });
  };
  const resized = (doc: CadDocument, size: Vec3): CadDocument =>
    execute(doc, 'edit_step_params', { stepId: doc.featureHistory[0]?.id, params: { size } }).document;
  const coloured = (face: Vec3): { doc: CadDocument; id: string } => {
    const { doc, id } = redBox();
    const p = (doc.entities[id] as unknown as { position: Vec3 }).position;
    return {
      doc: execute(doc, 'set_face_color', { id, faceNear: [[p[0] + face[0], p[1] + face[1], p[2] + face[2]]], color: '#ff0000' }).document,
      id,
    };
  };

  it('records the patch ordinals and keeps the +Z side coloured when the box grows taller', () => {
    const { doc, id } = coloured([0, 0, 2]);
    expect(doc.featureHistory[1]?.params).toMatchObject({ faces: [expect.any(Number)] });
    const taller = resized(doc, [2, 3, 6]);
    expect(taller.entities[id]).toMatchObject({ size: [2, 3, 6] });
    const normals = colouredPatchNormals(taller.entities[id] as Entity);
    expect(normals.length).toBeGreaterThan(0);
    for (const n of normals) expect(n[2]).toBeCloseTo(1);
  });

  it('keeps the +X side coloured when the box gets thin, and when a resize moves no face', () => {
    const { doc, id } = coloured([1, 0, 0]);
    for (const size of [
      [2, 3, 1],
      [2, 3, 4],
    ] as Vec3[]) {
      const next = resized(doc, size);
      const normals = colouredPatchNormals(next.entities[id] as Entity);
      expect(normals.length).toBeGreaterThan(0);
      for (const n of normals) expect(n[0]).toBeCloseTo(1);
    }
  });

  it('a replayed faces list wins over faceNear; unknown ordinals are dropped and a mesh solid refuses faces', () => {
    const { doc, id } = redBox();
    const r = execute(doc, 'set_face_color', { id, faceNear: [[500, 0, 0]], faces: [1, 99], color: '#00ff00' });
    expect(r.affected).toEqual([id]);
    expect(r.summary).toContain('Dropped faces with no such patch: 99');
    expectNoOp(execute(doc, 'set_face_color', { id }), doc, 'give faceNear');
    expectNoOp(execute(doc, 'set_face_color', { id, faces: [99], color: '#00ff00' }), doc, 'face 99');
    const mesh = withMesh();
    expectNoOp(execute(mesh.doc, 'set_face_color', { id: mesh.id, faces: [0], color: '#00ff00' }), mesh.doc, 'mesh solid');
  });

  it('an instance with a non-uniform scale keeps the picked side in both export modes and render_view', () => {
    const { doc, id } = coloured([1, 0, 0]);
    let withComponent = execute(doc, 'create_component', { name: 'C', entityIds: [id] }).document;
    const componentId = Object.keys(withComponent.components)[0] as string;
    withComponent = execute(withComponent, 'insert_instance', { componentId, position: [20, 0, 0], scale: [1, 1, 0.25] }).document;
    const instance = Object.values(withComponent.entities)
      .filter((e) => e.kind === 'instance')
      .at(-1) as InstanceEntity;
    const [child] = expandInstance(instance, withComponent.components[componentId] as Component);
    for (const n of colouredPatchNormals(child as Entity)) expect(n[0]).toBeCloseTo(1);
    const baked = execute(withComponent, 'insert_instance', { componentId, position: [40, 0, 0], scale: [1, 1, -1] }).document;
    const bakedInstance = Object.values(baked.entities)
      .filter((e) => e.kind === 'instance')
      .at(-1) as InstanceEntity;
    const [bakedChild] = expandInstance(bakedInstance, baked.components[componentId] as Component);
    expect(bakedChild?.kind).toBe('mesh');
    expect((bakedChild as MeshSolidEntity).faceColors?.length).toBe(1);
    for (const mode of ['gpu', 'expand']) {
      const gltf = parsedGltf<{ nodes: Array<{ name?: string }> }>(withComponent, { instancing: mode });
      expect(gltf.nodes.some((node) => node.name?.includes('/face #ff0000'))).toBe(true);
    }
  });

  it('draws a coloured box as six quads, not twelve triangles', () => {
    const { doc } = coloured([0, 0, 2]);
    const plain = tessellateEntity(Object.values(redBox().doc.entities)[0] as Entity);
    const painted = tessellateEntity(Object.values(doc.entities)[0] as Entity);
    expect(painted).toHaveLength(plain.length);
    expect(painted.filter((polygon) => polygon.color === '#ff0000')).toHaveLength(1);
  });

  it('a coloured box and an identical plain box never share a gpu glTF mesh', () => {
    const { doc, id } = coloured([0, 0, 2]);
    const twin = execute(doc, 'add_box', { size: [2, 3, 4] }).document;
    const gltf = parsedGltf<{ nodes: Array<{ name?: string; mesh?: number }>; meshes: unknown[] }>(twin, { instancing: 'gpu' });
    const meshOf = gltf.nodes.filter((node) => node.mesh !== undefined);
    expect(meshOf.some((node) => node.name?.startsWith(`${id}/face`))).toBe(true);
    const plainNodes = meshOf.filter((node) => !node.name?.includes('/face'));
    const colouredNodes = meshOf.filter((node) => node.name?.includes('/face'));
    for (const node of plainNodes) expect(colouredNodes.map((c) => c.mesh)).not.toContain(node.mesh);
  });

  it('stored face colours are bounded and refused on kinds without faces', () => {
    const { doc, id } = redBox();
    const entry = { near: [0, 0, 0], color: '#ff0000' };
    expect(validateEntityValue({ ...doc.entities[id], faceColors: [{ ...entry, face: 3 }] })).toBeNull();
    expect(validateEntityValue({ ...doc.entities[id], faceColors: [{ ...entry, face: -1 }] })).toContain('faceColors');
    expect(validateEntityValue({ ...doc.entities[id], faceColors: Array.from({ length: 4097 }, () => entry) })).toContain('faceColors');
    const rectangle = execute(createEmptyDocument(), 'draw_rectangle', { width: 1, height: 1 });
    const flat = rectangle.document.entities[rectangle.affected[0] as string];
    expect(validateEntityValue({ ...flat, faceColors: [entry] })).toContain('not a rectangle');
  });
});
