import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { fakeKernel } from '../../../helpers/fakeKernel';
import { apply, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { WOVEN, spherePart, spherePatch } from './drapeFixtures';
import { ROSETTE, T300, panelPart, withMaterials } from './fixtures';

type Slab = Extract<ShapeRecipe, { op: 'faceSlab' }>;

const AXIS = { name: 'Rax', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0], method: 'cylindrical', axis: [0, 0, 1] } as const;

const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Part on the face of a `kind` tool nearest `near`, a woven ply on `boundary`, then its ply solids. */
function plySolids(
  kind: 'add_cylinder' | 'add_cone',
  size: { radius: number; height: number },
  near: number[],
  boundary: Record<string, unknown>,
): MeshSolidEntity[] {
  let doc = apply(withMaterials(), 'define_rosette', AXIS);
  doc = apply(doc, 'create_lamina_material', WOVEN);
  const tool = ok(doc, kind, { ...size, position: [0, 0, 0] });
  const part = ok(tool.document, 'create_composite_part', {
    name: 'Skin',
    rosette: 'Rax',
    toolSurface: { entityId: tool.affected[0], faceNear: near },
  });
  doc = apply(part.document, 'add_ply', { part: part.affected[0], name: 'C1', material: WOVEN.name, orientation: 0, boundary });
  const result = ok(doc, 'create_ply_solids', { part: part.affected[0], maxEdge: 10 });
  return result.affected.map((id) => result.document.entities[id] as MeshSolidEntity);
}

const slabOf = (solid: MeshSolidEntity): Slab => {
  expect(solid.stepSlab?.op).toBe('faceSlab');
  return solid.stepSlab as Slab;
};

