import { describe, expect, it } from 'vitest';
import refs from '../../../../docs/plant/03-parametric-equipment/validation/data/head_geometry_references.json';
import { headInsideArea, headVolume, resolveHead, torisphericalGeometry, type HeadShape } from '@aec/plant/equipment/geometry/heads';
import { headMetalVolume } from '@aec/plant/equipment/geometry/headOffset';
import { integrate } from '@aec/plant/equipment/geometry/gaussLegendre';
import { HEAD_STANDARDS } from '@aec/plant/equipment/data/headStandards';
import type { HeadSpec } from '@aec/plant/equipment/model';

const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

function shape(spec: HeadSpec, radius: number): HeadShape {
  const head = resolveHead(spec, radius, 'head');
  if ('error' in head) throw new Error(head.error);
  return head.shape;
}

describe('VC-EQP-03 head depths and full volumes', () => {
  it('torispherical depths of the published cases', () => {
    for (const row of refs.depthCases) {
      const geometry = torisphericalGeometry(row.D / 2, row.f * row.D, row.k * row.D);
      expect(rel(geometry.crownDepth + geometry.knuckleDepth, row.depth), row.id).toBeLessThan(1e-9);
    }
  });

  const full: Record<string, HeadSpec> = {
    '2:1 ellipsoidal': { type: 'ellipsoidal', ratio: 2 },
    hemispherical: { type: 'hemispherical' },
    'ASME F&D (f=1, k=0.06)': { type: 'torispherical', standard: 'asme_fd' },
    'ASME 80/10 (f=0.8, k=0.1)': { type: 'torispherical', standard: 'asme_80_10' },
    'DIN 28011 (f=1, k=0.1)': { type: 'torispherical', standard: 'din_28011' },
    'DIN 28013 (f=0.8, k=0.154)': { type: 'torispherical', standard: 'din_28013' },
  };
  for (const row of refs.fullHeadVolumeD1m.rows) {
    it(`${row.name}: depth and volume for D = 1 m`, () => {
      const head = shape(full[row.name] as HeadSpec, 0.5);
      expect(rel(head.depth, row.depth_m)).toBeLessThan(1e-9);
      expect(rel(headVolume(head, 0.5), row.V_m3)).toBeLessThan(1e-9);
    });
  }

  it('depth scales with D and volume with D^3', () => {
    const unit = shape({ type: 'torispherical', standard: 'asme_fd' }, 0.5);
    const big = shape({ type: 'torispherical', standard: 'asme_fd' }, 1.25);
    expect(rel(big.depth, unit.depth * 2.5)).toBeLessThan(1e-12);
    expect(rel(headVolume(big, 1.25), headVolume(unit, 0.5) * 2.5 ** 3)).toBeLessThan(1e-12);
  });

  it('conical depth from the half angle, flat head has no depth or volume', () => {
    const cone = shape({ type: 'conical', halfAngleDeg: 45 }, 1);
    expect(cone.depth).toBeCloseTo(1, 12);
    expect(headVolume(cone, 1)).toBeCloseTo(Math.PI / 3, 12);
    const flat = shape({ type: 'flat' }, 1);
    expect(flat.depth).toBe(0);
    expect(headVolume(flat, 1)).toBe(0);
    expect(headInsideArea(flat, 1)).toBeCloseTo(Math.PI, 12);
    expect(headInsideArea(cone, 1)).toBeCloseTo(Math.PI * Math.SQRT2, 12);
  });
});

describe('VC-EQP-04 head surface areas', () => {
  for (const row of refs.surfaceArea.rows.filter((r) => r.id !== 'H-SA-4')) {
    it(`${row.id} ${row.shape}`, () => {
      const head: HeadShape = { kind: 'ellipsoidal', depth: row.a ?? 0 };
      expect(rel(headInsideArea(head, row.D / 2), row.SA)).toBeLessThan(1e-9);
    });
  }

  it('H-SA-4 torispherical (grade B: documented, loose band)', () => {
    const row = refs.surfaceArea.rows.find((r) => r.id === 'H-SA-4');
    const head = shape({ type: 'torispherical', crownRadius: (row?.f ?? 0) * 2.54, knuckleRadius: (row?.k ?? 0) * 2.54 }, 1.27);
    expect(rel(headInsideArea(head, 1.27), row?.SA ?? 1)).toBeLessThan(1e-6);
  });

  it('torispherical area equals the numerical profile integral', () => {
    const radius = 0.75;
    const head = shape({ type: 'torispherical', standard: 'din_28013' }, radius);
    if (head.kind !== 'torispherical') throw new Error('kind');
    const { crownRadius: rc, knuckleRadius: rk, alpha } = head;
    const crown = integrate((theta) => 2 * Math.PI * rc * Math.sin(theta) * rc, 0, alpha);
    const knuckle = integrate((theta) => 2 * Math.PI * (radius - rk + rk * Math.sin(theta)) * rk, alpha, Math.PI / 2);
    expect(rel(headInsideArea(head, radius), crown + knuckle)).toBeLessThan(1e-12);
  });
});

