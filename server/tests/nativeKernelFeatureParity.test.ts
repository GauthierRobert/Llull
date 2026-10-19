/**
 * Native `llull-kernel` vs the WASM OCC kernel on the recipe nodes of the second native slice (VC-KRN-25, TR-KRN-05): exact curved
 * profiles, loft, sweep, subdivision, shell, blend, `feature` nodes (holes, pockets, ribs, a modelled thread) and the edge indexing of
 * fillet / chamfer. Each case: exact volume, area and inertia within 1e-6 relative (inertia: two documented WASM errors, below),
 * centroid 1e-6, the same validity, and the same face count (ADVANCED_FACE entities of each kernel's STEP export) where it is
 * deterministic. The sidecar is driven directly (the
 * router's host lowering included, its fillet gate bypassed), so fillet / chamfer parity is measured although they still route to WASM.
 * Skipped without the binary unless LLULL_REQUIRE_NATIVE_KERNEL=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import type { CurveSegment } from '@core/model/curve';
import type { Entity, ShapeRecipe, SubdivisionEntity, Vec2, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { recipeKey, recipeOf } from '@core/geometry/shapeRecipe';
import { reverseChain, sampleProfile } from '@core/geometry/curveSegments';
import { boxCage, cylinderCage } from '@core/geometry/subdivision';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { createNativeKernel } from '../src/nativeKernel';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';
import { decodeMesh, nativeArgs, nativeRecipe } from '../src/native/kernelProtocol';
import { prepareFeatures, type SourceMesher } from '../src/native/kernelFeatures';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from '../src/native/kernelSession';
import { booleanRecipe, box, common, leaf } from './kernelTestSupport';

const binary = nativeBinaryPath('llull-kernel');
if (binary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));
if (binary === null) console.warn(`[native feature parity] skipped: ${nativeInstallHint('llull-kernel')}`);

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

/**
 * Inertia error of the WASM kernel's adaptive BRepGProp rule (Eps 1e-12) on arc-profile revolutions (measured 1.6e-4 and 2.2e-6:
 * Ixx != Iyy about Z); the native kernel uses the default Gauss rule of the OCP 7.9.3 reference and gives the closed form there
 * (nativeKernelReference.test.ts), so these cases tolerate the WASM error instead of 1e-6.
 */
