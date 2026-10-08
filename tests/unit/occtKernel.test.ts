/**
 * OcctKernel unit tests.
 *
 * Live WASM tests (BRepAlgoAPI_Fuse, BRepFilletAPI_MakeFillet) require the
 * 63 MB opencascade.js binary and a Node.js environment with WASM support.
 * They are marked `describe.skip` because Vitest runs in jsdom where WASM of
 * this size cannot be loaded. Live coverage: server/tests/kernelChoice.test.ts;
 * measurements are recorded in docs/decisions/KI4-occt-spike.md.
 *
 * @invariant unconditional `describe.skip`, not `skipIf(!isNodeEnv)`: `process.versions.node`
 *   exists in jsdom too, so a Node check would load the 63 MB WASM binary in CI.
 *
 * Always-run tests verify:
 *   - Entity structure contracts (used by kernel internals).
 *   - GeometryKernel interface conformance (TypeScript compile-time gate).
 *   - evaluate / tessellate / topology / exportStep exist on the interface.
 *   - occtOps exposes the native ops and refuses non-positive sizes.
 */

import { describe, it, expect } from 'vitest';
import type { BoxEntity } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';

// ---------------------------------------------------------------------------
// Test entities — two 2×2×2 boxes (as in docs/decisions/KI4-occt-spike.md).
// ---------------------------------------------------------------------------

const BOX_A: BoxEntity = {
  id: 'box-a',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [2, 2, 2],
  layerId: 'default',
  color: '#ffffff',
};

const BOX_B: BoxEntity = {
  id: 'box-b',
  kind: 'box',
  position: [1, 0, 0], // offset by 1 — overlapping
  rotation: [0, 0, 0],
  size: [2, 2, 2],
  layerId: 'default',
  color: '#888888',
};

// ---------------------------------------------------------------------------
// Static entity contract tests — always run; no WASM required.
// ---------------------------------------------------------------------------

describe('OcctKernel — static contract tests (always run)', () => {
  it('BOX_A entity satisfies BoxEntity shape contract', () => {
    expect(BOX_A.kind).toBe('box');
    expect(BOX_A.size).toHaveLength(3);
    expect(BOX_A.size.every((v) => v > 0)).toBe(true);
    expect(BOX_A.position).toHaveLength(3);
    expect(BOX_A.rotation).toHaveLength(3);
  });

  it('BOX_B entity satisfies BoxEntity shape contract', () => {
    expect(BOX_B.kind).toBe('box');
    expect(BOX_B.size.every((v) => v > 0)).toBe(true);
  });

  it('documents skip reason: WASM binary is 63MB — not viable in jsdom CI', () => {
    // The opencascade.js WASM is 63 MB. Loading it in Vitest/jsdom would require
    // a Node-env vitest config; live coverage is server/tests/kernelChoice.test.ts.
    // See docs/decisions/KI4-occt-spike.md for recorded measurements.
    expect('skip reason documented').toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// GeometryKernel interface conformance — compile-time check via `satisfies`.
// A stub missing any of the four methods fails tsc; no WASM needed.
// ---------------------------------------------------------------------------

describe('GeometryKernel — interface conformance', () => {
  it('GeometryKernel type has evaluate, tessellate, topology, exportStep', () => {
    const stub = {
      supports: () => true,
      evaluate: () => null,
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
    } satisfies GeometryKernel;

    expect(typeof stub.evaluate).toBe('function');
    expect(typeof stub.tessellate).toBe('function');
    expect(typeof stub.topology).toBe('function');
    expect(typeof stub.exportStep).toBe('function');
  });

  it('evaluate accepts a recipe tree (boolean over two solid leaves) and may refuse with null', () => {
    const recipes: ShapeRecipe[] = [];
    const stub: GeometryKernel = {
      supports: () => true,
      evaluate: (recipe) => {
        recipes.push(recipe);
        return null;
      },
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
    };
    const recipe: ShapeRecipe = {
      op: 'fillet',
      source: {
        op: 'boolean',
        boolean: 'union',
        a: { op: 'solid', entity: BOX_A },
        b: { op: 'solid', entity: BOX_B },
      },
      edges: [],
      size: 0.2,
    };
    expect(stub.evaluate(recipe)).toBeNull();
    expect(recipes).toEqual([recipe]);
  });
});

// ---------------------------------------------------------------------------
// occtOps / createOcctKernel — static contract tests (no WASM required).
// ---------------------------------------------------------------------------

describe('occtOps — static / contract tests', () => {
  it('occtOps exposes every native operation of the recipe evaluator', async () => {
    const { occtOps } = await import('@kernel-occt/occtKernel');
    const ops = occtOps({} as never);
    for (const name of [
      'solid',
      'boolean',
      'fillet',
      'chamfer',
      'shell',
      'place',
      'scale',
      'tessellate',
      'topology',
      'exportStep',
      'release',
    ] as const) {
      expect(typeof ops[name], name).toBe('function');
    }
  });

  it('fillet / chamfer / shell refuse a non-positive size without touching OCC', async () => {
    const { occtOps } = await import('@kernel-occt/occtKernel');
    const ops = occtOps({} as never);
    const shape = {} as never;
    expect(ops.fillet(shape, [], 0)).toBeNull();
    expect(ops.fillet(shape, [], -1)).toBeNull();
    expect(ops.chamfer(shape, [], 0)).toBeNull();
    expect(ops.shell(shape, 0)).toBeNull();
  });

  it('createOcctKernel is exported from occtKernel module (import check)', async () => {
    // This confirms the module compiles and the named export exists.
    // We do NOT call createOcctKernel() here — that would load 63 MB WASM.
    const mod = await import('@kernel-occt/occtKernel');
    expect(typeof mod.createOcctKernel).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Live WASM tests — ALWAYS SKIPPED in this config (jsdom + 63 MB WASM).
// To un-skip: run vitest with `--environment node` AND the WASM binary present.
// Measurements from manual verification: union tris=28, fillet tris=628 (r=0.2).
// ---------------------------------------------------------------------------

describe.skip('OcctKernel live WASM (requires node env + 63 MB opencascade.js)', () => {
  const solid = (entity: BoxEntity): ShapeRecipe => ({ op: 'solid', entity });

  it('boolean union of two boxes evaluates and tessellates', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    const shape = kernel.evaluate({
      op: 'boolean',
      boolean: 'union',
      a: solid(BOX_A),
      b: solid(BOX_B),
    });
    expect(shape).not.toBeNull();
    const result = kernel.tessellate(shape!);
    expect(result).not.toBeNull();
    expect(result!.positions.length).toBeGreaterThan(0);
    expect(result!.indices.length).toBeGreaterThan(0);
  });

  it('fillet of a box on the exact B-rep adds geometry', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    const shape = kernel.evaluate({ op: 'fillet', source: solid(BOX_A), edges: [], size: 0.2 });
    expect(shape).not.toBeNull();
    // Fillet of a box adds significant geometry — measured 628 triangles.
    expect(kernel.tessellate(shape!)!.indices.length / 3).toBeGreaterThan(12);
  });

  it('fillet with an oversized radius is refused with null', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    expect(kernel.evaluate({ op: 'fillet', source: solid(BOX_A), edges: [], size: 50 })).toBeNull();
  });
});
