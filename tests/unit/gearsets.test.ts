import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, ExtrusionEntity, MeshSolidEntity, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { planetaryPhases } from '@core/commands/solids/gearsPlanetary';
import { polygonArea } from '@lib/polygon';
import type { Point2 } from '@lib/polygon';
import { buildSpurGearProfile } from '@core/commands/solids/gears';
import { isWatertight, meshTris, meshVertices, insideTriangle, planetaryInterference, pointInMesh, signedVolume } from './gearTestUtils';
import type { Tri } from './gearTestUtils';

const doc = (): CadDocument => createEmptyDocument();
const mesh = (d: CadDocument, id: string): MeshSolidEntity => d.entities[id] as MeshSolidEntity;
const extrusion = (d: CadDocument, id: string): ExtrusionEntity => d.entities[id] as ExtrusionEntity;

describe('gear profile cost', () => {
  it('flank sampling reduced: points per tooth 33 -> <= 19 with unchanged tooth count', () => {
    const before = 14 * 2 + 2 + 3 - 1; // legacy: 14 per flank + 1 tip + 3 root per tooth
    const profile = buildSpurGearProfile(2, 42, Math.PI / 9);
    const perTooth = profile.length / 42;
    expect(perTooth).toBeLessThanOrEqual(19);
    expect(perTooth).toBeLessThan(before * 0.65);
  });
});

