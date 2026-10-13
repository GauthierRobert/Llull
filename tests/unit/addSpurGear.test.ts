import { describe, it, expect } from 'vitest';
import { type ExtrusionEntity, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildSpurGearProfile } from '@core/commands/solids/gears';
import { polygonArea, segmentsIntersect, signedArea } from '@lib/polygon';
import { isWatertight, meshTris, signedVolume } from './gearTestUtils';
import { expectSingleEntity } from '../helpers/expectNoOp';

describe('add_spur_gear', () => {
  // Happy path

  it('creates exactly one extrusion entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 42,
      pressureAngle: Math.PI / 9,
      faceWidth: 10,
    });

    expectSingleEntity(result, 'extrusion');
  });

  it('extrusion depth equals faceWidth', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 42,
      faceWidth: 10,
    });
    const id = result.affected[0]!;
    const gear = result.document.entities[id] as ExtrusionEntity;
    expect(gear.depth).toBe(10);
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
    const result = execute(createEmptyDocument(), 'add_spur_gear', {
      module: 2,
      teeth: 30,
      faceWidth: 5,
    });
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

  it('omitting pressureAngle uses 20° default — matches explicit 20° call', () => {
    const doc = createEmptyDocument();
    const r1 = execute(doc, 'add_spur_gear', { module: 1, teeth: 20, faceWidth: 5 });
    const r2 = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 20,
      pressureAngle: Math.PI / 9,
      faceWidth: 5,
    });

    const g1 = r1.document.entities[r1.affected[0]!] as ExtrusionEntity;
    const g2 = r2.document.entities[r2.affected[0]!] as ExtrusionEntity;

    expect(g1.profile.length).toBe(g2.profile.length);
    expect(g1.profile[0]![0]).toBeCloseTo(g2.profile[0]![0], 8);
    expect(g1.profile[0]![1]).toBeCloseTo(g2.profile[0]![1], 8);
  });

  it('bore=0 stays an extrusion; bore>0 makes a watertight mesh with a through hole', () => {
    const doc = createEmptyDocument();

    const r1 = execute(doc, 'add_spur_gear', { module: 2, teeth: 20, faceWidth: 10, bore: 0 });
    expect(r1.document.entities[r1.affected[0]!]!.kind).toBe('extrusion');

    const r2 = execute(doc, 'add_spur_gear', { module: 2, teeth: 20, faceWidth: 10, bore: 5 });
    expect(r2.affected).toHaveLength(1);
    expect(r2.summary).toContain('bore=5');
    const hub = r2.document.entities[r2.affected[0]!]!;
    expect(hub.kind).toBe('mesh');
    const tris = meshTris((hub as MeshSolidEntity).mesh);
    expect(isWatertight(tris)).toBe(true);
    const solid = r1.document.entities[r1.affected[0]!] as ExtrusionEntity;
    const expected = (polygonArea(solid.profile) - Math.PI * 5 * 5) * 10;
    expect(signedVolume(tris)).toBeGreaterThan(expected * 0.99);
    expect(signedVolume(tris)).toBeLessThan(expected * 1.01);
  });

  it('position is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      position: [5, 10, 2],
    });
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.position).toEqual([5, 10, 2]);
  });

  it('changing position shifts the entity', () => {
    const doc = createEmptyDocument();
    const r1 = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      position: [0, 0, 0],
    });
    const r2 = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      position: [100, 0, 0],
    });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;
    expect(r2.document.entities[id2]!.position[0]).not.toBe(r1.document.entities[id1]!.position[0]);
  });

  it('rotation is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      rotation: [0, 0, Math.PI / 4],
    });
    const id = result.affected[0]!;
    expect(result.document.entities[id]!.rotation[2]).toBeCloseTo(Math.PI / 4, 8);
  });

  it('summary is factual — includes id, module, teeth, pitchD, outerD', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 42,
      faceWidth: 10,
    });
    const id = result.affected[0]!;
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('module=2');
    expect(result.summary).toContain('teeth=42');
    expect(result.summary).toContain('pitchD=84');
    expect(result.summary).toContain('outerD=88');
  });

  it('affected contains exactly the new entity id', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 3,
      teeth: 15,
      faceWidth: 20,
    });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]).toBeDefined();
  });

  // Small tooth count (undercut regime)

  it('works for teeth=3 (minimum, severe undercut clamped)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 5,
      teeth: 3,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(1);
    const gear = result.document.entities[result.affected[0]!] as ExtrusionEntity;
    expect(gear.profile.length).toBeGreaterThan(3);
  });

  // Failure paths

  it('teeth=2 is rejected — unchanged doc, affected:[], summary names invariant', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 2,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/teeth/i);
  });

  it('module=0 is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 0,
      teeth: 20,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/module/i);
  });

  it('negative module is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: -1,
      teeth: 20,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('faceWidth=0 is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: 0,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/faceWidth/i);
  });

  it('faceWidth<0 is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: -5,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('pressureAngle=0 is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      pressureAngle: 0,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/pressureAngle/i);
  });

  it('pressureAngle=π/2 is rejected', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      pressureAngle: Math.PI / 2,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('bore >= pitchRadius is rejected', () => {
    const doc = createEmptyDocument();
    // pitchRadius = 2*20/2 = 20; bore=20 should fail
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: 10,
      bore: 20,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/bore/i);
  });

  it('NaN in module -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: NaN,
      teeth: 20,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('Infinity in faceWidth -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: Infinity,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN in teeth -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: NaN,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN in pressureAngle -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      pressureAngle: NaN,
      faceWidth: 10,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  // Purity

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: 10,
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
