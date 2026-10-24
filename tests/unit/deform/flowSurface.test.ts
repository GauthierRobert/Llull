import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { buildFlowSurface, flowSurfaceMap } from '@core/geometry/deform/flowSurface';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type AnalysisData, type KernelKind, dataOf, installKernel, relative, volumeOf } from './harness';
import { packData } from './packPaths';

afterEach(() => setGeometryKernel(null));

const R = 30;
const W = Math.SQRT1_2;

/** A full circular cylinder sheet of radius 30 about the line (x = 0, z = -30) along y, y in [-40, 40]: u around the circle (counter-clockwise in x-z from +x), v along y. */
function drum(): { doc: CadDocument; id: string } {
  const ring: Array<[number, number, number]> = [
    [1, 0, 1],
    [1, 1, W],
    [0, 1, 1],
    [-1, 1, W],
    [-1, 0, 1],
    [-1, -1, W],
    [0, -1, 1],
    [1, -1, W],
    [1, 0, 1],
  ];
  const poles = ring.map(([x, z]) => [-40, 40].map((y) => [R * x, y, -30 + R * z]));
  const weights = ring.map(([, , w]) => [w, w]);
  const made = execute(createEmptyDocument(), 'create_nurbs_surface', {
    degreeU: 2,
    degreeV: 1,
    poles,
    weights,
    knotsU: [0, 0.25, 0.5, 0.75, 1],
    multiplicitiesU: [3, 2, 2, 2, 3],
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

function plate(doc: CadDocument, size: [number, number, number]): { doc: CadDocument; id: string } {
  const made = execute(doc, 'add_box', { size, position: [0, 0, 0], anchor: 'min' });
  return { doc: made.document, id: made.affected[0] as string };
}

const BASE = { plane: { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] } };
const wrap = (id: string, sheetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  base: BASE,
  target: { sheetId },
  targetOrigin: [0, 0, 0],
  targetUDirection: [1, 0, 0],
  flipNormal: true,
  ...extra,
});

interface FlowCases {
  cases: Array<{ volume?: number; plate?: { side: string }; expectedCode?: string; wrapAngleDeg?: number }>;
}
const pack = packData<FlowCases>('flow_cases.json');

describe('the flow-onto-surface table (VC-DEF-17)', () => {
  it('maps (x, y, w) like ((R + w) sin(x / R), y, (R + w) cos(x / R) - R) on the NURBS drum', async () => {
    await installKernel('none');
    const { doc, id } = drum();
    const entity = doc.entities[id];
    if (entity?.kind !== 'nurbs_surface') throw new Error('no sheet');
    const law = buildFlowSurface({
      surface: entity.surface,
      origin: [0.25, 0.5],
      xAlong: 'u',
      signX: -1,
      signY: 1,
      normalSign: -1,
      xRange: [-20, 70],
      yRange: [0, 40],
      offset: 2,
      tolerance: 1e-3,
    });
    if (typeof law === 'string') throw new Error(law);
    for (const [x, y, w] of [
      [0, 0, 0],
      [30, 10, 1],
      [60, 20, 2],
      [-10, 39, 0.5],
    ] as const) {
      const image = flowSurfaceMap(law, [x, y, w]);
      const angle = x / R;
      const expected = [(R + w) * Math.sin(angle), y, (R + w) * Math.cos(angle) - R];
      expected.forEach((value, axis) => expect(Math.abs((image[axis] as number) - value)).toBeLessThan(2e-3));
    }
  });
});

describe.each<KernelKind>(['none', 'manifold', 'warp'])('flow_on_surface, kernel: %s', (kind) => {
  it('wraps the pack plate onto the drum: V = W H (t + t^2 / (2 R)) outside, a thinner shell inside', async () => {
    await installKernel(kind);
    const sheet = drum();
    const flat = plate(sheet.doc, [60, 20, 2]);
    const outside = execute(flat.doc, 'flow_on_surface', wrap(flat.id, sheet.id, { output: { tolerance: 0.01 } }));
    expect(outside.error, outside.summary).toBeUndefined();
    const next = outside.affected[0] as string;
    const expected = pack.cases.find((entry) => entry.plate?.side.startsWith('outside'))?.volume ?? 2480;
    expect(relative(volumeOf(outside.document, next), expected)).toBeLessThan(kind === 'warp' ? 1e-2 : 1e-2);
    const analysis = dataOf<AnalysisData & { law: { kind: string } }>(execute(outside.document, 'analyze_deformation', { id: next }));
    expect(analysis.law.kind).toBe('flowSurface');
    expect(analysis.jacobian.min).toBeGreaterThan(0.99);
    expect(analysis.jacobian.max).toBeCloseTo((30 + 2) / 30, 2);
    expect(relative(analysis.volume.predicted, expected)).toBeLessThan(2e-3);
    const inside = execute(flat.doc, 'flow_on_surface', wrap(flat.id, sheet.id, { flipNormal: false, output: { tolerance: 0.01 } }));
    expect(relative(volumeOf(inside.document, inside.affected[0] as string), 60 * 20 * (2 - 4 / (2 * R)))).toBeLessThan(1e-2);
    expectPure(flat.doc, () => execute(flat.doc, 'flow_on_surface', wrap(flat.id, sheet.id, { output: { tolerance: 0.01 } })));
  });

  it('refuses a body longer than the closed circumference, a missing target, a face without the exact kernel and a fold', async () => {
    await installKernel(kind);
    const sheet = drum();
    const long = plate(sheet.doc, [200, 20, 2]);
    const overlap = execute(long.doc, 'flow_on_surface', wrap(long.id, sheet.id));
    expectNoOp(overlap, long.doc, 'closed turn');
    expect(overlap.error?.code).toBe(pack.cases.find((entry) => entry.expectedCode !== undefined)?.expectedCode ?? 'DEF_FLOW_OVERLAP');
    const flat = plate(sheet.doc, [60, 20, 2]);
    expect(execute(flat.doc, 'flow_on_surface', wrap(flat.id, 'nope')).error?.code).toBe('DEF_FLOW_TARGET_INVALID');
    expect(execute(flat.doc, 'flow_on_surface', wrap(flat.id, flat.id)).error?.code).toBe('DEF_FLOW_TARGET_INVALID');
    expect(execute(flat.doc, 'flow_on_surface', { id: flat.id, base: BASE, target: {} }).error?.code).toBe('DEF_FLOW_TARGET_INVALID');
    const face = execute(flat.doc, 'flow_on_surface', { id: flat.id, base: BASE, target: { entityId: flat.id, faceNear: [0, 0, 0] } });
    expect(face.error?.code).toBe('DEF_TARGET_FACE_NEEDS_KERNEL');
    const deep = plate(sheet.doc, [60, 20, 80]);
    const folded = execute(deep.doc, 'flow_on_surface', wrap(deep.id, sheet.id, { flipNormal: false }));
    expect(folded.error?.code).toBe('DEF_FOLDOVER');
    expect(
      execute(flat.doc, 'flow_on_surface', { ...wrap(flat.id, sheet.id), base: { plane: { ...BASE.plane, uDirection: [0, 0, 1] } } }).error
        ?.code,
    ).toBe('DEF_FRAME_DEGENERATE');
  });
});

describe('flow_on_surface beyond the sheet edge', () => {
  it('refuses a body that leaves an open target', async () => {
    await installKernel('none');
    const sheet = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 20, 0],
        ],
        [
          [30, 0, 0],
          [30, 20, 0],
        ],
      ],
    });
    const flat = plate(sheet.document, [60, 20, 2]);
    const result = execute(flat.doc, 'flow_on_surface', {
      id: flat.id,
      base: BASE,
      target: { sheetId: sheet.affected[0] as string },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
    });
    expectNoOp(result, flat.doc, 'beyond the edge');
    expect(result.error?.code).toBe('DEF_FLOW_OUTSIDE_BASE');
  });

  it('flows onto a flat sheet as the identity (translation by the origin map)', async () => {
    await installKernel('none');
    const sheet = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 5],
          [0, 40, 5],
        ],
        [
          [80, 0, 5],
          [80, 40, 5],
        ],
      ],
    });
    const flat = plate(sheet.document, [60, 20, 2]);
    const result = execute(flat.doc, 'flow_on_surface', {
      id: flat.id,
      base: BASE,
      target: { sheetId: sheet.affected[0] as string },
      targetOrigin: [0, 0, 5],
      targetUDirection: [1, 0, 0],
      output: { tolerance: 0.01 },
    });
    expect(result.error, result.summary).toBeUndefined();
    expect(relative(volumeOf(result.document, result.affected[0] as string), 60 * 20 * 2)).toBeLessThan(1e-3);
    const entity = result.document.entities[result.affected[0] as string];
    if (entity === undefined) throw new Error('no result');
    const triangles = entityToTriangles(entity, result.document).flat(2);
    expect(Math.min(...triangles.filter((_, k) => k % 3 === 2))).toBeCloseTo(5, 3);
  });
});

