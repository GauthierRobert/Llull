/**
 * Native `llull-kernel` (OCCT 7.9.2) on the recipe nodes of the second native slice (VC-KRN-25, TR-KRN-05): exact curved profiles, loft,
 * sweep, subdivision, shell, blend, `feature` nodes (holes, pockets, ribs, a modelled thread) and the edge indexing of fillet / chamfer.
 * Each case is a valid solid (one lump unless it is disjoint) whose exact volume matches the volume of its own display mesh; where a closed
 * form exists (box shell, rounded box, edge fillets / chamfers, holes, pockets, ribs, extrusion with an arc and a Bezier) the exact volume
 * and the STEP face count match it. The kernel is driven through its synchronous proxy, so the host lowering of `feature` nodes is
 * included. Skipped without the binary unless LLULL_REQUIRE_NATIVE_KERNEL=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CurveSegment } from '@core/model/curve';
import type { Entity, MeshData, ShapeRecipe, SubdivisionEntity, Vec2, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { reverseChain, sampleProfile } from '@core/geometry/curveSegments';
import { boxCage, cylinderCage } from '@core/geometry/subdivision';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { booleanRecipe, box, common, createNativeTestKernel, leaf, nativeKernelBinary, volume } from './kernelTestSupport';

const entity = (kind: string, fields: Record<string, unknown>, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Entity =>
  ({ id: kind, kind, position, rotation, ...common, ...fields }) as Entity;

const line = (a: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'line', points: [a, b] });
/** A D-shaped profile: line, semicircular arc, Bézier, line (counter-clockwise). */
const D_PROFILE: CurveSegment<Vec2>[] = [
  line([0, 0], [4, 0]),
  {
    type: 'arc',
    points: [
      [4, 0],
      [5, 1],
      [4, 2],
    ],
  },
  {
    type: 'bezier',
    points: [
      [4, 2],
      [3, 3],
      [1, 3],
      [0, 2],
    ],
  },
  line([0, 2], [0, 0]),
];
const CLOCKWISE_D = reverseChain(D_PROFILE);
/** Radial / axial profile with a bulging arc, for revolutions. */
const RING_PROFILE: CurveSegment<Vec2>[] = [
  line([1, 0], [2, 0]),
  {
    type: 'arc',
    points: [
      [2, 0],
      [2.5, 1],
      [2, 2],
    ],
  },
  line([2, 2], [1, 2]),
  line([1, 2], [1, 0]),
];

const curved = (
  kind: 'extrusion' | 'revolution',
  curves: CurveSegment<Vec2>[],
  fields: Record<string, unknown>,
  at?: Vec3,
  turn?: Vec3,
): Entity => entity(kind, { profile: sampleProfile(curves), curves, ...fields }, at, turn);

const ring = (radius: number, z: number, squareness = 0): Vec3[] =>
  Array.from({ length: 8 }, (_, k) => {
    const angle = (k / 8) * 2 * Math.PI;
    const scale = 1 + squareness * (k % 2 === 1 ? 0.3 : 0);
    return [radius * scale * Math.cos(angle), radius * scale * Math.sin(angle), z];
  });

const subdivision = (cage: Pick<SubdivisionEntity, 'vertices' | 'faces' | 'creases'>, levels: number, at: Vec3 = [0, 0, 0]): Entity =>
  entity('subdivision', { ...cage, levels }, at);

const plateWithBore = booleanRecipe('subtract', box([0, 0, 0], [6, 6, 2]), entity('cylinder', { radius: 1.2, height: 8 }, [1, 1, 0]));

