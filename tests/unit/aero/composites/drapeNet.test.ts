import { describe, expect, it } from 'vitest';
import type { CompositePart, PartSurface } from '@core/model/composites';
import type { Vec3 } from '@core/model/types';
import { sphereOutline } from '@aero/composites/curved';
import { buildNet, type DrapeNet } from '@aero/composites/drape/net';
import { summarizeShear } from '@aero/composites/drape/shear';
import { drapeSurfaceOf } from '@aero/composites/drape/surfaceQuery';
import { pack } from './fixtures';

interface HemisphereCase {
  d_mm: number;
  interior_nodes_on_hemisphere: number;
  interior_nodes_over_shear_limit: Record<string, number>;
  max_shear_deg_on_hemisphere: number;
  diagonal: { i: number; polar_angle_deg: number; shear_deg: number }[];
  gauss_bonnet_checks: { i: number; polar_angle_deg: number; shear_deg: number; K_times_area_deg: number }[];
}

const R = 100;
const SPHERE: PartSurface = { type: 'sphere', center: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: R };
const partOf = (surface: PartSurface, outline: CompositePart['outline']): CompositePart => ({ surface, outline }) as CompositePart;
const hemisphere = partOf(SPHERE, sphereOutline(SPHERE as Extract<PartSurface, { type: 'sphere' }>, 0.05));

const polarDeg = (p: Vec3): number => (Math.acos(Math.max(-1, Math.min(1, p[2] / R))) * 180) / Math.PI;

function drape(d: number, lockingAngle?: number): DrapeNet {
  const surface = drapeSurfaceOf(hemisphere);
  const seed = surface.project([0, 0, R]);
  if (seed === null) throw new Error('no seed');
  return buildNet(surface, { d, seed, warp: [1, 0, 0], lockingAngle, allowOverLock: true, extent: 2 * R * Math.PI });
}

describe('hemisphere fishnet drape against the pin-jointed-net reference (VC-CMP-12 / 13)', () => {
  const reference = pack<{ hemisphere_pin_jointed_net: HemisphereCase[] }>('drape_reference.json').hemisphere_pin_jointed_net;

  for (const d of [4, 2]) {
    it(`d = ${d} mm reproduces the diagonal shear profile and the over-limit counts`, () => {
      const expected = reference.find((c) => c.d_mm === d) as HemisphereCase;
      const net = drape(d);
      for (const row of expected.diagonal.slice(0, 30)) {
        const node = net.get(row.i, row.i);
        expect(node, `node ${row.i},${row.i}`).toBeDefined();
        expect(node?.shear).toBeCloseTo(row.shear_deg, 2);
        expect(polarDeg(node?.hit.point as Vec3)).toBeCloseTo(row.polar_angle_deg, 2);
      }
      const quadrant = [...net.nodes.values()].filter((n) => n.i > 0 && n.j > 0 && n.hit.point[2] >= -1e-9);
      expect(quadrant.length).toBe(expected.interior_nodes_on_hemisphere);
      expect(Math.max(...quadrant.map((n) => n.shear))).toBeCloseTo(expected.max_shear_deg_on_hemisphere, 2);
      for (const [limit, count] of Object.entries(expected.interior_nodes_over_shear_limit))
        expect(quadrant.filter((n) => n.shear > Number.parseInt(limit, 10)).length).toBe(count);
    });
  }

  it('d = 1 mm meets the VC-CMP-12 tolerances (diagonal 15.726, maximum 51.894, Gauss-Bonnet, symmetry)', () => {
    const net = drape(1);
    const quadrant = [...net.nodes.values()].filter((n) => n.i > 0 && n.j > 0 && n.hit.point[2] >= -1e-9);
    const expected = reference.find((c) => c.d_mm === 1) as HemisphereCase;
    expect(net.get(53, 53)?.shear).toBeCloseTo(15.7259, 0);
    expect(Math.abs((net.get(53, 53)?.shear ?? 0) - 15.7259)).toBeLessThan(0.6);
    expect(Math.abs(Math.max(...quadrant.map((n) => n.shear)) - 51.8937)).toBeLessThan(1);
    for (const check of expected.gauss_bonnet_checks)
      expect(Math.abs((net.get(check.i, check.i)?.shear ?? 0) - check.K_times_area_deg)).toBeLessThan(0.5);
    const fractions = [30, 40, 50].map((limit) => quadrant.filter((n) => n.shear > limit).length / quadrant.length);
    [0.2149, 0.0852, 0.0053].forEach((fraction, k) => expect(Math.abs((fractions[k] as number) - fraction)).toBeLessThan(0.01));
    const summary = summarizeShear(net, { warning: 30, lock: 40 });
    expect(summary.maxShearDeg).toBeGreaterThan(51);
    expect(summary.nodesOverLock).toBeGreaterThan(0);
  });
});
