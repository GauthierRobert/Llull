/** LIM-1 #5: set_entity_color (with pattern copies) and per-face colours of mesh solids (set_face_color, viewport data, render_view, glTF). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshData, type MeshSolidEntity, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { faceColorTriangles } from '@core/geometry/faceColors';
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
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    const boxId = box.affected[0] as string;
    expectNoOp(execute(doc, 'set_face_color', { id: 'ghost', faceNear: [[0, 0, 0]], color: '#ff0000' }), doc, 'does not exist');
    expectNoOp(
      execute(box.document, 'set_face_color', { id: boxId, faceNear: [[0, 0, 0]], color: '#ff0000' }),
      box.document,
      'set_entity_color',
    );
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