describe('flow_on_surface onto the face of a solid (stub exact kernel with a face-query port)', () => {
  const geometry = (u: number, v: number): { point: [number, number, number]; normal: [number, number, number] } => ({
    point: [R * Math.sin(u), v, -30 + R * Math.cos(u)],
    normal: [Math.sin(u), 0, Math.cos(u)],
  });

  async function withFaces(overrides: Record<string, unknown> = {}): Promise<GeometryKernel> {
    const base = await installKernel('warp');
    if (base === null) throw new Error('no kernel');
    const kernel = {
      ...base,
      topology: () => ({ solids: 1, faces: [{}, {}], edges: [], vertices: 0, volume: 1 }),
      faceQuery: {
        projectOnFace: (_shape: unknown, face: number, points: readonly [number, number, number][]) => [
          {
            point: geometry(0, 10).point,
            normal: geometry(0, 10).normal,
            uv: [0, 10],
            distance: face === 0 ? Math.hypot(...(points[0] as [number, number, number])) * 0 : 50,
          },
        ],
        faceGeometry: () => ({
          surface: {},
          uvBounds: [
            [-1, -20],
            [2.4, 20],
          ],
        }),
        evaluateFace: (_shape: unknown, _face: number, uv: readonly [number, number][]) => uv.map(([u, v]) => geometry(u, v)),
        ...overrides,
      },
    } as unknown as GeometryKernel;
    setGeometryKernel(kernel);
    return kernel;
  }

  const wrapFace = (id: string, solid: string): Record<string, unknown> => ({
    id,
    base: BASE,
    target: { entityId: solid, faceNear: [0, 0, 0] },
    targetOrigin: [0, 0, 0],
    targetUDirection: [1, 0, 0],
    output: { tolerance: 0.01 },
  });

  it('reads the nearest face as a sheet, lays the plate outside it and keeps the pack volume', async () => {
    await withFaces();
    const solid = execute(createEmptyDocument(), 'add_cylinder', { radius: 30, height: 40, position: [0, 10, -30], axis: [0, 1, 0] });
    const flat = plate(solid.document, [60, 20, 2]);
    const result = execute(flat.doc, 'flow_on_surface', {
      ...wrapFace(flat.id, solid.affected[0] as string),
      base: { plane: { ...BASE.plane, origin: [0, 0, 0] } },
    });
    expect(result.error, result.summary).toBeUndefined();
    expect(relative(volumeOf(result.document, result.affected[0] as string), 2480)).toBeLessThan(1e-2);
  });

  it('refuses a face it cannot sample or a solid without exact faces', async () => {
    await withFaces({ evaluateFace: () => null });
    const solid = execute(createEmptyDocument(), 'add_cylinder', { radius: 30, height: 40, position: [0, 10, -30], axis: [0, 1, 0] });
    const flat = plate(solid.document, [60, 20, 2]);
    const failed = execute(flat.doc, 'flow_on_surface', wrapFace(flat.id, solid.affected[0] as string));
    expect(failed.error?.code).toBe('DEF_FLOW_TARGET_INVALID');
    expect(failed.summary).toContain('could not be sampled');
    await withFaces({ faceGeometry: () => null });
    expect(execute(flat.doc, 'flow_on_surface', wrapFace(flat.id, solid.affected[0] as string)).error?.code).toBe(
      'DEF_FLOW_TARGET_INVALID',
    );
    const faced = await withFaces();
    setGeometryKernel({ ...faced, topology: () => null } as unknown as GeometryKernel);
    expect(execute(flat.doc, 'flow_on_surface', wrapFace(flat.id, solid.affected[0] as string)).error?.code).toBe(
      'DEF_FLOW_TARGET_INVALID',
    );
    expect(execute(flat.doc, 'flow_on_surface', wrapFace(flat.id, 'ghost')).error?.code).toBe('DEF_FLOW_TARGET_INVALID');
  });
});

