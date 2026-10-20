import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity, type MeshData } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { stepTargets } from '@core/commands/brep/stepTargets';
import { kernelFromOps, type CachingKernel } from '@core/geometry/shapeKernel';
import { encodeLoops, encodeSurface, loopsProblem, surfaceDataProblem } from '@core/geometry/surfaceWire';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { TETRA } from '../helpers/fakeKernel';
import { expectPure } from '../helpers/expectNoOp';

/** Native fake: the entity kinds it can build, and the shapes `exportStep` was asked to write (in order). */
function sheetKernel(buildable: readonly string[]): CachingKernel & { readonly written: Entity[][] } {
  const written: Entity[][] = [];
  const kernel = kernelFromOps<{ mesh: MeshData; entity?: Entity }>({
    solid: (entity) => (buildable.includes(entity.kind) ? { mesh: TETRA, entity } : null),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (source) => ({ ...source }),
    scale: (source) => ({ ...source }),
    tessellate: (native) => native.mesh,
    topology: () => null,
    exportStep: (shapes) => {
      written.push(shapes.flatMap((shape) => (shape.entity === undefined ? [] : [shape.entity])));
      const products = shapes.map(
        (_, k) =>
          `#${10 * (k + 1)} = PRODUCT('Open CASCADE STEP translator 7.4 ${k + 1}','Open CASCADE STEP translator 7.4 ${k + 1}','',(#${10 * (k + 1) + 1}));`,
      );
      return ['ISO-10303-21;', ...products, 'END-ISO-10303-21;', ''].join('\n');
    },
    release: () => undefined,
  });
  return Object.assign(kernel, { written });
}

const SQUARE = {
  degreeU: 1,
  degreeV: 1,
  poles: [
    [
      [0, 0, 0],
      [0, 4, 0],
    ],
    [
      [4, 0, 0],
      [4, 4, 0],
    ],
  ],
};

function sheetAndBox(): { doc: CadDocument; sheet: string; box: string } {
  const sheet = execute(createEmptyDocument(), 'create_nurbs_surface', SQUARE);
  const box = execute(sheet.document, 'add_box', { size: [1, 1, 1] });
  return { doc: box.document, sheet: sheet.affected[0] as string, box: box.affected[0] as string };
}

describe('stepTargets: surface sheets', () => {
  it('collects sheets apart from the solids, by id and for the whole document', () => {
    const { doc, sheet, box } = sheetAndBox();
    const byId = stepTargets(doc, [sheet, box]);
    expect(byId.sheets.map((entity) => entity.id)).toEqual([sheet]);
    expect(byId.solids.map((entity) => entity.id)).toEqual([box]);
    expect(byId.skipped).toEqual([]);
    expect(stepTargets(doc, undefined).sheets).toHaveLength(1);
  });

  it('still names a 3D curve it cannot export', () => {
    const curve = execute(createEmptyDocument(), 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expect(stepTargets(curve.document, [curve.affected[0] as string]).skipped[0]).toMatch(/3D curve/);
  });
});

describe('export_step_exact: sheets', () => {
  it('writes the solids first, then the sheets the kernel builds, each a product named after its entity', () => {
    const { doc, sheet, box } = sheetAndBox();
    const named = execute(doc, 'set_entity_name', { id: sheet, name: 'Skin sheet' }).document;
    const kernel = sheetKernel(['box', 'nurbs_surface']);
    const result = execute(named, 'export_step_exact', {}, { ...defaultContext(), kernel });
    const data = result.data as { sheetCount: number; solidCount: number; entityIds: string[]; skipped: string[]; step: string };
    expect(data).toMatchObject({ sheetCount: 1, solidCount: 1, skipped: [] });
    expect(data.entityIds).toEqual([box, sheet]);
    expect(kernel.written[0]?.map((entity) => entity.kind)).toEqual(['box', 'nurbs_surface']);
    expect(data.step).toContain(`PRODUCT('${box}','${box}','',(#11))`);
    expect(data.step).toContain("PRODUCT('Skin sheet','Skin sheet','',(#21))");
    expect(result.summary).toContain('1 exact solid(s) and 1 surface sheet(s)');
    expect(result.affected).toEqual([]);
    expectPure(named, () => execute(named, 'export_step_exact', {}, { ...defaultContext(), kernel }));
  });

  it('writes a sheet alone', () => {
    const { doc, sheet } = sheetAndBox();
    const result = execute(
      doc,
      'export_step_exact',
      { entityIds: [sheet] },
      { ...defaultContext(), kernel: sheetKernel(['nurbs_surface']) },
    );
    expect((result.data as { sheetCount: number; solidCount: number }).sheetCount).toBe(1);
    expect((result.data as { solidCount: number }).solidCount).toBe(0);
  });

  it('skips a sheet the kernel cannot build and still writes the solids', () => {
    const { doc, sheet, box } = sheetAndBox();
    const result = execute(doc, 'export_step_exact', {}, { ...defaultContext(), kernel: sheetKernel(['box']) });
    const data = result.data as { sheetCount: number; entityIds: string[]; skipped: string[] };
    expect(data.sheetCount).toBe(0);
    expect(data.entityIds).toEqual([box]);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]).toContain(sheet);
    expect(data.skipped[0]).toMatch(/cannot build B-spline faces/);
  });

  it('is a no-op when the only selection is a sheet the kernel cannot build', () => {
    const { doc, sheet } = sheetAndBox();
    const result = execute(doc, 'export_step_exact', { entityIds: [sheet] }, { ...defaultContext(), kernel: sheetKernel(['box']) });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/nothing the kernel can write/);
  });

  it('leaves sheets out of an assembly file and says so', () => {
    const { doc, sheet } = sheetAndBox();
    let withInstance = execute(doc, 'create_component', { name: 'Peg', entityIds: [doc.order[1] as string] }).document;
    withInstance = execute(withInstance, 'place_instance', { componentName: 'Peg', position: [10, 0, 0] }).document;
    const kernel = sheetKernel(['box', 'nurbs_surface']);
    const assembly = { ...kernel, exportStepAssembly: () => 'ISO-10303-21;\nEND-ISO-10303-21;\n' };
    const result = execute(withInstance, 'export_step_exact', {}, { ...defaultContext(), kernel: assembly });
    expect(result.data, result.summary).toBeDefined();
    const data = result.data as { sheetCount: number; skipped: string[] };
    expect(data.sheetCount).toBe(0);
    expect(data.skipped.some((entry) => entry.includes(sheet) && entry.includes('assembly'))).toBe(true);
  });
});