const SOLIDS: readonly [string, Entity][] = [
  ['extrusion with arc and Bezier', curved('extrusion', D_PROFILE, { depth: 3 })],
  ['clockwise curved extrusion, placed', curved('extrusion', CLOCKWISE_D, { depth: 2 }, [1, 2, 3], [0.3, 0.2, 0.1])],
  ['curved revolution about Z', curved('revolution', RING_PROFILE, { axis: [0, 0, 1], angle: 2 * Math.PI, segments: 32 })],
  ['curved revolution about Y, partial', curved('revolution', RING_PROFILE, { axis: [0, 1, 0], angle: 1.5 * Math.PI, segments: 32 })],
  ['curved revolution about X', curved('revolution', RING_PROFILE, { axis: [1, 0, 0], angle: Math.PI, segments: 32 })],
  ['smooth loft', entity('loft', { rings: [ring(2, 0), ring(1.5, 2, 1), ring(2.2, 4)], ruled: false })],
  ['ruled loft, placed', entity('loft', { rings: [ring(2, 0), ring(1, 3, 1)], ruled: true }, [5, 0, 1], [0.2, 0, 0.4])],
  [
    'tube sweep along a line and an arc',
    entity('sweep', {
      path: [
        {
          type: 'line',
          points: [
            [0, 0, 0],
            [0, 0, 4],
          ],
        },
        {
          type: 'arc',
          points: [
            [0, 0, 4],
            [2 - Math.SQRT2, 0, 4 + Math.SQRT2],
            [2, 0, 6],
          ],
        },
      ],
      section: { shape: 'circle', radius: 0.5, innerRadius: 0.3 },
    }),
  ],
  [
    'hollow ring sweep around a closed circle (LIM-1)',
    entity('sweep', {
      path: [
        {
          type: 'arc',
          points: [
            [0, 0, 0],
            [-10, 10, 0],
            [-20, 0, 0],
          ],
        },
        {
          type: 'arc',
          points: [
            [-20, 0, 0],
            [-10, -10, 0],
            [0, 0, 0],
          ],
        },
      ],
      section: { shape: 'circle', radius: 2, innerRadius: 1 },
    }),
  ],
  [
    'profile sweep along a Bezier',
    entity('sweep', {
      path: [
        {
          type: 'bezier',
          points: [
            [0, 0, 0],
            [0, 0, 3],
            [3, 0, 3],
            [3, 0, 6],
          ],
        },
      ],
      section: { shape: 'profile', profile: sampleProfile(D_PROFILE).map(([x, y]): Vec2 => [x / 4, y / 4]) },
    }),
  ],
  [
    'variable-section sweep',
    entity('sweep', {
      path: [
        {
          type: 'line',
          points: [
            [0, 0, 0],
            [0, 0, 5],
          ],
        },
      ],
      section: { shape: 'circle', radius: 1 },
      stations: [
        { at: 0, ring: ring(1, 0).map(([x, y]): Vec2 => [x, y]) },
        { at: 1, ring: ring(0.5, 0, 1).map(([x, y]): Vec2 => [x, y]) },
      ],
    }),
  ],
  ['smooth subdivision box', subdivision(boxCage([4, 3, 5], [2, 1, 1]), 2)],
  ['creased subdivision cylinder', subdivision(cylinderCage(1, 2, 6, 2), 1, [1, 1, 1])],
  ['faceted subdivision (level 0)', subdivision(boxCage([2, 2, 2], [1, 1, 1]), 0)],
];

const NODES: readonly [string, ShapeRecipe][] = [
  ['sealed shell of a box', { op: 'shell', source: leaf(box([0, 0, 0], [4, 3, 2])), thickness: 0.25 }],
  [
    'sealed shell of a cylinder (offset skin is a bare shell)',
    { op: 'shell', source: leaf(entity('cylinder', { radius: 2, height: 3 })), thickness: 0.3 },
  ],
  ['open shell of a box', { op: 'shell', source: leaf(box([0, 0, 0], [4, 3, 2])), thickness: 0.25, openNear: [[2, 1.5, 1]] }],
  [
    'open shell of a drilled plate, two faces open',
    {
      op: 'shell',
      source: plateWithBore,
      thickness: 0.2,
      openNear: [
        [3, 3, 1],
        [6, 3, 1],
      ],
    },
  ],
  ['blend of two boxes', { op: 'blend', sources: [leaf(box([0, 0, 0], [2, 2, 2])), leaf(box([1, 1, 1], [2, 2, 2]))], radius: 0.3 }],
  [
    'blend of a plate and a post',
    {
      op: 'blend',
      sources: [leaf(box([0, 0, 0], [6, 6, 1])), leaf(entity('cylinder', { radius: 1, height: 3 }, [3, 3, 1.5]))],
      radius: 0.25,
    },
  ],
  [
    'blend of disjoint solids (plain union)',
    { op: 'blend', sources: [leaf(box([0, 0, 0], [1, 1, 1])), leaf(box([3, 0, 0], [1, 1, 1]))], radius: 0.2 },
  ],
];