describe('flow onto a sheet whose second parameter runs around (closed v) and a degenerate sheet', () => {
  it('wraps along v when the target direction follows the second parameter', async () => {
    await installKernel('none');
    // the drum with u along the axis (line) and v around the circle
    const ring: Array<[number, number, number]> = [
      [1, 0, 1],
      [1, 1, W],
      [0, 1, 1],
      [-1, 1, W],
      [-1, 0, 1],
      [-1, -1, W],
      [0, -1, 1],
      [1, -1, W],
      [1, 0, 1],
    ];
    const poles = [-40, 40].map((y) => ring.map(([x, z]) => [R * x, y, -30 + R * z]));
    const weights = [ring.map(([, , w]) => w), ring.map(([, , w]) => w)];
    const made = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 2,
      poles,
      weights,
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 0.25, 0.5, 0.75, 1],
      multiplicitiesV: [3, 2, 2, 2, 3],
    });
    expect(made.error, made.summary).toBeUndefined();
    const flat = plate(made.document, [60, 20, 2]);
    const result = execute(
      flat.doc,
      'flow_on_surface',
      wrap(flat.id, made.affected[0] as string, { flipNormal: false, output: { tolerance: 0.01 } }),
    );
    expect(result.error, result.summary).toBeUndefined();
    const inside = result.affected[0] as string;
    const flipped = execute(
      flat.doc,
      'flow_on_surface',
      wrap(flat.id, made.affected[0] as string, { flipNormal: true, output: { tolerance: 0.01 } }),
    );
    const volumes = [volumeOf(result.document, inside), volumeOf(flipped.document, flipped.affected[0] as string)].sort((a, b) => a - b);
    expect(relative(volumes[1] as number, 2480)).toBeLessThan(1e-2);
    expect(relative(volumes[0] as number, 60 * 20 * (2 - 4 / (2 * R)))).toBeLessThan(1e-2);
  });

  it('refuses a sheet that is a cone point (degenerate normal)', async () => {
    await installKernel('none');
    const apex = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        [
          [40, 0, 0],
          [40, 40, 0],
        ],
      ],
    });
    const flat = plate(apex.document, [10, 10, 1]);
    const result = execute(flat.doc, 'flow_on_surface', {
      id: flat.id,
      base: BASE,
      target: { sheetId: apex.affected[0] as string },
      targetOrigin: [0, 0, 0],
      targetUDirection: [1, 0, 0],
    });
    expect(['DEF_FLOW_TARGET_INVALID', 'DEF_FLOW_OUTSIDE_BASE']).toContain(result.error?.code);
  });
});
