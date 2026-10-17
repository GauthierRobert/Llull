import { describe, it, expect } from 'vitest';
import { type ExtrusionEntity, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { buildSpurGearProfile } from '@core/commands/solids/gears';
import { polygonArea, segmentsIntersect, signedArea } from '@lib/polygon';
import { isWatertight, meshTris, signedVolume, triArea2D, type Tri } from './gearTestUtils';
import { expectSingleEntity, expectNoOp, expectPure } from '../helpers/expectNoOp';

const gear = (p: object): ReturnType<typeof execute> => execute(createEmptyDocument(), 'add_spur_gear', p);
const entity = (r: ReturnType<typeof execute>): ExtrusionEntity => r.document.entities[r.affected[0]!] as ExtrusionEntity;

describe('add_spur_gear', () => {
  it('creates one extrusion (depth = faceWidth) placed and rotated as asked, with a factual summary, purely', () => {
    const r = gear({
      module: 2,
      teeth: 42,
      pressureAngle: Math.PI / 9,
      faceWidth: 10,
      position: [5, 10, 2],
      rotation: [0, 0, Math.PI / 4],
    });
    expectSingleEntity(r, 'extrusion');
    expect(entity(r)).toMatchObject({ depth: 10, position: [5, 10, 2] });
    expect(entity(r).rotation[2]).toBeCloseTo(Math.PI / 4, 8);
    for (const s of [r.affected[0]!, 'module=2', 'teeth=42', 'pitchD=84', 'outerD=88']) expect(r.summary).toContain(s);
    expect(entity(gear({ module: 1, teeth: 10, faceWidth: 3, position: [100, 0, 0] })).position[0]).toBe(100);
    expect(entity(gear({ module: 5, teeth: 3, faceWidth: 10 })).profile.length).toBeGreaterThan(3);
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'add_spur_gear', { module: 2, teeth: 20, faceWidth: 10 }));
  });
  it('profile is a simple CCW ring: no repeated closing point, no self-intersection', () => {
    const profile = buildSpurGearProfile(2, 20, Math.PI / 9);
    const first = profile[0]!;
    const last = profile[profile.length - 1]!;
    expect(Math.hypot(last[0] - first[0], last[1] - first[1])).toBeGreaterThan(1e-6);
    expect(signedArea(profile)).toBeGreaterThan(0);
    const n = profile.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        expect(segmentsIntersect(profile[i]!, profile[(i + 1) % n]!, profile[j]!, profile[(j + 1) % n]!)).toBe(false);
      }
    }
  });
  it('each tooth runs root -> flank up -> tip -> flank down -> root (one peak and one valley per tooth)', () => {
    const teeth = 20;
    const profile = buildSpurGearProfile(2, teeth, Math.PI / 9);
    const radii = profile.map(([x, y]) => Math.hypot(x, y));
    const collapsed = radii.filter((r, i) => Math.abs(r - radii[(i + 1) % radii.length]!) > 1e-9);
    const n = collapsed.length;
    let peaks = 0;
    let valleys = 0;
    collapsed.forEach((r, i) => {
      const before = collapsed[(i - 1 + n) % n]!;
      const after = collapsed[(i + 1) % n]!;
      if (r > before && r > after) peaks++;
      if (r < before && r < after) valleys++;
    });
    expect(peaks).toBe(teeth);
    expect(valleys).toBe(teeth);
  });
  it('flank sampling is cheap: fewer than 20 points per tooth (was 33)', () => {
    const profile = buildSpurGearProfile(2, 40, Math.PI / 9);
    expect(profile.length / 40).toBeLessThan(20);
  });
  it('carries an exact closed curve chain (Bézier flanks, arc lands) that starts at the profile', () => {
    const result = execute(createEmptyDocument(), 'add_spur_gear', { module: 2, teeth: 30, faceWidth: 5 });
    const gear = result.document.entities[result.affected[0]!] as ExtrusionEntity;
    const curves = gear.curves!;
    expect(curves.length).toBe(30 * 6);
    expect(curves.filter((c) => c.type === 'bezier')).toHaveLength(60);
    const end = (i: number): readonly [number, number] => {
      const pts = curves[i]!.points;
      return pts[pts.length - 1] as readonly [number, number];
    };
    curves.forEach((c, i) => {
      const prev = end((i - 1 + curves.length) % curves.length);
      expect(Math.hypot(c.points[0][0] - prev[0], c.points[0][1] - prev[1])).toBeLessThan(1e-9);
    });
    // Bézier flank stays on the true involute: radius at the curve mid-point within 1e-3 of the sampled flank.
    const bez = curves.find((c) => c.type === 'bezier')!;
    const [p0, c1, c2, p3] = bez.points as readonly (readonly [number, number])[] as [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ];
    const mid: [number, number] = [(p0[0] + 3 * c1[0] + 3 * c2[0] + p3[0]) / 8, (p0[1] + 3 * c1[1] + 3 * c2[1] + p3[1]) / 8];
    const baseRadius = 30 * Math.cos(Math.PI / 9);
    const t = Math.sqrt(Math.max(0, (Math.hypot(mid[0], mid[1]) / baseRadius) ** 2 - 1));
    const angleOf = (p: readonly [number, number]): number => Math.atan2(p[1], p[0]);
    const involuteAngle = (r: number): number => {
      const u = Math.sqrt(Math.max(0, (r / baseRadius) ** 2 - 1));
      return u - Math.atan(u);
    };
    expect(t).toBeGreaterThan(0);
    expect(Math.abs(angleOf(mid) - angleOf(p0) - (involuteAngle(Math.hypot(...mid)) - involuteAngle(Math.hypot(...p0))))).toBeLessThan(
      1e-3,
    );
  });
  it('pitch diameter equals module * teeth (direct: at least one tip point hits outerRadius)', () => {
    const mod = 2;
    const teeth = 42;
    const pitchRadius = (mod * teeth) / 2; // 42 → pitch diameter = 84
    const outerRadius = pitchRadius + mod; // 44 → outer diameter = 88
    const profile = buildSpurGearProfile(mod, teeth, Math.PI / 9);
    const rootRadius = pitchRadius - 1.25 * mod;
    let maxR = 0;
    for (const [x, y] of profile) {
      const r = Math.sqrt(x * x + y * y);
      expect(r).toBeGreaterThanOrEqual(rootRadius - 0.1);
      expect(r).toBeLessThanOrEqual(outerRadius + 1e-6);
      if (r > maxR) maxR = r;
    }
    expect(maxR).toBeCloseTo(outerRadius, 6); // pins pitchDiameter = module * teeth mathematically
  });
  it('profile has exactly `teeth` radial maxima (catches off-by-one in tooth count)', () => {
    const mod = 2;
    const teeth = 42;
    const profile = buildSpurGearProfile(mod, teeth, Math.PI / 9);
    const radii = profile.map(([x, y]) => Math.sqrt(x * x + y * y));
    const rootR = (mod * teeth) / 2 - 1.25 * mod;
    const outerR = (mod * teeth) / 2 + mod;
    const tipThreshold = outerR - (outerR - rootR) * 0.05; // top 5% of radial range
    // Count contiguous runs of "at tip" samples around the closed profile — one run per tooth.
    let runs = 0;
    let inRun = false;
    for (const r of radii) {
      const atTip = r >= tipThreshold;
      if (atTip && !inRun) runs += 1;
      inRun = atTip;
    }
    // Profile is closed: if last and first samples are both at-tip, the wrap joins one run.
    const firstR = radii[0]!;
    const lastR = radii[radii.length - 1]!;
    if (firstR >= tipThreshold && lastR >= tipThreshold && runs > 1) runs -= 1;
    expect(runs).toBe(teeth);
  });
  it('profile point count scales linearly with tooth count (no off-by-one)', () => {
    const p20 = buildSpurGearProfile(2, 20, Math.PI / 9);
    const p40 = buildSpurGearProfile(2, 40, Math.PI / 9);
    // 40-tooth profile should have ~2× the points of a 20-tooth profile (same per-tooth sampling).
    expect(p40.length).toBeGreaterThan(p20.length * 1.8);
    expect(p40.length).toBeLessThan(p20.length * 2.2);
  });
  it('omitting pressureAngle uses the 20° default', () => {
    const [g1, g2] = [
      gear({ module: 1, teeth: 20, faceWidth: 5 }),
      gear({ module: 1, teeth: 20, pressureAngle: Math.PI / 9, faceWidth: 5 }),
    ].map(entity);
    expect(g1!.profile.length).toBe(g2!.profile.length);
    expect(g1!.profile[0]![0]).toBeCloseTo(g2!.profile[0]![0], 8);
    expect(g1!.profile[0]![1]).toBeCloseTo(g2!.profile[0]![1], 8);
  });
  it('bore=0 stays an extrusion; bore>0 makes a watertight mesh with a through hole', () => {
    const r1 = gear({ module: 2, teeth: 20, faceWidth: 10, bore: 0 });
    expect(entity(r1).kind).toBe('extrusion');
    const r2 = gear({ module: 2, teeth: 20, faceWidth: 10, bore: 5 });
    expect(r2.affected).toHaveLength(1);
    expect(r2.summary).toContain('bore=5');
    const hub = r2.document.entities[r2.affected[0]!]!;
    expect(hub.kind).toBe('mesh');
    const tris = meshTris((hub as MeshSolidEntity).mesh);
    expect(isWatertight(tris)).toBe(true);
    const expected = (polygonArea(entity(r1).profile) - Math.PI * 5 * 5) * 10;
    expect(signedVolume(tris)).toBeGreaterThan(expected * 0.99);
    expect(signedVolume(tris)).toBeLessThan(expected * 1.01);
  });
  it.each([
    [18, 5],
    [36, 10],
    [12, 3],
  ])('bored gear (%i teeth, bore %f): caps face outward, tile the annulus exactly and leave the bore open', (teeth, bore) => {
    const r = gear({ module: 2, teeth, faceWidth: 20, bore });
    const tris = meshTris((r.document.entities[r.affected[0]!] as MeshSolidEntity).mesh);
    expect(isWatertight(tris)).toBe(true);
    const profileArea = polygonArea(buildSpurGearProfile(2, teeth, Math.PI / 9));
    expect(signedVolume(tris)).toBeCloseTo((profileArea - Math.PI * bore * bore) * 20, -1);
    const caps = (z: number): Tri[] => tris.filter((t) => t.every((v) => v[2] === z));
    for (const [z, sign] of [
      [0, -1],
      [20, 1],
    ] as const) {
      const cap = caps(z);
      expect(cap.length).toBeGreaterThan(teeth * 4);
      for (const t of cap) {
        const [a, b, c] = t;
        expect(Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))).toBe(sign);
        const centroidRadius = Math.hypot((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
        expect(centroidRadius).toBeGreaterThan(bore * 0.99);
      }
      expect(cap.reduce((sum, t) => sum + triArea2D(t), 0)).toBeCloseTo(profileArea - Math.PI * bore * bore, -1);
    }
  });
  it.each<[object, RegExp?]>([
    [{ module: 2, teeth: 2, faceWidth: 10 }, /teeth/i],
    [{ module: 0, teeth: 20, faceWidth: 10 }, /module/i],
    [{ module: -1, teeth: 20, faceWidth: 10 }],
    [{ module: 2, teeth: 20, faceWidth: 0 }, /faceWidth/i],
    [{ module: 2, teeth: 20, faceWidth: -5 }],
    [{ module: 2, teeth: 20, pressureAngle: 0, faceWidth: 10 }, /pressureAngle/i],
    [{ module: 2, teeth: 20, pressureAngle: Math.PI / 2, faceWidth: 10 }],
    [{ module: 2, teeth: 20, faceWidth: 10, bore: 20 }, /bore/i],
    [{ module: NaN, teeth: 20, faceWidth: 10 }],
    [{ module: 2, teeth: 20, faceWidth: Infinity }],
    [{ module: 2, teeth: NaN, faceWidth: 10 }],
    [{ module: 2, teeth: 20, pressureAngle: NaN, faceWidth: 10 }],
  ])('%j is rejected', (p, summary) => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_spur_gear', p);
    expectNoOp(r, doc);
    if (summary) expect(r.summary).toMatch(summary);
  });
});

describe('add_spur_gear position semantics', () => {
  it('the description says position is the bottom face and the gear spans z..z+faceWidth', () => {
    const def = getCommand('add_spur_gear')!;
    expect(def.description).toMatch(/bottom face/);
    expect(def.paramsSchema.properties['position']!.description).toMatch(/BOTTOM face/);
    const r = gear({ module: 2, teeth: 20, faceWidth: 10, bore: 4, position: [0, 0, 7] });
    const zs = (r.document.entities[r.affected[0]!] as MeshSolidEntity).mesh.positions.filter((_, i) => i % 3 === 2);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([7, 17]);
  });
});