describe('create_ply_solids: the exact faceSlab recipe', () => {
  it('describes a plane piece: surface frame, loop in chart coordinates, height range, laminate-side direction', () => {
    const panel = panelPart();
    let doc = apply(panel.doc, 'create_lamina_material', WOVEN);
    doc = apply(doc, 'add_ply', {
      part: panel.part,
      name: 'C1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [rect(20, 10, 180, 90)] },
    });
    const result = ok(doc, 'create_ply_solids', { part: panel.part });
    const [solid] = result.affected.map((id) => result.document.entities[id] as MeshSolidEntity);
    const slab = slabOf(solid as MeshSolidEntity);
    expect(slab.surface.type).toBe('plane');
    expect(slab.surface.data).toHaveLength(9);
    expect(slab.loops).toEqual([1, 4, 1, 20, 10, 180, 10, 180, 90, 20, 90]);
    expect([slab.from, slab.to]).toEqual([0, WOVEN.plyThickness]);
    expect(slab.direction).toEqual([0, 0, 1]);
    expect(slab.tolerance).toBeGreaterThan(0);
    expect(slab.tolerance).toBeLessThanOrEqual(WOVEN.plyThickness / 50);
    expect(validateShapeRecipe(slab)).toBeNull();
    expect((result.data as { exactSolids: number }).exactSolids).toBe(1);
    expect(result.summary).toContain('1 with an exact recipe');
    expectPure(doc, () => execute(doc, 'create_ply_solids', { part: panel.part }));
  });

  it('stacks a second ply on the first: its slab starts at the thickness of the plies below', () => {
    const panel = panelPart();
    let doc = apply(panel.doc, 'create_lamina_material', WOVEN);
    for (const name of ['C1', 'C2'])
      doc = apply(doc, 'add_ply', { part: panel.part, name, material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' } });
    const result = ok(doc, 'create_ply_solids', { part: panel.part });
    const slabs = result.affected.map((id) => slabOf(result.document.entities[id] as MeshSolidEntity));
    expect(slabs.map((slab) => [slab.from, slab.to])).toEqual([
      [0, WOVEN.plyThickness],
      [WOVEN.plyThickness, 2 * WOVEN.plyThickness],
    ]);
  });

  it('describes a cylinder piece in azimuth / axial coordinates (u = x / r) and a cone piece by densified polar loops', () => {
    const [skin] = plySolids('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], { kind: 'whole_face' });
    const cylinder = slabOf(skin as MeshSolidEntity);
    expect(cylinder.surface.type).toBe('cylinder');
    expect(cylinder.surface.data.slice(9)).toEqual([50]);
    const turn = cylinder.loops.slice(3).filter((_, k) => k % 2 === 0);
    expect(Math.max(...turn) - Math.min(...turn)).toBeCloseTo(2 * Math.PI, 9);

    const [patch] = plySolids('add_cone', { radius: 100, height: 100 }, [50, 0, 50], {
      kind: 'polygon',
      polygons: [
        [
          [70, 10],
          [110, 10],
          [110, 40],
          [70, 40],
        ],
      ],
    });
    const cone = slabOf(patch as MeshSolidEntity);
    expect(cone.surface.type).toBe('cone');
    expect(cone.surface.data).toHaveLength(10);
    expect(cone.surface.data[9]).toBeCloseTo(Math.PI / 4, 9);
    expect(cone.loops.slice(0, 3)).toEqual([1, 4 * 24, 1]);
    expect(validateShapeRecipe(cone)).toBeNull();
  });

  it('describes a NURBS tool sheet by its encoded surface and maps the chart to its parameter domain', () => {
    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', ROSETTE);
    const sheet = ok(doc, 'create_nurbs_surface', spherePatch(100, 30, 90));
    const near = [100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 50];
    const part = ok(sheet.document, 'create_composite_part', {
      name: 'Skin',
      toolSurface: { entityId: sheet.affected[0], faceNear: near },
      rosette: 'R0',
    });
    doc = apply(part.document, 'add_ply', {
      part: part.affected[0],
      name: 'C1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const result = ok(doc, 'create_ply_solids', { part: part.affected[0], maxEdge: 20 });
    const slab = slabOf(result.document.entities[result.affected[0] as string] as MeshSolidEntity);
    expect(slab.surface.type).toBe('bspline');
    expect(slab.surface.data.slice(0, 7)).toEqual([2, 2, 3, 3, 2, 2, 1]);
    const params = slab.loops.slice(3).filter((_, k) => k < 8);
    expect(params.every((value) => value >= -1e-9 && value <= 1 + 1e-9)).toBe(true);
    expect(validateShapeRecipe(slab)).toBeNull();
  });

  it('keeps the triangle solid only (no recipe) on a sphere cap and over a core', () => {
    const dome = spherePart();
    let doc = apply(dome.doc, 'add_ply', {
      part: dome.part,
      name: 'C1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const cap = ok(doc, 'create_ply_solids', { part: dome.part, maxEdge: 20 });
    const capSolid = cap.document.entities[cap.affected[0] as string] as MeshSolidEntity;
    expect(capSolid.stepSlab).toBeUndefined();
    expect((cap.data as { exactSolids: number }).exactSolids).toBe(0);

    const panel = panelPart();
    doc = apply(panel.doc, 'create_lamina_material', T300);
    doc = apply(doc, 'create_lamina_material', {
      name: 'Honey',
      form: 'core_honeycomb',
      E1: 100,
      E2: 100,
      G12: 50,
      nu12: 0.1,
      plyThickness: 10,
      density: 0.00005,
      basis: 'b_basis',
      source: 'test fixture',
    });
    doc = apply(doc, 'add_ply', { part: panel.part, name: 'C1', material: T300.name, orientation: 0, boundary: { kind: 'whole_face' } });
    doc = apply(doc, 'add_core', {
      part: panel.part,
      boundary: rect(200, 100, 400, 300),
      material: 'Honey',
      thickness: 10,
      chamferAngle: 30,
      afterPly: 'C1',
    });
    doc = apply(doc, 'add_ply', { part: panel.part, name: 'C2', material: T300.name, orientation: 0, boundary: { kind: 'whole_face' } });
    const cored = ok(doc, 'create_ply_solids', { part: panel.part, plies: ['C2'] });
    for (const id of cored.affected) expect((cored.document.entities[id] as MeshSolidEntity).stepSlab).toBeUndefined();
  });

  it('survives a save and a load (the recipe is validated like any stored recipe)', () => {
    const [solid] = plySolids('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], {
      kind: 'polygon',
      polygons: [rect(20, 30, 160, 170)],
    });
    const recipe = slabOf(solid as MeshSolidEntity);
    const copy = JSON.parse(JSON.stringify(recipe)) as unknown;
    expect(validateShapeRecipe(copy)).toBeNull();
    expect(validateShapeRecipe({ ...recipe, to: recipe.from })).toMatch(/to > from/);
    expect(validateShapeRecipe({ ...recipe, surface: { type: 'torus', data: [] } })).toMatch(/surface.type/);
    expect(validateShapeRecipe({ ...recipe, loops: ['x'] })).toMatch(/loops/);
    expect(validateShapeRecipe({ ...recipe, direction: [0, 0] })).toMatch(/direction/);
    expect(validateShapeRecipe({ ...recipe, tolerance: 0 })).toMatch(/tolerance/);
    expect(validateShapeRecipe({ ...recipe, surface: { type: 'plane', data: [Number.NaN] } })).toMatch(/surface.data/);
  });

  const signer = { verify: () => ({ signer: 'reviewer', signatureId: 's' }), spend: () => true };

  it('exports a ply solid from its triangles when the kernel refuses the exact slab, or lacks the op', () => {
    const [solid] = plySolids('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], { kind: 'whole_face' });
    const entity = solid as MeshSolidEntity;
    let doc = createEmptyDocument();
    doc = { ...doc, entities: { [entity.id]: entity }, order: [entity.id] };
    const moved = { ...doc, entities: { [entity.id]: { ...entity, position: [10, 0, 0], rotation: [0, 0, 0.5] } } } as typeof doc;
    for (const source of [doc, moved])
      for (const unsupported of [[], ['faceSlab' as const]]) {
        const kernel = fakeKernel({ step: 'ISO-10303-21;\nEND-ISO-10303-21;\n', unsupported });
        // a ply solid written from triangles is a faceted body: it leaves only with a human's signature (aerospace 04 TR-XCH-26)
        const refused = execute(source, 'export_step_exact', {}, { ...defaultContext(), kernel });
        expect(refused.error?.code).toBe('XCH_UNVERIFIED_BODIES');
        expect(refused.summary).toContain(entity.id);
        const result = execute(
          source,
          'export_step_exact',
          { acceptUnverified: { nonce: 'n' } },
          { ...defaultContext(), kernel, humanSignature: signer },
        );
        expect(result.data, result.summary).toBeDefined();
        expect(result.data).toMatchObject({ solidCount: 1, faceted: [entity.id] });
        expect(result.summary).toContain('written from triangles');
      }
  });

  it('exports a document that holds an instance of a ply solid (the assembly path uses the triangles)', () => {
    const [solid] = plySolids('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], { kind: 'whole_face' });
    const entity = solid as MeshSolidEntity;
    let doc: CadDocument = { ...createEmptyDocument(), entities: { [entity.id]: entity }, order: [entity.id] };
    doc = execute(doc, 'create_component', { name: 'Ply', entityIds: [entity.id] }).document;
    doc = execute(doc, 'insert_instance', { componentId: Object.keys(doc.components)[0], position: [10, 0, 0] }).document;
    expect(Object.values(doc.entities).some((candidate) => candidate.kind === 'instance')).toBe(true);
    const kernel = {
      ...fakeKernel({ step: 'ISO-10303-21;\nEND-ISO-10303-21;\n' }),
      exportStepAssembly: () => 'ISO-10303-21;\nEND-ISO-10303-21;\n',
    };
    const result = execute(
      doc,
      'export_step_exact',
      { acceptUnverified: { nonce: 'n' } },
      { ...defaultContext(), kernel, humanSignature: signer },
    );
    expect(result.data, result.summary).toBeDefined();
  });

  it('keeps the slab out of brep: the ply solid stays a triangle operand for every other command', () => {
    const [solid] = plySolids('add_cylinder', { radius: 50, height: 200 }, [50, 0, 0], { kind: 'whole_face' });
    expect((solid as MeshSolidEntity).brep).toBeUndefined();
    expect(validateShapeRecipe((solid as MeshSolidEntity).stepSlab)).toBeNull();
  });
});