const WASM_INERTIA_ERROR: Readonly<Record<string, number>> = {
  'curved revolution about Z': 3e-4,
  'curved revolution about Y, partial': 3e-6,
};

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
const faceCount = (step: unknown): number => (typeof step === 'string' ? (step.match(/ADVANCED_FACE\(/g)?.length ?? 0) : -1);

describe.skipIf(binary === null)('native feature nodes vs WASM OCC parity (VC-KRN-25, second slice)', () => {
  let session: NativeKernelSession;
  let wasm: GeometryKernel;

  beforeAll(async () => {
    session = createKernelSession(spawnKernelChild(binary!));
    wasm = await createNodeOcctKernel();
  }, 120_000);
  afterAll(() => {
    session.close();
    setGeometryKernel(null);
  });

  const mesher: SourceMesher = async (source, features) => {
    const reply = await session.request('tessellate', [{ key: recipeKey(source), recipe: nativeRecipe(source, features) }]);
    return reply.error === undefined ? decodeMesh(reply.result) : 'unsupported';
  };

  /** One sidecar request on `recipe`, lowered like the router does (`lower: false` skips the host gate, for fillet / chamfer). */
  const native = async (op: string, recipe: ShapeRecipe, lower = true): Promise<unknown> => {
    const args =
      op === 'evaluate' ? [recipe] : op === 'exportStep' ? [[{ key: recipeKey(recipe), recipe }]] : [{ key: recipeKey(recipe), recipe }];
    const prepared = lower ? await prepareFeatures(op, args, mesher) : { features: new Map() };
    if ('unsupported' in prepared) throw new Error(prepared.unsupported);
    const reply = await session.request(op, nativeArgs(op, args, prepared.features));
    expect(reply.error, `${op}: ${reply.error}`).toBeUndefined();
    return reply.result;
  };

  /** Worst relative deviation per case, printed with LLULL_PARITY_REPORT=1 (the numbers quoted in TECHNICAL_SPEC §13.D). */
  const report: string[] = [];
  afterAll(() => {
    if (process.env['LLULL_PARITY_REPORT'] === '1') console.warn(`[native feature parity]\n${report.join('\n')}`);
  });

  const expectMassParity = (fromNative: ExactMassProperties, fromWasm: ExactMassProperties, label: string): void => {
    const inertiaScale = Math.max(...fromWasm.inertiaAtCentroid.map(Math.abs));
    const inertia = Math.max(
      ...fromNative.inertiaAtCentroid.map((value, k) => Math.abs(value - fromWasm.inertiaAtCentroid[k]!) / inertiaScale),
    );
    const deviations = [relative(fromNative.volume, fromWasm.volume), relative(fromNative.area, fromWasm.area), inertia];
    report.push(
      `${label}: volume ${fromWasm.volume.toPrecision(10)}, rel dV ${deviations[0]!.toExponential(1)} dA ${deviations[1]!.toExponential(1)} dI ${inertia.toExponential(1)}`,
    );
    expect(relative(fromNative.volume, fromWasm.volume), `${label} volume`).toBeLessThan(1e-6);
    expect(relative(fromNative.area, fromWasm.area), `${label} area`).toBeLessThan(1e-6);
    const span = Math.max(...fromWasm.bounds.max.map((value, k) => value - fromWasm.bounds.min[k]!), 1);
    for (let k = 0; k < 3; k++)
      expect(Math.abs(fromNative.centroid[k]! - fromWasm.centroid[k]!) / span, `${label} centroid`).toBeLessThan(1e-6);
    const scale = Math.max(...fromWasm.inertiaAtCentroid.map(Math.abs));
    fromNative.inertiaAtCentroid.forEach((value, index) => {
      expect(Math.abs(value - fromWasm.inertiaAtCentroid[index]!) / scale, `${label} inertia`).toBeLessThan(
        WASM_INERTIA_ERROR[label] ?? 1e-6,
      );
    });
  };

  /** Parity of one recipe; `refused`: both kernels must refuse it (any other WASM refusal fails the case). */
  const expectParity = async (label: string, recipe: ShapeRecipe, lower = true, refused = false): Promise<void> => {
    const handle = wasm.evaluate(recipe);
    const fromWasm = handle === null ? null : (wasm.massProperties?.(handle) ?? null);
    const fromNative = (await native('massProperties', recipe, lower)) as ExactMassProperties | null;
    expect(fromWasm === null, `${label}: WASM refusal`).toBe(refused);
    if (fromWasm === null) {
      expect(fromNative, `${label}: the WASM kernel refuses it`).toBeNull();
      return;
    }
    expect(fromNative, label).not.toBeNull();
    expectMassParity(fromNative!, fromWasm, label);
    const nativeAnalysis = (await native('analyze', recipe, lower)) as { valid: boolean; lumps: unknown[] };
    const wasmAnalysis = wasm.analyze?.(handle!);
    expect(nativeAnalysis.valid, `${label} validity`).toBe(wasmAnalysis?.valid);
    expect(nativeAnalysis.lumps.length, `${label} lumps`).toBe(wasmAnalysis?.lumps.length);
    const faces = faceCount(wasm.exportStep([handle!]));
    report.push(`  ${label}: ${faces} faces, valid ${String(wasmAnalysis?.valid)}`);
    expect(faceCount(await native('exportStep', recipe, lower)), `${label} faces`).toBe(faces);
  };

  it.each(SOLIDS)(
    '%s',
    async (label, solid) => {
      await expectParity(label, leaf(solid));
    },
    60_000,
  );

  it.each(NODES)(
    '%s',
    async (label, recipe) => {
      await expectParity(label, recipe);
    },
    60_000,
  );

  it.each(ROUNDED)(
    '%s: same edge numbering',
    async (label, recipe) => {
      await expectParity(label, recipe, false, label.includes('refused'));
    },
    60_000,
  );

  const featureRecipe = (step: unknown): ShapeRecipe => {
    const built = execute(createEmptyDocument(), 'build_project', { actions: [plate, step] }, { ...defaultContext(), kernel: wasm });
    expect(built.error).toBeUndefined();
    const id = built.document.order[0] as string;
    return recipeOf(built.document.entities[id] as Entity);
  };

  it.each(FEATURES)(
    'feature: %s',
    async (label, step) => {
      const recipe = featureRecipe(step);
      expect(recipe.op).toBe('feature');
      await expectParity(label, recipe);
    },
    120_000,
  );

  it('feature: modelled M6x1 thread (groove tool, no unify)', async () => {
    const recipe = featureRecipe(
      hole({
        hole: { kind: 'simple', diameter: 6 - 1.0825318, thread: { designation: 'M6x1-6H', modelled: true } },
        extent: { kind: 'through_all' },
      }),
    );
    await expectParity('modelled thread', recipe);
  }, 600_000);

  it('a sweep placed on a boolean keeps parity through the whole tree', async () => {
    const tube = SOLIDS.find(([label]) => label.startsWith('tube sweep'))![1];
    await expectParity('plate minus tube', booleanRecipe('subtract', box([-1, -1, 1], [4, 2, 2]), tube));
  }, 60_000);
});

describe.skipIf(binary === null)('second-slice nodes behind the synchronous proxy', () => {
  it('drills the floor of an open shell end to end (host lowering + native nodes)', () => {
    const kernel = createNativeKernel(binary!);
    try {
      expect(kernel.start()).toBe(true);
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
      const handle = kernel.evaluate(drilled);
      expect(kernel.massProperties?.(handle!)?.volume).toBeCloseTo(40 * 30 * 10 - 38 * 28 * 9 - Math.PI * 4, 6);
    } finally {
      kernel.dispose();
    }
  }, 120_000);
});
