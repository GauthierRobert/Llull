/** Host side of the native kernel's second slice: freeform leaves (`kernelLeaves.ts`) and feature lowering (`kernelFeatures.ts`). Pure. */

import { describe, expect, it } from 'vitest';
import type { CurveSegment } from '@core/model/curve';
import type { Entity, MeshData, ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { boxCage } from '@core/geometry/subdivision';
import { encodeChain, nativeLeaf, orientedChain } from '../src/native/kernelLeaves';
import { prepareFeatures, type SourceMesher } from '../src/native/kernelFeatures';
import { nativeRecipe } from '../src/native/kernelProtocol';
import { box, common, leaf } from './kernelTestSupport';

const entity = (kind: string, fields: Record<string, unknown>): Entity =>
  ({ id: kind, kind, position: [0, 0, 0], rotation: [0, 0, 0], ...common, ...fields }) as Entity;

const square: CurveSegment<Vec2>[] = [
  {
    type: 'line',
    points: [
      [0, 0],
      [1, 0],
    ],
  },
  {
    type: 'arc',
    points: [
      [1, 0],
      [1.5, 0.5],
      [1, 1],
    ],
  },
  {
    type: 'bezier',
    points: [
      [1, 1],
      [0.6, 1.2],
      [0.3, 1.2],
      [0, 1],
    ],
  },
  {
    type: 'line',
    points: [
      [0, 1],
      [0, 0],
    ],
  },
];
const lift = ([x, y]: Vec2): Vec3 => [x, y, 0];

describe('native leaves', () => {
  it('encodes chains as type code + points', () => {
    expect(
      encodeChain([
        {
          type: 'line',
          points: [
            [0, 0, 0],
            [1, 2, 3],
          ],
        },
      ]),
    ).toEqual([0, 0, 0, 0, 1, 2, 3]);
    expect(orientedChain(square, lift, true).slice(0, 7)).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });

  it('reverses a chain whose winding disagrees, like occtCurves.ts chainFace', () => {
    const clockwise = orientedChain(square, lift, false);
    expect(clockwise.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(clockwise.length).toBe(orientedChain(square, lift, true).length);
  });

  it('keeps polygon solids and turns exact curves into an oriented chain', () => {
    const plain = entity('extrusion', {
      profile: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      depth: 1,
    });
    expect(nativeLeaf(plain)).toBe(plain);
    const curved = nativeLeaf(
      entity('extrusion', {
        profile: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        curves: square,
        depth: 1,
      }),
    ) as unknown as Record<string, unknown>;
    expect(curved['curves']).toBeUndefined();
    expect(curved['chain']).toEqual(orientedChain(square, lift, true));
    const revolved = nativeLeaf(entity('revolution', { profile: [], curves: square, axis: [0, 1, 0], angle: 1, segments: 8 }));
    expect((revolved as unknown as { chain: number[] }).chain.slice(0, 7)).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });

  it('sends loft, sweep and subdivision payloads', () => {
    const ring: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ];
    const loft = nativeLeaf(entity('loft', { rings: [ring, ring.map(([x, y]): Vec3 => [x, y, 2])], ruled: true })) as unknown as {
      native: { chains: number[][]; ruled: boolean };
    };
    expect(loft.native.chains).toHaveLength(2);
    expect(loft.native.chains[0]).toHaveLength(4 * 13);
    expect(loft.native.ruled).toBe(true);
    const path = [
      {
        type: 'line',
        points: [
          [0, 0, 0],
          [0, 0, 2],
        ],
      },
    ];
    const tube = nativeLeaf(entity('sweep', { path, section: { shape: 'circle', radius: 1 } })) as unknown as {
      native: Record<string, unknown>;
    };
    expect(tube.native).toEqual({ spine: [0, 0, 0, 0, 0, 0, 2], circle: { center: [0, 0, 0], normal: [0, 0, 1], radius: 1 } });
    const ring2 = ring.map(([x, y]): Vec2 => [x, y]);
    const varying = nativeLeaf(
      entity('sweep', {
        path,
        section: { shape: 'circle', radius: 1 },
        stations: [
          { at: 0, ring: ring2 },
          { at: 1, ring: ring2 },
        ],
      }),
    );
    expect((varying as unknown as { native: { rings: number[][] } }).native.rings).toHaveLength(9);
    const faceted = nativeLeaf(entity('subdivision', { ...boxCage([1, 1, 1], [1, 1, 1]), levels: 0 })) as unknown as {
      native: Record<string, unknown>;
    };
    expect(Object.keys(faceted.native)).toEqual(['triangles']);
    const smooth = nativeLeaf(entity('subdivision', { ...boxCage([1, 1, 1], [1, 1, 1]), levels: 1 })) as unknown as {
      native: { patches: number[] };
    };
    expect(smooth.native.patches.length % 48).toBe(0);
  });
});

const hole = (fields: Record<string, unknown>): ShapeRecipe =>
  ({
    op: 'feature',
    feature: 'hole',
    source: leaf(box([0, 0, 0], [10, 10, 2])),
    frame: { origin: [0, 0, 1], normal: [0, 0, 1], xDir: [1, 0, 0] },
    points: [[0, 0]],
    hole: { kind: 'simple', diameter: 1 },
    extent: { kind: 'through_all' },
    ...fields,
  }) as ShapeRecipe;
const pocket = (fields: Record<string, unknown>): ShapeRecipe =>
  ({
    op: 'feature',
    feature: 'pocket',
    source: leaf(box([0, 0, 0], [10, 10, 2])),
    frame: { origin: [0, 0, 1], normal: [0, 0, 1], xDir: [1, 0, 0] },
    pocket: {
      outline: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      cornerRadius: 0.2,
      depth: 0.5,
      floorFillet: 0,
      ...fields,
    },
  }) as ShapeRecipe;

const slab: MeshData = { positions: [0, 0, 1, 0, 0, -1, 1, 0, -1], indices: [0, 1, 2] };
const meshes =
  (answer: MeshData | null | 'unsupported'): SourceMesher =>
  () =>
    Promise.resolve(answer);

describe('native feature lowering', () => {
  it('lowers a through hole with the reach of the source mesh and BRepFeat inputs', async () => {
    const recipe = hole({});
    const prepared = await prepareFeatures('evaluate', [recipe], meshes(slab));
    if (!('features' in prepared)) throw new Error('expected lowerings');
    const cut = nativeRecipe(recipe, prepared.features) as unknown as Record<string, unknown>;
    expect(cut).toMatchObject({ op: 'featureCut', mode: 'subtract', holes: { origins: [[0, 0, 1]], normal: [0, 0, 1] } });
    const profile = (cut['holes'] as { profiles: number[][] }).profiles[0]!;
    expect(Math.min(...profile.filter((_, k) => k % 3 === 2))).toBeLessThan(-1);
  });

  it('sends the floor-selection inputs of a floor-filleted pocket, and fillets / chamfers native', async () => {
    const filleted = pocket({ floorFillet: 0.1 });
    const prepared = await prepareFeatures('massProperties', [{ key: 'k', recipe: filleted }], meshes(slab));
    if (!('features' in prepared)) throw new Error('floor-filleted pocket should lower natively');
    const cut = nativeRecipe(filleted, prepared.features) as unknown as { floorFillet: Record<string, unknown> };
    expect(cut.floorFillet).toMatchObject({ radius: 0.1, floorDepth: 0.5, origin: [0, 0, 1], normal: [0, 0, 1], xDir: [1, 0, 0] });
    expect(cut.floorFillet['outlines']).toHaveLength(1);
    const plain = nativeRecipe(
      pocket({}),
      ((await prepareFeatures('massProperties', [{ key: 'k', recipe: pocket({}) }], meshes(slab))) as { features: never }).features,
    );
    expect(plain).not.toHaveProperty('floorFillet');
    const source = leaf(box([0, 0, 0], [1, 1, 1]));
    for (const recipe of [
      { op: 'fillet', source, edges: [], size: 0.1 },
      { op: 'chamfer', source, edges: [0], size: 0.1 },
    ])
      expect(await prepareFeatures('massProperties', [{ key: 'k', recipe }], meshes(slab))).toHaveProperty('features');
  });

  it('lowers without BRepFeat inputs where the WASM kernel does (many holes, modelled thread, islands, rib)', async () => {
    const many = hole({ points: Array.from({ length: 9 }, (_, i) => [i - 4, 0]) });
    const island = pocket({
      islands: [
        [
          [-0.2, -0.2],
          [0.2, -0.2],
          [0.2, 0.2],
          [-0.2, 0.2],
        ],
      ],
    });
    const rib = {
      ...pocket({}),
      feature: 'rib',
      rib: {
        path: [
          [-1, 0],
          [1, 0],
        ],
        thickness: 0.2,
        height: 1,
        symmetric: true,
      },
    } as ShapeRecipe;
    for (const recipe of [many, island, rib]) {
      const prepared = await prepareFeatures('exportStep', [[{ key: 'k', recipe }]], meshes(slab));
      if (!('features' in prepared)) throw new Error('expected lowerings');
      const cut = nativeRecipe(recipe, prepared.features) as unknown as Record<string, unknown>;
      expect(cut['op']).toBe('featureCut');
      expect(cut['holes'] ?? cut['pocket']).toBeUndefined();
      expect(cut['tool']).not.toBeNull();
    }
    const blind = pocket({});
    const prepared = await prepareFeatures('evaluate', [blind], meshes('unsupported'));
    expect('features' in prepared && (nativeRecipe(blind, prepared.features) as unknown as { pocket: unknown }).pocket).toBeTruthy();
  });

  it('refuses when the source does not mesh, and defers to WASM when the sidecar cannot build the source', async () => {
    const recipe = hole({});
    const refused = await prepareFeatures('evaluate', [recipe], meshes(null));
    if (!('features' in refused)) throw new Error('expected lowerings');
    expect(nativeRecipe(recipe, refused.features)).toMatchObject({ op: 'featureCut', tool: null });
    expect(await prepareFeatures('evaluate', [recipe], meshes('unsupported'))).toEqual({
      unsupported: 'NATIVE_UNSUPPORTED: feature source not native',
    });
    expect(nativeRecipe(recipe)).toMatchObject({ op: 'feature' });
  });
});
