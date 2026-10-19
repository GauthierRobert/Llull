/**
 * Pocket floor fillet on the native `llull-kernel` (LC1 step 5): the sidecar selects the floor edges on the topology of the cut (floor plane
 * + outline / island curves, `recipe/floor.rs`) and fillets them, with no WASM kernel involved. Closed forms: the Pappus volume of the fillet
 * material swept along a rounded-square floor, and the VC-FTR-27 PK-01 / PK-02 removed volumes of the 07 validation pack.
 * Skipped without the binary unless LLULL_REQUIRE_NATIVE_KERNEL=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { createNativeKernel } from '../src/nativeKernel';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';

const binary = nativeBinaryPath('llull-kernel');
if (binary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));

const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
const { PI } = Math;

describe.skipIf(binary === null)('native pocket floor fillet', () => {
  let native: IsolatedKernel;
  beforeAll(() => {
    native = createNativeKernel(binary!, { callTimeoutMs: 120_000 });
    expect(native.start()).toBe(true);
  }, 120_000);
  afterAll(() => native.dispose());

  const volumeOf = (kernel: GeometryKernel, recipe: ShapeRecipe): number => {
    const shape = kernel.evaluate(recipe);
    expect(shape).not.toBeNull();
    return kernel.massProperties?.(shape!)?.volume ?? Number.NaN;
  };

  const slab = {
    id: 'slab',
    kind: 'box',
    size: [10, 10, 2],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#888888',
  } as Entity;

  /** A 4 x 4 pocket (corner radius 1) in the top face (z = 1) of a 10 x 10 x 2 slab. */
  const pocket = (depth: number | 'through', floorFillet: number): ShapeRecipe =>
    ({
      op: 'feature',
      feature: 'pocket',
      source: { op: 'solid', entity: slab },
      frame: { origin: [0, 0, 1], normal: [0, 0, 1], xDir: [1, 0, 0] },
      pocket: {
        outline: [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ],
        cornerRadius: 1,
        depth,
        floorFillet,
      },
    }) as ShapeRecipe;

  it('adds the Pappus volume of the fillet material along the rounded-square floor', () => {
    const [radius, corner] = [0.5, 1];
    const section = (1 - PI / 4) * radius ** 2;
    const straight = 4 * (4 - 2 * corner) * section;
    const arcs = 2 * PI * (radius ** 2 * (corner - radius / 2) - ((PI * radius ** 2) / 4) * (corner - radius) - radius ** 3 / 3);
    const pocketVolume = 1 * (16 - (4 - PI) * corner ** 2);
    expect(volumeOf(native, pocket(1, 0))).toBeCloseTo(200 - pocketVolume, 6);
    expect(rel(volumeOf(native, pocket(1, radius)), 200 - pocketVolume + straight + arcs)).toBeLessThan(1e-6);
  }, 120_000);

  it('refuses a floor fillet when the pocket has no floor on the part (a through pocket)', () => {
    expect(native.evaluate(pocket('through', 0.5))).toBeNull();
    expect(volumeOf(native, pocket('through', 0))).toBeCloseTo(200 - 2 * (16 - (4 - PI)), 6);
  }, 120_000);

  it.each([
    ['PK-01', 0, 3931.327412287],
    ['PK-02', 1.5, 3877.71730193],
  ])(
    'VC-FTR-27 %s: the plate pocket (floor fillet %d) removes the analytic volume',
    (_id, floorFillet, removed) => {
      const ctx = { ...defaultContext(), kernel: native };
      const plate = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 10], position: [0, 0, 0], anchor: 'min' });
      const cut = execute(
        plate.document,
        'add_pocket',
        {
          target: plate.affected[0],
          face: { near: [50, 30, 10] },
          outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
          depth: 5,
          cornerRadius: 4,
          floorFillet,
          toolDiameter: 8,
        },
        ctx,
      );
      expect(cut.error).toBeUndefined();
      const id = cut.document.order[0] as string;
      expect(rel(60000 - volumeOf(native, recipeOf(cut.document.entities[id] as Entity)), removed)).toBeLessThan(1e-6);
    },
    120_000,
  );
});