/** Fillet / chamfer recipes: identical results prove both kernels number the unique edges alike (the `topology` indexing rule). */
const ROUNDED: readonly [string, ShapeRecipe][] = [
  ['fillet one box edge', { op: 'fillet', source: leaf(box([0, 0, 0], [4, 3, 2])), edges: [0], size: 0.4 }],
  ['fillet three box edges', { op: 'fillet', source: leaf(box([0, 0, 0], [4, 3, 2])), edges: [1, 5, 9], size: 0.3 }],
  ['fillet every box edge', { op: 'fillet', source: leaf(box([0, 0, 0], [4, 3, 2])), edges: [], size: 0.2 }],
  ['variable-radius fillet', { op: 'fillet', source: leaf(box([0, 0, 0], [4, 3, 2])), edges: [2], size: 0.2, sizeEnd: 0.6 }],
  ['chamfer two box edges', { op: 'chamfer', source: leaf(box([0, 0, 0], [4, 3, 2])), edges: [3, 7], size: 0.3 }],
  ['fillet a cylinder rim', { op: 'fillet', source: leaf(entity('cylinder', { radius: 2, height: 3 })), edges: [0], size: 0.3 }],
  ['fillet edges of a boolean result', { op: 'fillet', source: plateWithBore, edges: [0, 4, 8], size: 0.2 }],
  ['chamfer edges of a boolean result', { op: 'chamfer', source: plateWithBore, edges: [2, 6], size: 0.2 }],
  ['out-of-range edge is refused', { op: 'fillet', source: leaf(box([0, 0, 0], [1, 1, 1])), edges: [12], size: 0.1 }],
];

const TOP = { near: [50, 30, 10] };
const plate = { command: 'add_box', params: { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' }, as: 'plate' };
const hole = (extra: Record<string, unknown>): unknown => ({
  command: 'add_hole',
  params: { target: '$plate', face: TOP, pointsFrame: 'world_xy', points: [[50, 30]], ...extra },
  as: 'part',
});
const pocket = (extra: Record<string, unknown>): unknown => ({
  command: 'add_pocket',
  params: {
    target: '$plate',
    face: TOP,
    outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
    cornerRadius: 3,
    floorFillet: 0,
    ...extra,
  },
  as: 'part',
});
const FEATURES: readonly [string, unknown][] = [
  ['simple through hole (BRepFeat)', hole({ hole: { kind: 'simple', diameter: 4.8 }, extent: { kind: 'through_all' } })],
  [
    'counterbore through hole',
    hole({ hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 }, extent: { kind: 'through_all' } }),
  ],
  [
    'countersink holes at four points',
    hole({
      points: [
        [10, 10],
        [90, 10],
        [10, 50],
        [90, 50],
      ],
      hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
      extent: { kind: 'through_all' },
    }),
  ],
  ['blind drilled hole', hole({ hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'blind', depth: 6, drillPointAngle: 118 } })],
  [
    '12 holes (one compound lowering)',
    hole({
      points: Array.from({ length: 12 }, (_, i) => [10 + (i % 6) * 15, 15 + Math.floor(i / 6) * 30]),
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'through_all' },
    }),
  ],
  ['rounded pocket', pocket({ depth: 4 })],
  ['through pocket', pocket({ through: true })],
  [
    'pocket with an island (lowering)',
    pocket({
      depth: 4,
      cornerRadius: 2,
      islands: [
        [
          [45, 27],
          [55, 27],
          [55, 33],
          [45, 33],
        ],
      ],
    }),
  ],
  [
    'rib',
    {
      command: 'add_rib',
      params: {
        target: '$plate',
        plane: { origin: [0, 0, 10], normal: [0, 0, 1] },
        path: [
          [20, 30],
          [80, 30],
        ],
        pointsFrame: 'world_xy',
        thickness: 3,
        height: 8,
      },
      as: 'part',
    },
  ],
];

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const { PI } = Math;

