/**
 * Shared fixtures of the native `llull-kernel` suites (VC-KRN-25): the shape corpus (11 primitives, 4 boolean recipes) with the closed-form
 * exact volume and area of each, which are the expectations of the native suites (no second engine is run).
 */

import type { Entity, ShapeRecipe, Vec3 } from '@core/model/types';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { booleanRecipe, box, common, leaf } from './kernelTestSupport';

export const entity = (kind: string, fields: Record<string, unknown>, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Entity =>
  ({ id: kind, kind, position, rotation, ...common, ...fields }) as Entity;

export const PRIMITIVES: readonly [string, Entity][] = [
  ['box', box([1, 2, 3], [4, 5, 6])],
  ['rotated box', entity('box', { size: [4, 5, 6] }, [-2, 4, 1], [0.3, -0.5, 1.1])],
  ['cylinder', entity('cylinder', { radius: 2, height: 5 }, [5, -3, 2])],
  ['rotated cylinder', entity('cylinder', { radius: 1.5, height: 4 }, [0, 0, 0], [Math.PI / 2, 0, 0.4])],
  ['sphere', entity('sphere', { radius: 3 }, [1, 1, 1])],
  ['cone', entity('cone', { radius: 2, height: 6 })],
  ['torus', entity('torus', { ringRadius: 5, tubeRadius: 1 }, [0, 0, 2], [0.2, 0, 0])],
  ['wedge', entity('wedge', { size: [3, 4, 5] }, [1, 0, 0])],
  [
    'extrusion',
    entity('extrusion', {
      profile: [
        [0, 0],
        [4, 0],
        [4, 1],
        [1, 1],
        [1, 3],
        [0, 3],
      ],
      depth: 2,
    }),
  ],
  [
    'revolution',
    entity('revolution', {
      profile: [
        [1, 0],
        [2, 0],
        [2, 3],
        [1, 3],
      ],
      axis: [0, 0, 1],
      angle: Math.PI * 1.5,
      segments: 32,
    }),
  ],
  ['pyramid', entity('pyramid', { baseWidth: 4, baseDepth: 3, height: 5 }, [0, 0, 1])],
];

const cylinder = entity('cylinder', { radius: 1.2, height: 8 }, [1, 1, 0]);
export const plate = box([0, 0, 0], [6, 6, 2]);
export const BOOLEANS: readonly [string, ShapeRecipe][] = [
  ['union', booleanRecipe('union', plate, cylinder)],
  ['subtract', booleanRecipe('subtract', plate, cylinder)],
  ['intersect', booleanRecipe('intersect', plate, cylinder)],
  [
    'nested, placed and scaled',
    {
      op: 'scale',
      factor: 1.5,
      source: {
        op: 'place',
        position: [10, 0, 0],
        rotation: [0, 0, 0.7],
        source: booleanRecipe(
          'subtract',
          booleanRecipe('union', plate, box([2, 0, 1], [2, 2, 4])),
          entity('sphere', { radius: 1.5 }, [-2, 0, 1]),
        ),
      },
    },
  ],
];

/** Every primitive leaf and boolean recipe of the corpus, labelled. */
export const CORPUS: readonly [string, ShapeRecipe][] = [
  ...PRIMITIVES.map(([label, solid]): [string, ShapeRecipe] => [label, leaf(solid)]),
  ...BOOLEANS,
];

const { PI } = Math;

/** Exact `[volume, area]` of the corpus shapes, by closed form (the nested, placed and scaled recipe has none: its tests use scale laws). */
export const CLOSED_FORM: Readonly<Record<string, readonly [number, number]>> = {
  box: [120, 148],
  'rotated box': [120, 148],
  cylinder: [20 * PI, 28 * PI],
  'rotated cylinder': [9 * PI, 16.5 * PI],
  sphere: [36 * PI, 36 * PI],
  cone: [8 * PI, 4 * PI + 2 * PI * Math.sqrt(40)],
  torus: [10 * PI * PI, 20 * PI * PI],
  wedge: [30, 47 + 3 * Math.sqrt(41)],
  extrusion: [12, 40],
  revolution: [6.75 * PI, 18 * PI + 6],
  pyramid: [20, 12 + 4 * Math.sqrt(27.25) + 3 * Math.sqrt(29)],
  union: [72 + 8.64 * PI, 120 + 14.4 * PI],
  subtract: [72 - 2.88 * PI, 120 + 1.92 * PI],
  intersect: [2.88 * PI, 7.68 * PI],
};

export const handleOf = (recipe: ShapeRecipe): { key: string; recipe: ShapeRecipe } => ({ key: recipeKey(recipe), recipe });

export const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
