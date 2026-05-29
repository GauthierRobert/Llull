import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { ExtrusionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildSpurGearProfile } from '@core/commands/gears';
import { __resetIdCounter } from '@lib/id';

describe('add_spur_gear', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('creates exactly one extrusion entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 42,
      pressureAngle: Math.PI / 9,
      faceWidth: 10,
    });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);

    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('extrusion');
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

  it('profile is a closed polygon (last point ≈ first point)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 42,
      pressureAngle: Math.PI / 9,
      faceWidth: 10,
    });
    const id = result.affected[0]!;
    const gear = result.document.entities[id] as ExtrusionEntity;
    const profile = gear.profile;

    expect(profile.length).toBeGreaterThan(3);

    const first = profile[0]!;
    const last = profile[profile.length - 1]!;
    expect(last[0]).toBeCloseTo(first[0], 6);
    expect(last[1]).toBeCloseTo(first[1], 6);
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
    __resetIdCounter();
    const r1 = execute(doc, 'add_spur_gear', { module: 1, teeth: 20, faceWidth: 5 });
    __resetIdCounter();
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

  it('bore=0 note absent from summary; bore>0 is ignored with note in summary', () => {
    const doc = createEmptyDocument();

    const r1 = execute(doc, 'add_spur_gear', { module: 2, teeth: 20, faceWidth: 10, bore: 0 });
    expect(r1.summary).not.toContain('bore ignored');
    expect(r1.affected).toHaveLength(1);

    const r2 = execute(doc, 'add_spur_gear', {
      module: 2,
      teeth: 20,
      faceWidth: 10,
      bore: 5,
    });
    expect(r2.summary).toContain('bore');
    expect(r2.summary).toContain('ignored');
    expect(r2.affected).toHaveLength(1);
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
    __resetIdCounter();
    const r1 = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      position: [0, 0, 0],
    });
    __resetIdCounter();
    const r2 = execute(doc, 'add_spur_gear', {
      module: 1,
      teeth: 10,
      faceWidth: 3,
      position: [100, 0, 0],
    });
    const id1 = r1.affected[0]!;
    const id2 = r2.affected[0]!;
    expect(r2.document.entities[id2]!.position[0]).not.toBe(
      r1.document.entities[id1]!.position[0],
    );
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

  // ---------------------------------------------------------------------------
  // Small tooth count (undercut regime)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Failure paths
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Purity
  // ---------------------------------------------------------------------------

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