describe('head resolution refusals and data grades', () => {
  const radius = 0.5;
  const cases: [string, HeadSpec, string][] = [
    ['ellipsoidal without ratio', { type: 'ellipsoidal' }, 'head.ratio'],
    ['conical without angle', { type: 'conical' }, 'head.halfAngleDeg'],
    ['torispherical without data', { type: 'torispherical' }, 'head.standard'],
    ['knuckle >= R', { type: 'torispherical', crownRadius: 1, knuckleRadius: 0.5 }, 'head.knuckleRadius'],
    ['crown < R', { type: 'torispherical', crownRadius: 0.4, knuckleRadius: 0.1 }, 'head.crownRadius'],
    ['crown <= knuckle', { type: 'torispherical', crownRadius: 0.6, knuckleRadius: 0.6 }, 'head.knuckleRadius'],
  ];
  for (const [name, spec, path] of cases) {
    it(name, () => {
      expect(resolveHead(spec, radius, 'head')).toEqual({ error: expect.any(String), path });
    });
  }

  it('crown equal to the knuckle (both valid radii) is refused on the crown', () => {
    expect(resolveHead({ type: 'torispherical', crownRadius: 0.3, knuckleRadius: 0.3 }, 0.2, 'head')).toMatchObject({
      path: 'head.knuckleRadius',
    });
    expect(resolveHead({ type: 'torispherical', crownRadius: 0.5, knuckleRadius: 0.5 }, 0.6, 'head')).toMatchObject({
      path: 'head.crownRadius',
    });
  });

  it('every standard row has sources and a grade; below grade A reports unverified', () => {
    for (const row of Object.values(HEAD_STANDARDS)) {
      expect(row.sources.length).toBeGreaterThan(0);
      const head = resolveHead({ type: 'torispherical', standard: row.id }, radius, 'head');
      if ('error' in head) throw new Error(head.error);
      expect(head.unverified, row.id).toBe(row.grade !== 'A');
      expect(head.source).toContain(`grade ${row.grade}`);
    }
    expect(HEAD_STANDARDS.asme_80_10.grade).toBe('B');
    expect(HEAD_STANDARDS.asme_fd.grade).toBe('A');
  });
});

describe('VC-EQP-09 head metal volume (offset solid)', () => {
  const RHO = 7850;

  it('SC-EQP-01 2:1 head D 1500 t 10: 194.637 kg, not the 191.459 kg of the thin-wall rule', () => {
    const head = shape({ type: 'ellipsoidal', ratio: 2 }, 0.75);
    const kg = headMetalVolume(head, 0.75, 0.01) * RHO;
    expect(rel(kg, 194.637)).toBeLessThan(1e-5);
    const thin = headInsideArea(head, 0.75) * 0.01 * RHO;
    expect(rel(thin, 191.459)).toBeLessThan(1e-5);
    expect(kg).toBeGreaterThan(thin);
  });

  it('SC-EQP-02 2:1 head D 2000 t 16 agrees with the 1e5-segment trapezoid of derive_expected.py', () => {
    const radius = 1;
    const depth = 0.5;
    const t = 0.016;
    const n = 100000;
    const revolved = (offset: number): number => {
      let total = 0;
      let prev: [number, number] | undefined;
      for (let i = 0; i <= n; i++) {
        const u = ((Math.PI / 2) * i) / n;
        const dx = -radius * Math.sin(u);
        const dz = depth * Math.cos(u);
        const norm = Math.hypot(dx, dz);
        const point: [number, number] = [radius * Math.cos(u) + (offset * dz) / norm, depth * Math.sin(u) - (offset * dx) / norm];
        if (prev !== undefined) total += Math.PI * ((point[0] + prev[0]) / 2) ** 2 * Math.abs(point[1] - prev[1]);
        prev = point;
      }
      return total;
    };
    const reference = revolved(t) - revolved(0);
    expect(rel(headMetalVolume({ kind: 'ellipsoidal', depth }, radius, t), reference)).toBeLessThan(1e-8);
  });

  it('hemisphere equals 2 pi / 3 ((R + t)^3 - R^3), also through the ellipsoidal quadrature', () => {
    const exact = ((2 * Math.PI) / 3) * (0.76 ** 3 - 0.75 ** 3);
    const hemi = shape({ type: 'hemispherical' }, 0.75);
    expect(rel(headMetalVolume(hemi, 0.75, 0.01), exact)).toBeLessThan(1e-12);
    expect(rel(headMetalVolume({ kind: 'ellipsoidal', depth: 0.75 }, 0.75, 0.01), exact)).toBeLessThan(1e-9);
  });

  it('thin limit: metal volume tends to inside area x t for every head type', () => {
    const radius = 0.5;
    const t = 1e-6;
    const heads: HeadSpec[] = [
      { type: 'ellipsoidal', ratio: 2 },
      { type: 'torispherical', standard: 'asme_fd' },
      { type: 'torispherical', standard: 'din_28013' },
      { type: 'conical', halfAngleDeg: 30 },
      { type: 'hemispherical' },
    ];
    for (const spec of heads) {
      const head = shape(spec, radius);
      expect(rel(headMetalVolume(head, radius, t), headInsideArea(head, radius) * t), JSON.stringify(spec)).toBeLessThan(2e-5);
    }
    const flat = shape({ type: 'flat' }, radius);
    expect(headMetalVolume(flat, radius, 0.02)).toBeCloseTo(Math.PI * radius * radius * 0.02, 14);
  });

  it('spherical cap of depth below R (not reachable from a HeadSpec) follows the cap formula', () => {
    const cap: HeadShape = { kind: 'spherical', depth: 0.25 };
    const metal = headMetalVolume(cap, 0.5, 0.01);
    expect(metal).toBeGreaterThan(headInsideArea(cap, 0.5) * 0.01 * 0.99);
    expect(metal).toBeLessThan(headInsideArea(cap, 0.5) * 0.01 * 1.1);
  });
});