/** Closed-form exact volumes of the cases above (plate 100 x 60 x 10 = 60000; box 4 x 3 x 2 = 24). */
const countersinkDepth = (9 - 4.8) / (2 * Math.tan((50 * PI) / 180));
const roundedRect = 800 - (4 - PI) * 9; // 40 x 20, corner radius 3
const rounded = (a: number, b: number, c: number, r: number): number => {
  const [x, y, z] = [a - 2 * r, b - 2 * r, c - 2 * r];
  return x * y * z + 2 * r * (x * y + y * z + x * z) + PI * r * r * (x + y + z) + (4 / 3) * PI * r ** 3;
};
const CLOSED_VOLUME: Readonly<Record<string, number>> = {
  'extrusion with arc and Bezier': 3 * (10.1 + PI / 2),
  'hollow ring sweep around a closed circle (LIM-1)': 2 * PI * 10 * PI * (4 - 1),
  'sealed shell of a box': 24 - 3.5 * 2.5 * 1.5,
  'blend of disjoint solids (plain union)': 2,
  'fillet every box edge': rounded(4, 3, 2, 0.2),
  'simple through hole (BRepFeat)': 60000 - 57.6 * PI,
  'counterbore through hole': 60000 - PI * (2.75 ** 2 * 10 + (25 - 2.75 ** 2) * 5.5),
  'countersink holes at four points':
    60000 - 4 * (PI * 2.4 ** 2 * 10 + (PI * countersinkDepth * (4.5 ** 2 + 4.5 * 2.4 + 2.4 ** 2)) / 3 - PI * 2.4 ** 2 * countersinkDepth),
  '12 holes (one compound lowering)': 60000 - 12 * 40 * PI,
  'rounded pocket': 60000 - 4 * roundedRect,
  'through pocket': 60000 - 10 * roundedRect,
  'pocket with an island (lowering)': 60000 - 4 * 740,
  rib: 60000 + 60 * 3 * 8,
};

/** Lumps of the cases that are not one connected solid. */
const LUMPS: Readonly<Record<string, number>> = {
  'blend of disjoint solids (plain union)': 2,
  'plate minus tube': 2, // the hollow tube (radius 0.5, bore 0.3) leaves its core as a lump of its own
};

