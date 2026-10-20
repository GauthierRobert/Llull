import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshData } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { prismMesh } from '@core/geometry/prismMesh';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

const L_PROFILE: Array<[number, number]> = [
  [0, 0],
  [40, 0],
  [40, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];
const HOLE: Array<[number, number]> = [
  [20, 4],
  [30, 4],
  [30, 8],
  [20, 8],
];

const volumeOf = (doc: CadDocument, id: string): number =>
  (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;

function importBody(mesh: MeshData, name = 'Bracket'): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'import_mesh', {
    bodies: [{ positions: mesh.positions, indices: mesh.indices, name, color: '#336699' }],
  });
  return { doc: result.document, id: result.affected[0] as string };
}

/** Rotates a mesh 90 degrees about X: (x, y, z) -> (x, -z, y), so the extrusion axis becomes Y. */
const turnedAboutX = (mesh: MeshData): MeshData => ({
  indices: mesh.indices,
  positions: mesh.positions.flatMap((_, i, all) => (i % 3 === 0 ? [all[i] as number, -(all[i + 2] as number), all[i + 1] as number] : [])),
});

describe('mesh_to_solid (no holes)', () => {
  const { doc, id } = importBody(prismMesh(L_PROFILE, [], 6));

  it('rebuilds an L-profile prism mesh as an extrusion with the same outline, depth, volume and style', () => {
    const result = execute(doc, 'mesh_to_solid', { id });
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0] as string];
    expect(solid?.kind).toBe('extrusion');
    if (solid?.kind !== 'extrusion') return;
    expect(solid.depth).toBeCloseTo(6, 6);
    expect(solid.profile).toHaveLength(6);
    expect(solid.color).toBe('#336699');
    expect(solid.name).toBe('Bracket');
    expect(result.document.entities[id]).toBeUndefined();
    expect(result.document.order).toEqual([solid.id]);
    expect(volumeOf(result.document, solid.id)).toBeCloseTo(volumeOf(doc, id), 6);
    expect(volumeOf(result.document, solid.id)).toBeCloseTo((40 * 10 + 10 * 20) * 6, 6);
  });

  it('keeps the source with keepSource', () => {
    const result = execute(doc, 'mesh_to_solid', { id, keepSource: true });
    expect(result.document.order).toHaveLength(2);
    expect(result.document.entities[id]).toBeDefined();
  });

  it('finds a tilted axis: the same prism turned about X is rebuilt in place', () => {
    const turned = importBody(turnedAboutX(prismMesh(L_PROFILE, [], 6)));
    const result = execute(turned.doc, 'mesh_to_solid', { id: turned.id });
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0] as string];
    expect(solid?.kind).toBe('extrusion');
    const bounds = execute(result.document, 'measure_bounding_box', { entityId: result.affected[0] }).data as {
      min: number[];
      max: number[];
    };
    expect(bounds.min[1]).toBeCloseTo(-6, 5);
    expect(bounds.max[1]).toBeCloseTo(0, 5);
    expect(bounds.max[0]).toBeCloseTo(40, 5);
    expect(bounds.max[2]).toBeCloseTo(30, 5);
    expect(volumeOf(result.document, result.affected[0] as string)).toBeCloseTo(volumeOf(turned.doc, turned.id), 5);
  });

  it('is pure', () => {
    const before = JSON.stringify(doc);
    execute(doc, 'mesh_to_solid', { id });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('mesh_to_solid (hole, Manifold kernel)', () => {
  let previous: GeometryKernel | null;
  beforeAll(async () => {
    previous = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);
  afterAll(() => setGeometryKernel(previous));

  it('rebuilds an L-profile with a hole as an extrusion minus the hole tool, with the right volume', () => {
    const { doc, id } = importBody(prismMesh(L_PROFILE, [HOLE], 6));
    const result = execute(doc, 'mesh_to_solid', { id });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('1 hole(s) subtracted');
    const rebuilt = result.document.entities[result.affected[0] as string];
    expect(rebuilt?.kind).toBe('mesh');
    expect(rebuilt && 'brep' in rebuilt ? rebuilt.brep?.op : undefined).toBe('boolean');
    expect(result.document.order).toEqual([result.affected[0]]);
    expect(volumeOf(result.document, result.affected[0] as string)).toBeCloseTo((400 + 200 - 40) * 6, 3);
  });

  it('a sphere mesh is refused and the document is unchanged', () => {
    const sphere = execute(createEmptyDocument(), 'add_sphere', { radius: 5 });
    const tris = (execute(sphere.document, 'export_stl', { format: 'ascii' }).data as { stl: string }).stl;
    const positions = [...tris.matchAll(/vertex (\S+) (\S+) (\S+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [{ positions }] });
    const refused = execute(imported.document, 'mesh_to_solid', { id: imported.affected[0] });
    expect(refused.affected).toEqual([]);
    expect(refused.document).toBe(imported.document);
    expect(refused.summary).toContain('not a constant-section prism');
  });
});

describe('mesh_to_solid failures', () => {
  it('refuses a missing id and a non-mesh entity', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const missing = execute(doc.document, 'mesh_to_solid', { id: 'nope' });
    expect(missing.affected).toEqual([]);
    expect(missing.summary).toContain('not found');
    const wrong = execute(doc.document, 'mesh_to_solid', { id: doc.affected[0] });
    expect(wrong.affected).toEqual([]);
    expect(wrong.summary).toContain('not a mesh');
  });

  it('refuses a prism with holes when no kernel is installed', () => {
    const { doc, id } = importBody(prismMesh(L_PROFILE, [HOLE], 6));
    const result = execute(doc, 'mesh_to_solid', { id });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('refuses a tapered mesh (pyramid frustum has no constant section)', () => {
    const pyramid = execute(createEmptyDocument(), 'add_pyramid', { baseWidth: 4, baseDepth: 4, height: 3 });
    const stl = (execute(pyramid.document, 'export_stl', {}).data as { stl: string }).stl;
    const positions = [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [{ positions }] });
    const result = execute(imported.document, 'mesh_to_solid', { id: imported.affected[0] });
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('no axis gives a constant section');
  });
});
