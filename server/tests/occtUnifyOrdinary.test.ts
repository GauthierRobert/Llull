/**
 * Live OpenCascade: post-boolean face merging (UnifySameDomain) is skipped only for results built from a modelled-thread groove tool.
 * An ordinary part with more than 600 pre-merge faces still merges its coplanar faces, so face and edge indices (persisted by fillets)
 * and a fillet along a merged edge are unchanged.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { booleanRecipe, box, common, leaf, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const COLUMNS = 20;
const ROWS = 17;
const PITCH = 9;

const pin = (x: number, y: number): Entity =>
  ({ id: 'd', kind: 'cylinder', position: [x, y, 8], rotation: [0, 0, 0], radius: 1, height: 6, ...common }) as unknown as Entity;

function union(tools: readonly ShapeRecipe[]): ShapeRecipe {
  const [first] = tools;
  if (tools.length === 1 && first !== undefined) return first;
  const middle = Math.ceil(tools.length / 2);
  return booleanRecipe('union', union(tools.slice(0, middle)), union(tools.slice(middle)));
}

/** 200 x 200 x 10 plate with 340 blind holes (686 faces before and after any merge: nothing coplanar to merge yet). */
function holedPlate(): ShapeRecipe {
  const tools = Array.from({ length: COLUMNS * ROWS }, (_, index) =>
    leaf(pin(10 + PITCH * (index % COLUMNS), 10 + PITCH * Math.floor(index / COLUMNS))),
  );
  return booleanRecipe('subtract', box([100, 100, 5], [200, 200, 10]), union(tools));
}

describe('occt unify after booleans of ordinary parts', () => {
  it('merges the coplanar faces of a >600-face result and a fillet on a merged edge index rounds the whole edge', () => {
    const occt = kernels.occt;
    const plate = occt.evaluate(holedPlate());
    expect(plate).not.toBeNull();
    const plateFaces = occt.topology(plate!)?.faces.length ?? 0;
    expect(plateFaces).toBeGreaterThan(600);

    const extended = booleanRecipe('union', holedPlate(), box([300, 100, 5], [200, 200, 10]));
    const fused = occt.evaluate(extended);
    expect(fused).not.toBeNull();
    const topology = occt.topology(fused!);
    expect(topology?.faces.length).toBe(plateFaces);

    const edge = topology?.edges.find(
      (candidate) => Math.abs(candidate.length - 400) < 1e-6 && Math.abs(candidate.mid[1]) < 1e-6 && candidate.mid[2] > 9.99,
    );
    expect(edge).toBeDefined();
    const rounded = occt.evaluate({ op: 'fillet', source: extended, edges: [edge!.index], size: 1 });
    expect(rounded).not.toBeNull();
    const lost = (topology?.volume ?? 0) - (occt.topology(rounded!)?.volume ?? 0);
    expect(Math.abs(lost - (1 - Math.PI / 4) * 400)).toBeLessThan(1);
  }, 600_000);
});