describe.skipIf(nativeKernelBinary === null)('native recipe nodes (VC-KRN-25, second slice)', () => {
  let kernel: GeometryKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
  }, 120_000);
  afterAll(() => {
    (kernel as { dispose?: () => void }).dispose?.();
    setGeometryKernel(null);
  });

  /** A valid solid whose exact volume matches its display mesh (and the closed form, when there is one). */
  const expectSolid = (label: string, recipe: ShapeRecipe): void => {
    const shape = kernel.evaluate(recipe);
    expect(shape, `${label}: built`).not.toBeNull();
    const exact = kernel.massProperties?.(shape!);
    expect(exact, label).toBeTruthy();
    const analysis = kernel.analyze?.(shape!);
    expect(analysis?.valid, `${label} validity`).toBe(true);
    expect(analysis?.lumps.length, `${label} lumps`).toBe(LUMPS[label] ?? 1);
    expect(relative(analysis!.volume, exact!.volume), `${label} analyze volume`).toBeLessThan(1e-6);
    const mesh = kernel.tessellate(shape!) as MeshData;
    expect(relative(volume(mesh), exact!.volume), `${label} display mesh`).toBeLessThan(0.15);
    const closed = CLOSED_VOLUME[label];
    if (closed !== undefined) expect(relative(exact!.volume, closed), `${label} closed form`).toBeLessThan(1e-6);
  };

  it.each(SOLIDS)(
    '%s',
    (label, solid) => {
      expectSolid(label, leaf(solid));
    },
    60_000,
  );

  it.each(NODES)(
    '%s',
    (label, recipe) => {
      expectSolid(label, recipe);
    },
    60_000,
  );

  it.each(ROUNDED.filter(([label]) => !label.includes('refused')))(
    '%s: the edge indices number the unique edges (volume left after the cut)',
    (label, recipe) => {
      const shape = kernel.evaluate(recipe);
      expect(shape, label).not.toBeNull();
      const exact = kernel.massProperties?.(shape!)?.volume ?? Number.NaN;
      const rounded = recipe as Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>;
      const source = kernel.evaluate(rounded.source)!;
      const before = kernel.massProperties?.(source)?.volume ?? Number.NaN;
      expect(exact, label).toBeLessThan(before);
      const edges = kernel.topology(source)!.edges;
      const lengths = rounded.edges.map((index) => edges[index]!.length);
      if (label === 'fillet one box edge')
        expect(relative(before - exact, (1 - PI / 4) * 0.4 ** 2 * lengths[0]!), label).toBeLessThan(1e-6);
      if (label === 'chamfer two box edges')
        expect(before - exact, label).toBeLessThan(0.5 * 0.3 ** 2 * (lengths[0]! + lengths[1]!) + 1e-9);
      if (label === 'fillet a cylinder rim') {
        const [r, big] = [0.3, 2];
        const removed = 2 * PI * r * r * (big - r / 2 - (PI * big) / 4 + (PI * r) / 4 - r / 3);
        expect(relative(before - exact, removed), label).toBeLessThan(1e-6);
      }
    },
    60_000,
  );

  it('a single chamfered box edge removes the closed-form triangular prism', () => {
    const source = leaf(box([0, 0, 0], [4, 3, 2]));
    const edge = kernel.topology(kernel.evaluate(source)!)!.edges[3]!;
    const chamfered = kernel.evaluate({ op: 'chamfer', source, edges: [3], size: 0.3 });
    expect(kernel.massProperties?.(chamfered!)?.volume).toBeCloseTo(24 - 0.5 * 0.3 ** 2 * edge.length, 6);
  });

  it('refuses a fillet naming an edge the shape does not have', () => {
    const refused = ROUNDED.find(([label]) => label.includes('refused'))![1];
    expect(kernel.evaluate(refused)).toBeNull();
  });

  const featureRecipe = (step: unknown): ShapeRecipe => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: [plate, step] }, { ...defaultContext(), kernel });
    expect(built.error).toBeUndefined();
    const id = built.document.order[0] as string;
    return recipeOf(built.document.entities[id] as Entity);
  };

  it.each(FEATURES)(
    'feature: %s',
    (label, step) => {
      const recipe = featureRecipe(step);
      expect(recipe.op).toBe('feature');
      expectSolid(label, recipe);
    },
    120_000,
  );

  it('feature: modelled M6x1 thread (groove tool, no unify) is a valid solid smaller than the plain bore', () => {
    const recipe = featureRecipe(
      hole({
        hole: { kind: 'simple', diameter: 6 - 1.0825318, thread: { designation: 'M6x1-6H', modelled: true } },
        extent: { kind: 'through_all' },
      }),
    );
    expectSolid('modelled thread', recipe);
    const volumeOf = kernel.massProperties?.(kernel.evaluate(recipe)!)?.volume ?? Number.NaN;
    expect(volumeOf).toBeLessThan(60000 - PI * (0.5 * (6 - 1.0825318)) ** 2 * 10);
  }, 600_000);

  it('a sweep placed on a boolean builds through the whole tree', () => {
    const tube = SOLIDS.find(([label]) => label.startsWith('tube sweep'))![1];
    expectSolid('plate minus tube', booleanRecipe('subtract', box([-1, -1, 1], [4, 2, 2]), tube));
  }, 60_000);

  it('drills the floor of an open shell end to end (host lowering + native nodes)', () => {
    const shelled: ShapeRecipe = { op: 'shell', source: leaf(box([20, 15, 5], [40, 30, 10])), thickness: 1, openNear: [[20, 15, 10]] };
    const drilled = {
      op: 'feature',
      feature: 'hole',
      source: shelled,
      frame: { origin: [20, 15, 0], normal: [0, 0, -1], xDir: [1, 0, 0] },
      points: [[0, 0]],
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'through_all' },
    } as ShapeRecipe;
    expect(kernel.massProperties?.(kernel.evaluate(drilled)!)?.volume).toBeCloseTo(40 * 30 * 10 - 38 * 28 * 9 - Math.PI * 4, 6);
  }, 120_000);
});