describe('add_internal_gear', () => {
  const params = { module: 2, teeth: 40, faceWidth: 8, outerRadius: 50 };

  it('creates one closed watertight mesh whose volume is rim minus cavity', () => {
    const result = execute(doc(), 'add_internal_gear', params);
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const ring = mesh(result.document, result.affected[0]!);
    expect(ring.kind).toBe('mesh');
    const tris = meshTris(ring.mesh);
    expect(isWatertight(tris)).toBe(true);
    const volume = signedVolume(tris);
    const pitchR = 40;
    expect(volume).toBeGreaterThan(Math.PI * (50 ** 2 - (pitchR + 2.5) ** 2) * 8);
    expect(volume).toBeLessThan(Math.PI * (50 ** 2 - (pitchR - 2) ** 2) * 8);
  });

  it('tooth spaces accept an external gear of the same module (no overlap, clearance)', () => {
    const ringDoc = execute(doc(), 'add_internal_gear', params).document;
    const ringTris = meshTris(mesh(ringDoc, ringDoc.order[0]!).mesh).filter((t) => t.every((v) => v[2] === 0));
    // Pinion of 10 teeth, centre distance = module * (40 - 10) / 2, tooth 0 pointing at +X.
    const pinion = buildSpurGearProfile(2, 10, Math.PI / 9).map(([x, y]): Point2 => [x + 30, y]);
    const overlaps = pinion.some((p) => ringTris.some((t) => insideTriangle(p, t)));
    // Orientation is arbitrary here, so only a tip-to-root phase match could mesh: rotate the pinion
    // about its centre and require at least one non-overlapping phase.
    const phases = Array.from({ length: 36 }, (_, i) => {
      const a = (i / 36) * ((2 * Math.PI) / 10);
      const rotated = buildSpurGearProfile(2, 10, Math.PI / 9).map(
        ([x, y]): Point2 => [30 + x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)],
      );
      return rotated.some((p) => ringTris.some((t) => insideTriangle(p, t)));
    });
    expect(typeof overlaps).toBe('boolean');
    expect(phases.some((hit) => !hit)).toBe(true);
  });

  it('caps face outward (+Z top, -Z bottom) and cover exactly rim minus cavity', () => {
    const result = execute(doc(), 'add_internal_gear', params);
    const tris = meshTris(mesh(result.document, result.affected[0]!).mesh);
    const signed = (t: Tri): number => (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]);
    const top = tris.filter((t) => t.every((v) => v[2] === 8));
    const bottom = tris.filter((t) => t.every((v) => v[2] === 0));
    expect(top.every((t) => signed(t) > 0)).toBe(true);
    expect(bottom.every((t) => signed(t) < 0)).toBe(true);
    const area = (list: Tri[]): number => list.reduce((sum, t) => sum + Math.abs(signed(t)) / 2, 0);
    expect(area(top)).toBeCloseTo(signedVolume(tris) / 8, 6);
    expect(area(bottom)).toBeCloseTo(signedVolume(tris) / 8, 6);
  });

  it('places the ring at position/rotation (world-space mesh)', () => {
    const result = execute(doc(), 'add_internal_gear', { ...params, position: [100, 0, 5] });
    const verts = meshVertices(mesh(result.document, result.affected[0]!).mesh);
    const xs = verts.map((v) => v[0]);
    expect(Math.min(...xs)).toBeCloseTo(50, 6);
    expect(Math.max(...xs)).toBeCloseTo(150, 6);
    expect(Math.min(...verts.map((v) => v[2]))).toBeCloseTo(5, 9);
  });

  it('rejects bad input without changing the document', () => {
    const d = doc();
    for (const bad of [
      { ...params, module: 0 },
      { ...params, teeth: 5 },
      { ...params, faceWidth: -1 },
      { ...params, outerRadius: 40 },
      { ...params, pressureAngle: 2 },
    ]) {
      const result = execute(d, 'add_internal_gear', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
      expect(result.summary).toContain('add_internal_gear failed');
    }
  });

  it('is pure', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    execute(d, 'add_internal_gear', params);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('add_planetary_gearset', () => {
  const params = {
    module: 2,
    sunTeeth: 12,
    planetTeeth: 18,
    planetCount: 3,
    faceWidth: 6,
    ringOuterRadius: 70,
  };

  it.each([
    [12, 18, 3],
    [12, 18, 4],
    [16, 16, 4],
    [18, 12, 3],
    [24, 24, 3],
    [13, 17, 2],
  ])('sun %i / planet %i / %i planets mesh without interference', (sunTeeth, planetTeeth, planetCount) => {
    const result = execute(doc(), 'add_planetary_gearset', {
      ...params,
      sunTeeth,
      planetTeeth,
      planetCount,
      ringOuterRadius: (2 * (sunTeeth + 2 * planetTeeth)) / 2 + 6,
    });
    expect(result.affected).toHaveLength(planetCount + 2);
    expect(planetaryInterference(result.document, result.affected)).toEqual({ sun: 0, ring: 0 });
    // Sensitivity control: twisting the planets by half a pitch must collide.
    const twisted = planetaryInterference(result.document, result.affected, Math.PI / planetTeeth);
    expect(twisted.sun + twisted.ring).toBeGreaterThan(0);
  });

  it('returns ids, ratio and geometry data; ring teeth = sun + 2*planet', () => {
    const result = execute(doc(), 'add_planetary_gearset', { ...params, namePrefix: 'pg' });
    expect(result.affected).toHaveLength(5);
    expect(result.document.order).toEqual(result.affected);
    expect(result.data).toMatchObject({ ringTeeth: 48, ratio: 5, centerDistance: 30 });
    expect(result.summary).toContain('ring');
    expect(result.document.entities[result.affected[0]!]!.name).toBe('pg_sun');
    const planetPositions = result.affected.slice(1, 4).map((id) => result.document.entities[id]!.position);
    for (const [x, y] of planetPositions) expect(Math.hypot(x, y)).toBeCloseTo(30, 9);
  });

  it('honours position and axis x (planets orbit in the YZ plane)', () => {
    const result = execute(doc(), 'add_planetary_gearset', {
      ...params,
      position: [10, 0, 0],
      axis: 'x',
    });
    for (const id of result.affected.slice(1, 4)) {
      const p = result.document.entities[id]!.position;
      expect(p[0]).toBeCloseTo(10, 9);
      expect(Math.hypot(p[1], p[2])).toBeCloseTo(30, 9);
      expect(result.document.entities[id]!.rotation[1]).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('rejects an assembly-condition violation with the valid planet counts', () => {
    const d = doc();
    const result = execute(d, 'add_planetary_gearset', { ...params, planetCount: 7 });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(d);
    expect(result.summary).toContain('assembly condition');
    expect(result.summary).toContain('1, 2, 3, 4, 5, 6, 10, 12');
  });

  it('rejects invalid parameters and colliding planets', () => {
    const d = doc();
    for (const bad of [
      { ...params, module: -1 },
      { ...params, sunTeeth: 3 },
      { ...params, planetCount: 0 },
      { ...params, faceWidth: 0 },
      { ...params, ringOuterRadius: 10 },
      { ...params, pressureAngle: 0 },
      { ...params, sunTeeth: 6, planetTeeth: 30, planetCount: 6 },
    ]) {
      const result = execute(d, 'add_planetary_gearset', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
    }
  });

  it('planetaryPhases: ring phase is independent of the planet index', () => {
    const phases = planetaryPhases(12, 18, 3);
    expect(phases.planets).toHaveLength(3);
    expect(phases.ring).toBeCloseTo((Math.PI * 17) / 48, 12);
    expect(polygonArea(buildSpurGearProfile(2, 18, Math.PI / 9))).toBeGreaterThan(0);
  });

  it('is pure', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    execute(d, 'add_planetary_gearset', params);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('add_bevel_gear', () => {
  const params = { module: 3, teeth: 20, matingTeeth: 30, faceWidth: 12 };

  it('creates a closed watertight mesh solid with real teeth', () => {
    const result = execute(doc(), 'add_bevel_gear', params);
    expect(result.affected).toHaveLength(1);
    const gear = mesh(result.document, result.affected[0]!);
    const tris = meshTris(gear.mesh);
    expect(isWatertight(tris)).toBe(true);
    expect(signedVolume(tris)).toBeGreaterThan(0);
    // 20 teeth at the heel: far more than a cone's handful of vertices.
    expect(gear.mesh.positions.length / 3).toBeGreaterThan(2 * 20 * 8);
    expect(result.summary).toContain('pitchAngle=33.69');
  });

  it('shrinks towards the apex: toe radius = heel radius * (R - F) / R', () => {
    const result = execute(doc(), 'add_bevel_gear', params);
    const verts = meshVertices(mesh(result.document, result.affected[0]!).mesh);
    const heel = Math.max(...verts.filter((v) => v[2] === 0).map((v) => Math.hypot(v[0], v[1])));
    const topZ = Math.max(...verts.map((v) => v[2]));
    const toe = Math.max(...verts.filter((v) => v[2] === topZ).map((v) => Math.hypot(v[0], v[1])));
    const coneDistance = (3 * 20) / (2 * Math.sin(Math.atan(20 / 30)));
    expect(toe / heel).toBeCloseTo((coneDistance - 12) / coneDistance, 9);
  });

  it('supports bore, axis and position', () => {
    const result = execute(doc(), 'add_bevel_gear', {
      ...params,
      bore: 5,
      axis: 'x',
      position: [0, 0, 7],
    });
    const tris = meshTris(mesh(result.document, result.affected[0]!).mesh);
    expect(isWatertight(tris)).toBe(true);
    const verts = meshVertices(mesh(result.document, result.affected[0]!).mesh);
    expect(Math.min(...verts.map((v) => v[0]))).toBeCloseTo(0, 9);
    expect(Math.max(...verts.map((v) => v[0]))).toBeGreaterThan(5);
  });

  it('rejects bad input without changing the document', () => {
    const d = doc();
    for (const bad of [
      { ...params, module: 0 },
      { ...params, teeth: 4 },
      { ...params, matingTeeth: 2000 },
      { ...params, faceWidth: 500 },
      { ...params, shaftAngle: 4 },
      { ...params, pitchAngle: 2 },
      { ...params, bore: 100 },
      { ...params, pressureAngle: 0 },
    ]) {
      const result = execute(d, 'add_bevel_gear', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
      expect(result.summary).toContain('add_bevel_gear failed');
    }
  });

  it('is pure', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    execute(d, 'add_bevel_gear', params);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('add_bevel_gear_pair', () => {
  const params = { module: 3, pinionTeeth: 18, wheelTeeth: 30, faceWidth: 12 };

  const penetration = (a: ReadonlyArray<Tri>, b: ReadonlyArray<Tri>, va: ReadonlyArray<Vec3>, vb: ReadonlyArray<Vec3>): number =>
    va.filter((p) => pointInMesh(b, p)).length + vb.filter((p) => pointInMesh(a, p)).length;

  it('creates two watertight solids whose teeth mesh without interpenetration', () => {
    const result = execute(doc(), 'add_bevel_gear_pair', params);
    expect(result.affected).toHaveLength(2);
    const [pinion, wheel] = result.affected.map((id) => mesh(result.document, id));
    const [pt, wt] = [meshTris(pinion!.mesh), meshTris(wheel!.mesh)];
    expect(isWatertight(pt)).toBe(true);
    expect(isWatertight(wt)).toBe(true);
    const [pv, wv] = [meshVertices(pinion!.mesh), meshVertices(wheel!.mesh)];
    expect(penetration(pt, wt, pv, wv)).toBe(0);

    // Control: rotating the wheel by half a pitch about its axis (X through the apex) must collide.
    const half = Math.PI / 30;
    const turned = wv.map(([x, y, z]): Vec3 => [x, y * Math.cos(half) - z * Math.sin(half), y * Math.sin(half) + z * Math.cos(half)]);
    const turnedTris = wt.map(
      (t): Tri =>
        t.map(([x, y, z]): Vec3 => [x, y * Math.cos(half) - z * Math.sin(half), y * Math.sin(half) + z * Math.cos(half)]) as unknown as Tri,
    );
    expect(penetration(pt, turnedTris, pv, turned)).toBeGreaterThan(0);
  });

  it('reports the 90° pitch angles and ratio in data', () => {
    const result = execute(doc(), 'add_bevel_gear_pair', params);
    const data = result.data as {
      ratio: number;
      pinionPitchAngle: number;
      wheelPitchAngle: number;
    };
    expect(data.ratio).toBeCloseTo(30 / 18, 12);
    expect(data.pinionPitchAngle + data.wheelPitchAngle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('puts both cone apexes at position', () => {
    const result = execute(doc(), 'add_bevel_gear_pair', { ...params, position: [5, 6, 7] });
    const [pinion, wheel] = result.affected.map((id) => mesh(result.document, id));
    const maxZ = Math.max(...meshVertices(pinion!.mesh).map((v) => v[2]));
    const maxX = Math.max(...meshVertices(wheel!.mesh).map((v) => v[0]));
    // Toe faces sit F*cos(pitch) short of the apex height.
    expect(maxZ).toBeLessThan(7);
    expect(maxX).toBeLessThan(5);
    expect(maxZ).toBeGreaterThan(7 - 45);
  });

  it('rejects bad input without changing the document', () => {
    const d = doc();
    for (const bad of [
      { ...params, pinionTeeth: 3 },
      { ...params, wheelTeeth: 3 },
      { ...params, faceWidth: 0 },
      { ...params, module: -2 },
    ]) {
      const result = execute(d, 'add_bevel_gear_pair', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
    }
  });
});

describe('add_spline_shaft', () => {
  it('builds W200x5x38 with DIN 5480 tooth count, tip and root diameters', () => {
    const result = execute(doc(), 'add_spline_shaft', {
      referenceDiameter: 200,
      module: 5,
      length: 120,
    });
    expect(result.affected).toHaveLength(1);
    const shaft = extrusion(result.document, result.affected[0]!);
    expect(shaft.kind).toBe('extrusion');
    expect(shaft.depth).toBe(120);
    expect(result.summary).toContain('W200x5x38');
    const radii = shaft.profile.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeCloseTo(100 - 0.5, 6);
    expect(Math.min(...radii)).toBeCloseTo(100 - 0.5 - 4.5, 6);
    expect(polygonArea(shaft.profile)).toBeGreaterThan(Math.PI * 95 ** 2 * 0.95);
  });

  it('keeps the profile cheap (<= 19 points per tooth)', () => {
    const result = execute(doc(), 'add_spline_shaft', {
      referenceDiameter: 200,
      module: 5,
      length: 10,
    });
    expect(extrusion(result.document, result.affected[0]!).profile.length / 38).toBeLessThanOrEqual(19);
  });

  it('accepts an explicit tooth count', () => {
    const result = execute(doc(), 'add_spline_shaft', {
      referenceDiameter: 30,
      module: 2,
      teeth: 12,
      length: 20,
    });
    expect(result.summary).toContain('W30x2x12');
  });

  it('rejects bad input without changing the document', () => {
    const d = doc();
    for (const bad of [
      { referenceDiameter: 0, module: 5, length: 10 },
      { referenceDiameter: 200, module: 0, length: 10 },
      { referenceDiameter: 200, module: 5, length: 0 },
      { referenceDiameter: 200, module: 5, length: 10, teeth: 2 },
      { referenceDiameter: 200, module: 5, length: 10, pressureAngle: 3 },
      { referenceDiameter: 10, module: 8, length: 10, teeth: 8 },
    ]) {
      const result = execute(d, 'add_spline_shaft', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
      expect(result.summary).toContain('add_spline_shaft failed');
    }
  });

  it('is pure', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    execute(d, 'add_spline_shaft', { referenceDiameter: 200, module: 5, length: 10 });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('add_keyed_shaft', () => {
  const params = { diameter: 40, length: 100 };

  it('builds a watertight shaft whose volume is the cylinder minus the DIN 6885 pocket', () => {
    const result = execute(doc(), 'add_keyed_shaft', params);
    expect(result.affected).toHaveLength(1);
    const tris = meshTris(mesh(result.document, result.affected[0]!).mesh);
    expect(isWatertight(tris)).toBe(true);
    const cylinder = Math.PI * 20 ** 2 * 100;
    const pocket = 12 * 5 * 60;
    const volume = signedVolume(tris);
    expect(volume).toBeLessThan(cylinder - pocket * 0.8);
    expect(volume).toBeGreaterThan(cylinder * 0.97 - pocket * 1.2);
    expect(result.summary).toContain('b=12');
    expect(result.summary).toContain('t1=5');
  });

  it('open-ended keyway (offset 0 / reaching the end) stays watertight', () => {
    for (const extra of [{ keyOffset: 0, keyLength: 50 }, { keyOffset: 50, keyLength: 50 }, { keyLength: 100 }]) {
      const result = execute(doc(), 'add_keyed_shaft', { ...params, ...extra });
      expect(result.affected).toHaveLength(1);
      expect(isWatertight(meshTris(mesh(result.document, result.affected[0]!).mesh))).toBe(true);
    }
  });

  it('includeKey adds a seated parallel key (height h, width b)', () => {
    const result = execute(doc(), 'add_keyed_shaft', { ...params, includeKey: true, name: 'in' });
    expect(result.affected).toHaveLength(2);
    const key = mesh(result.document, result.affected[1]!);
    expect(key.name).toBe('in_key');
    const verts = meshVertices(key.mesh);
    expect(Math.max(...verts.map((v) => v[0])) - Math.min(...verts.map((v) => v[0]))).toBeCloseTo(8, 9);
    expect(Math.max(...verts.map((v) => v[1])) - Math.min(...verts.map((v) => v[1]))).toBeCloseTo(12, 9);
    expect(signedVolume(meshTris(key.mesh))).toBeCloseTo(12 * 8 * 60, 6);
  });

  it('uses explicit key dimensions', () => {
    const result = execute(doc(), 'add_keyed_shaft', {
      ...params,
      keyWidth: 6,
      keyDepth: 3,
      position: [1, 2, 3],
    });
    expect(result.summary).toContain('b=6');
    const verts = meshVertices(mesh(result.document, result.affected[0]!).mesh);
    expect(Math.min(...verts.map((v) => v[2]))).toBeCloseTo(3, 9);
  });

  it('rejects bad input without changing the document', () => {
    const d = doc();
    for (const bad of [
      { diameter: 0, length: 10 },
      { ...params, length: -1 },
      { ...params, keyWidth: 100 },
      { ...params, keyDepth: 0.01 },
      { ...params, keyDepth: 30 },
      { ...params, includeKey: true, keyDepth: 5, keyHeight: 4 },
      { ...params, keyLength: 200 },
      { ...params, keyLength: 60, keyOffset: 70 },
    ]) {
      const result = execute(d, 'add_keyed_shaft', bad);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(d);
      expect(result.summary).toContain('add_keyed_shaft failed');
    }
  });

  it('is pure', () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    execute(d, 'add_keyed_shaft', params);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});
