/**
 * @layer server/tests
 * Live OpenCascade vs Manifold for lofts (BRepOffsetAPI_ThruSections) and variable-section sweeps
 * (BRepOffsetAPI_MakePipeShell): both kernels build a single closed solid and agree on volume and
 * bounds within the tessellation / blending tolerance.
 */

import { describe, it, expect } from 'vitest';
import type { CadDocument, Entity } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  box,
  booleanMesh,
  expectBoundsClose,
  liveKernels,
  meshOf,
  volume,
} from './kernelTestSupport';

const kernels = liveKernels();
const empty = createEmptyDocument();

function created(doc: CadDocument, name: string, params: Record<string, unknown>): Entity {
  const result = execute(doc, name, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as Entity;
}

function solidCount(entity: Entity): number {
  const shape = kernels.occt.evaluate({ op: 'solid', entity });
  expect(shape).not.toBeNull();
  return kernels.occt.topology(shape as NonNullable<typeof shape>)?.solids ?? 0;
}

function agree(entity: Entity, tolerance: number): { occt: number; manifold: number } {
  const occ = meshOf(kernels.occt, entity);
  const man = meshOf(kernels.manifold, entity);
  expect(occ).not.toBeNull();
  expect(man).not.toBeNull();
  const [o, m] = [volume(occ as NonNullable<typeof occ>), volume(man as NonNullable<typeof man>)];
  expect(o).toBeGreaterThan(0);
  expect(Math.abs(o / m - 1)).toBeLessThan(tolerance);
  expectBoundsClose(occ as NonNullable<typeof occ>, man as NonNullable<typeof man>, 0.15);
  return { occt: o, manifold: m };
}

describe('loft_sections on the live kernels', () => {
  it('a ruled loft between two circles is a frustum', () => {
    const cone = created(empty, 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 4], radius: 2 },
      ],
      ruled: true,
    });
    const frustum = (Math.PI * 4 * (1 + 2 + 4)) / 3;
    const { occt } = agree(cone, 0.03);
    expect(occt / frustum).toBeGreaterThan(0.97);
    expect(occt / frustum).toBeLessThan(1.01);
    expect(solidCount(cone)).toBe(1);
  });

  it('a smooth round-to-square-to-oval loft builds one solid in both kernels', () => {
    const duct = created(empty, 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        {
          center: [0, 0, 3],
          section: [
            [-1.2, -1.2],
            [1.2, -1.2],
            [1.2, 1.2],
            [-1.2, 1.2],
          ],
        },
        { center: [1, 0, 6], radiusX: 2, radiusY: 0.6, rotation: [0, 0.3, 0] },
      ],
    });
    agree(duct, 0.06);
    expect(solidCount(duct)).toBe(1);
  });
});

describe('variable-section sweep on the live kernels', () => {
  it('tapers and flattens a tube along a bent path', () => {
    const tube = created(empty, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [20, 0, 0],
        [20, 0, 15],
      ],
      bendRadius: 6,
      stations: [
        { at: 0, radius: 1.5 },
        { at: 0.5, radiusX: 1, radiusY: 2 },
        { at: 1, radius: 0.8 },
      ],
    });
    agree(tube, 0.08);
    expect(solidCount(tube)).toBe(1);
    const cut = booleanMesh(kernels.occt, 'subtract', tube, box([20, 0, 0], [6, 6, 6]));
    expect(cut).not.toBeNull();
  });
});

describe('closed-path sweeps on the live kernels', () => {
  it('a hollow ring along a circle sketch is one exact solid with the Pappus volume', () => {
    const doc = execute(empty, 'draw_arc', { center: [0, 0], radius: 30 }).document;
    const ring = created(doc, 'sweep_profile', {
      pathId: doc.order[0],
      radius: 4,
      innerRadius: 3,
    });
    const { occt } = agree(ring, 0.04);
    expect(occt / (2 * Math.PI * 30 * Math.PI * (16 - 9))).toBeGreaterThan(0.97);
    expect(solidCount(ring)).toBe(1);
  });

  it('a smooth 3D loop with a flat section closes and booleans cleanly', () => {
    const band = created(empty, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [40, 0, 8],
        [40, 40, 0],
        [0, 40, 8],
      ],
      closed: true,
      smooth: true,
      section: [
        [-3, -1],
        [3, -1],
        [3, 1],
        [-3, 1],
      ],
    });
    agree(band, 0.05);
    expect(
      booleanMesh(kernels.occt, 'subtract', band, box([40, 0, 4], [10, 10, 20])),
    ).not.toBeNull();
  });
});
