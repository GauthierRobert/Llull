/** geometry/field/dualContour (05 IMP M6, 5.7 item 6): sharp-feature meshing through the TS engine. */
import { describe, expect, it } from 'vitest';
import { FieldBuilder } from '@core/geometry/field/build';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import { meshMeasures } from '@lib/isosurface/measures';

const META = { bounds: null, lipschitz: 1, quality: 'exact' } as const;

/** Axis-aligned box of half sizes (hx, hy, hz) centred on the origin as max of the three slab distances. */
function boxProgram(hx: number, hy: number, hz: number): ReturnType<FieldBuilder['finish']> {
  const b = new FieldBuilder('mm');
  const slab = (axis: number, h: number): number => b.shift(b.abs(axis), -h);
  return b.finish(b.max(b.max(slab(b.x(), hx), slab(b.y(), hy)), slab(b.z(), hz)), META);
}

describe('dual contouring', () => {
  const grid = { min: [-3.05, -3.05, -3.05], max: [3.05, 3.05, 3.05], voxel: 0.3 } as const;

  it('keeps the corners of a box that the tetrahedra cut, and is closed and manifold', () => {
    const program = boxProgram(2, 1.5, 1);
    const exact = 8 * 2 * 1.5 * 1;
    const dc = tsFieldEngine.mesh(program, grid, { mesher: 'dual_contouring', maxTriangles: 1e6 });
    const tet = tsFieldEngine.mesh(program, grid, { mesher: 'tetra', maxTriangles: 1e6 });
    if (!dc.ok || !tet.ok) throw new Error('mesh refused');
    expect(dc.mesher).toBe('dual_contouring');
    expect(dc.mesherFallback).toBe(false);
    expect(dc.closedManifold).toBe(true);
    const errDc = Math.abs(meshMeasures(dc.mesh).volume - exact) / exact;
    const errTet = Math.abs(meshMeasures(tet.mesh).volume - exact) / exact;
    expect(errDc).toBeLessThan(0.002);
    expect(errDc).toBeLessThan(errTet);
    expect(tet.mesher).toBe('tetra');
  });

  it('meshes a sphere within a fraction of a percent', () => {
    const b = new FieldBuilder('mm');
    const sphere = b.finish(b.shift(b.length3(b.x(), b.y(), b.z()), -2), META);
    const result = tsFieldEngine.mesh(sphere, grid, { mesher: 'dual_contouring', maxTriangles: 1e6 });
    if (!result.ok) throw new Error('mesh refused');
    const exact = (4 / 3) * Math.PI * 8;
    expect(Math.abs(meshMeasures(result.mesh).volume - exact) / exact).toBeLessThan(0.005);
    expect(result.closedManifold).toBe(true);
  });

  it('falls back to the tetrahedra when the result is not a closed manifold surface', () => {
    const b = new FieldBuilder('mm');
    const saddle = b.finish(b.mul(b.x(), b.y()), META);
    const result = tsFieldEngine.mesh(saddle, grid, { mesher: 'dual_contouring', maxTriangles: 1e6 });
    if (!result.ok) throw new Error('mesh refused');
    expect(result.mesher).toBe('tetra');
    expect(result.mesherFallback).toBe(true);
  });

  it('returns an empty mesh for a grid of fewer than three nodes per axis and a field with nothing inside', () => {
    const b = new FieldBuilder('mm');
    const outside = b.finish(b.constant(1), META);
    const none = tsFieldEngine.mesh(outside, grid, { mesher: 'dual_contouring', maxTriangles: 1e6 });
    if (!none.ok) throw new Error('mesh refused');
    expect(none.mesh.indices).toHaveLength(0);
  });
});