describe('surfaceWire', () => {
  it('encodes a B-spline surface in the layout the kernel reads', () => {
    const surface = {
      degreeU: 1,
      degreeV: 2,
      poles: [
        [
          [0, 0, 0],
          [0, 1, 0],
          [0, 2, 1],
        ],
        [
          [1, 0, 0],
          [1, 1, 0],
          [1, 2, 1],
        ],
      ],
      weights: [
        [1, 2, 1],
        [1, 3, 1],
      ],
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 1],
      multiplicitiesV: [3, 3],
    } as const;
    const encoded = encodeSurface(surface);
    expect(encoded.slice(0, 7)).toEqual([1, 2, 2, 3, 2, 2, 1]);
    expect(encoded).toHaveLength(7 + 18 + 6 + 8);
    expect(encoded.slice(7, 13)).toEqual([0, 0, 0, 0, 1, 0]);
    expect(encoded.slice(25, 31)).toEqual([1, 2, 1, 1, 3, 1]);
    expect(encoded.slice(31)).toEqual([0, 1, 2, 2, 0, 1, 3, 3]);
    expect(encodeSurface({ ...surface, weights: undefined } as never).slice(6, 7)).toEqual([0]);
  });

  it('encodes trim loops as count, then point count, outer flag and (u, v) pairs; no loops = the natural boundary', () => {
    expect(encodeLoops([])).toEqual([]);
    expect(
      encodeLoops([
        {
          outer: true,
          polygon: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        {
          outer: false,
          polygon: [
            [0.2, 0.2],
            [0.4, 0.2],
            [0.4, 0.4],
          ],
        },
      ]),
    ).toEqual([2, 3, 1, 0, 0, 1, 0, 1, 1, 3, 0, 0.2, 0.2, 0.4, 0.2, 0.4, 0.4]);
  });

  it('validates loop lists: counts must be integers in range, one outer loop, nothing trailing', () => {
    const square = [1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    expect(loopsProblem([])).toBeNull();
    expect(loopsProblem(square)).toBeNull();
    for (const bad of [
      [0],
      [1e19, 4, 1],
      [1, 1e19, 1, 0, 0],
      [1, 2.5, 1, 0, 0, 1, 0],
      [1, 4, 1, 0, 0],
      [1, 4, 2, 0, 0, 1, 0, 1, 1, 0, 1],
      [1, 4, 0, 0, 0, 1, 0, 1, 1, 0, 1],
      [...square, 9],
      [2, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1],
      [Number.NaN],
    ])
      expect(loopsProblem(bad), JSON.stringify(bad)).not.toBeNull();
  });

  it('validates surface data lengths and counts', () => {
    expect(surfaceDataProblem('plane', new Array(9).fill(0))).toBeNull();
    expect(surfaceDataProblem('plane', [0])).not.toBeNull();
    expect(surfaceDataProblem('cylinder', [0, 0, 0, 0, 0, 1, 1, 0, 0, 5])).toBeNull();
    expect(surfaceDataProblem('cone', [0, 0, 0, 0, 0, 1, 1, 0, 0, -1])).not.toBeNull();
    const sheet = [1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 4, 3, 0, 0, 1, 2, 2, 0, 1, 2, 2];
    expect(surfaceDataProblem('bspline', sheet)).toBeNull();
    expect(surfaceDataProblem('bspline', sheet.slice(1))).not.toBeNull();
    expect(surfaceDataProblem('bspline', [1e19, ...sheet.slice(1)])).not.toBeNull();
    expect(surfaceDataProblem('bspline', [...sheet.slice(0, 6), 2, ...sheet.slice(7)])).not.toBeNull();
    expect(surfaceDataProblem('bspline', [...sheet.slice(0, -1), Number.NaN])).not.toBeNull();
  });
});

describe('stored ply solids', () => {
  it('rejects a stepSlab that is not a valid recipe (it would reach the kernel)', () => {
    const solid = {
      id: 'm',
      kind: 'mesh',
      layerId: 'layer-default',
      color: '#888888',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    };
    expect(validateEntityValue(solid)).toBeNull();
    const slab = {
      op: 'faceSlab',
      surface: { type: 'plane', data: new Array(9).fill(0) },
      loops: [],
      from: 0,
      to: 1,
      direction: [0, 0, 1],
      tolerance: 1e-6,
    };
    expect(validateEntityValue({ ...solid, stepSlab: slab })).toBeNull();
    expect(validateEntityValue({ ...solid, stepSlab: { ...slab, loops: [1e19, 4, 1] } })).toMatch(/stepSlab recipe invalid/);
    expect(validateEntityValue({ ...solid, stepSlab: { ...slab, from: 2 } })).toMatch(/stepSlab recipe invalid/);
  });
});
