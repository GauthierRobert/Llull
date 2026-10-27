/**
 * BLD M2 mitre ends on the native OCCT kernel (DES-6c step 7, TECHNICAL_SPEC §13.16): a conic or curvature profile on a creased tangent chain (the top rim
 * of an N-gon prism, a polyline outline), concave and convex, at 1 / 10 / 100 / 1000 mm, against the swept section: with A the area of the removed
 * section, M its first moment about the wall and P the rim's length, a mitred sweep along a polygon changes the volume by A P - 2 M sum(s tan(turn / 2)).
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type Point = readonly [number, number];
interface Joint {
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly creaseRad?: number;
}
interface Row {
  readonly kind: string;
  readonly profile: string;
  readonly contacts: readonly Joint[];
  readonly junctions?: readonly Joint[];
}
interface Checked {
  readonly status: string;
  readonly blends: Row[];
  readonly findings: Array<{ code: string; severity: string }>;
  readonly tolerances: { readonly g0Profile?: { readonly value: number } };
  readonly unverified: number;
  readonly unverifiedJunctions: number;
}
interface ProfileData {
  readonly builder: string;
  readonly gap: number;
  readonly gapLimit: number;
  readonly junctionG1: number;
  readonly creaseRad: number;
}

const SIZES = [1, 10, 100, 1000] as const;
const PROFILES = [
  { kind: 0, profile: { type: 'conic', rho: 0.5 } },
  { kind: 1, profile: { type: 'curvature', shape: 0.5 } },
] as const;

const regular = (sides: number, radius: number): Point[] =>
  Array.from(
    { length: sides },
    (_, k) => [radius * Math.cos((2 * Math.PI * k) / sides), radius * Math.sin((2 * Math.PI * k) / sides)] as const,
  );

/** Area and first moment about the wall of the region a profile removes from a right-angle corner with legs d (corner (0,0), contacts (0,-d) and (d,0)). */
function section(kind: number, param: number, d: number): { area: number; moment: number } {
  const a: Point = [0, -d];
  const t: Point = [0, 0];
  const b: Point = [d, 0];
  const along = (from: Point, to: Point, s: number): Point => [from[0] + (to[0] - from[0]) * s, from[1] + (to[1] - from[1]) * s];
  const lead = 0.8 * param;
  const reach = 0.4 * param + 0.6;
  const poles = [a, along(a, t, lead), along(a, t, reach), along(b, t, reach), along(b, t, lead), b];
  const weight = param / (1 - param);
  const choose = [1, 5, 10, 10, 5, 1];
  const point = (u: number): Point => {
    if (kind === 0) {
      const basis = [(1 - u) ** 2, 2 * u * (1 - u) * weight, u * u];
      const sum = basis[0]! + basis[1]! + basis[2]!;
      return [
        (basis[0]! * a[0] + basis[1]! * t[0] + basis[2]! * b[0]) / sum,
        (basis[0]! * a[1] + basis[1]! * t[1] + basis[2]! * b[1]) / sum,
      ];
    }
    let x = 0;
    let z = 0;
    poles.forEach((pole, i) => {
      const bernstein = choose[i]! * u ** i * (1 - u) ** (5 - i);
      x += bernstein * pole[0];
      z += bernstein * pole[1];
    });
    return [x, z];
  };
  const n = 200_000;
  let area = 0;
  let moment = 0;
  let last = point(0);
  for (let k = 1; k <= n; k++) {
    const now = point(k / n);
    const dz = now[1] - last[1];
    area += 0.5 * (last[0] + now[0]) * dz;
    moment += 0.25 * (last[0] ** 2 + now[0] ** 2) * dz;
    last = now;
  }
  return { area, moment };
}

/** Length of the closed polygon and the sum of tan(turn / 2) over its corners (positive where it turns left, toward the inside of a ccw polygon). */
function lengthAndTurns(points: readonly Point[]): { length: number; turns: number } {
  let length = 0;
  let turns = 0;
  points.forEach((q, k) => {
    const p = points[(k + points.length - 1) % points.length]!;
    const r = points[(k + 1) % points.length]!;
    length += Math.hypot(r[0] - q[0], r[1] - q[1]);
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    const dot = (q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1]);
    turns += Math.tan(Math.atan2(cross, dot) / 2);
  });
  return { length, turns };
}

describeNative('BLD M2 mitre ends: profile blends on creased tangent chains (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });
  const rows: string[] = [];
  afterAll(() => {
    if (process.env['LLULL_BLEND_TABLE'] !== undefined) console.warn(rows.join(String.fromCharCode(10)));
  });

  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const check = (doc: Doc, id: string): Checked => execute(doc, 'check_blends', { ids: [id] }).data as Checked;
  const prism = (points: readonly Point[], depth: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', { profile: points, depth });
  const sideNear = (points: readonly Point[], k: number, z: number): number[] => {
    const a = points[k]!;
    const b = points[(k + 1) % points.length]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z];
  };

  /** The whole chain mitred and read back: pass, every chain member the profile, one junction per crease, volume against the swept section. */
  const expectMitred = (
    before: { doc: Doc; id: string },
    done: ReturnType<typeof made>,
    expectedChange: number,
    members: number,
    junctions: number,
    crease: number,
    profileName: string,
    label: string,
    read = true,
    tolerance = 1e-6,
  ): { error: number; data: ProfileData } => {
    expect(done.result.error, label).toBeUndefined();
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.builder).toBe('rails');
    expect(data.gap).toBeLessThanOrEqual(data.gapLimit);
    expect(data.creaseRad).toBeCloseTo(crease, 3);
    expect(data.junctionG1).toBeLessThanOrEqual(data.creaseRad + 0.0095);
    const change = volume(done.doc, done.id) - volume(before.doc, before.id);
    const error = Math.abs(change - expectedChange) / Math.abs(expectedChange);
    expect(error, label).toBeLessThan(tolerance);
    if (!read) return { error, data };
    const checked = check(done.doc, done.id);
    expect(checked.status, label).toBe('pass');
    expect(checked.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(checked.unverified + checked.unverifiedJunctions).toBe(0);
    const edges = checked.blends.filter((row) => row.kind === 'edge');
    expect(edges).toHaveLength(members);
    expect(edges.every((row) => row.profile === profileName && row.contacts.length === 2)).toBe(true);
    const joints = edges.flatMap((row) => row.junctions ?? []);
    expect(joints).toHaveLength(junctions);
    for (const joint of joints) {
      expect(joint.creaseRad).toBeCloseTo(crease, 3);
      expect(joint.g1AngleRad).toBeLessThanOrEqual((joint.creaseRad ?? 0) + 0.0095);
      expect(joint.g0Gap).toBeLessThanOrEqual(checked.tolerances.g0Profile?.value ?? 0);
    }
    return { error, data };
  };

  const rimTest = (profile: (typeof PROFILES)[number], s: number): void => {
    const points = regular(64, 50 * s);
    const body = prism(points, 20 * s);
    const started = performance.now();
    const done = made(body.doc, 'fillet_edge', {
      id: body.id,
      edgesNear: [sideNear(points, 0, 20 * s)],
      radius: s,
      profile: profile.profile,
    });
    const millis = performance.now() - started;
    const { area, moment } = section(profile.kind, 0.5, s);
    const { length, turns } = lengthAndTurns(points);
    const expected = -(area * length - 2 * moment * turns);
    const { error, data } = expectMitred(
      body,
      done,
      expected,
      64,
      64,
      (2 * Math.PI) / 64,
      profile.profile.type,
      `64-gon ${profile.profile.type} ${s} mm`,
      s === 1 || s === 1000,
    );
    rows.push(
      `| 64-gon rim ${profile.profile.type} | ${s} | ${data.gap.toExponential(2)} | ${data.junctionG1.toFixed(4)} (crease ${data.creaseRad.toFixed(4)}) | ${error.toExponential(2)} | ${millis.toFixed(0)} |`,
    );
  };

  it.each(SIZES)(
    'a 64-sided prism rim with a conic profile is mitred: gap, volume and check_blends, %d mm',
    (s) => rimTest(PROFILES[0], s),
    300_000,
  );
  it.each(SIZES)(
    'a 64-sided prism rim with a curvature profile is mitred: gap, volume and check_blends, %d mm',
    (s) => rimTest(PROFILES[1], s),
    300_000,
  );

  it.each(PROFILES)(
    'the concave foot ring of a 64-sided boss gets the mitred spandrel added: $profile.type',
    ({ kind, profile }) => {
      const s = 10;
      const points = regular(64, 50 * s);
      const plate = made(createEmptyDocument(), 'add_box', { size: [200 * s, 200 * s, 10 * s], position: [0, 0, 5 * s] });
      const boss = made(plate.doc, 'extrude_profile', { profile: points, depth: 30 * s });
      const fused = made(boss.doc, 'boolean', { op: 'union', a: plate.id, b: boss.id });
      expect(fused.result.error).toBeUndefined();
      const started = performance.now();
      const done = made(fused.doc, 'fillet_edge', { id: fused.id, edgesNear: [sideNear(points, 5, 10 * s)], radius: s, profile });
      const millis = performance.now() - started;
      const { area, moment } = section(kind, 0.5, s);
      const { length, turns } = lengthAndTurns(points);
      const { error, data } = expectMitred(
        fused,
        done,
        area * length + 2 * moment * turns,
        64,
        64,
        (2 * Math.PI) / 64,
        profile.type,
        `boss ring ${profile.type}`,
      );
      rows.push(
        `| boss foot ring ${profile.type} (concave) | ${s} | ${data.gap.toExponential(2)} | ${data.junctionG1.toFixed(4)} | ${error.toExponential(2)} | ${millis.toFixed(0)} |`,
      );
    },
    300_000,
  );

  /** A bar whose rim path is three segments of 30 turning by `turn` at both bends (left when positive), with square end walls and height 20. */
  const bar = (turn: number, s: number): { outline: Point[]; lower: Point[] } => {
    const angles = [0, turn, 2 * turn];
    const lower: Point[] = [[0, 0]];
    for (const a of angles) {
      const last = lower[lower.length - 1]!;
      lower.push([last[0] + 30 * s * Math.cos(a), last[1] + 30 * s * Math.sin(a)]);
    }
    const normal = (a: number): Point => [-Math.sin(a), Math.cos(a)];
    const upper = lower.map((point, k): Point => {
      const offset: Point =
        k === 0
          ? normal(angles[0]!)
          : k === angles.length
            ? normal(angles[k - 1]!)
            : (() => {
                const n0 = normal(angles[k - 1]!);
                const n1 = normal(angles[k]!);
                const m = 1 / (1 + n0[0] * n1[0] + n0[1] * n1[1]);
                return [(n0[0] + n1[0]) * m, (n0[1] + n1[1]) * m];
              })();
      return [point[0] + 20 * s * offset[0], point[1] + 20 * s * offset[1]];
    });
    return { outline: [...lower, ...upper.reverse()], lower };
  };

  it.each([0.099, -0.099])(
    'a bent bar at the sharpest crease OCCT still chains (%d rad) is mitred between its square end walls, conic and curvature, at 1 and 1000 mm',
    (turn) => {
      for (const s of [1, 1000]) {
        const { outline, lower } = bar(turn, s);
        const body = prism(outline, 10 * s);
        for (const { kind, profile } of PROFILES) {
          const started = performance.now();
          const done = made(body.doc, 'fillet_edge', { id: body.id, edgesNear: [sideNear(lower, 1, 10 * s)], radius: s, profile });
          const millis = performance.now() - started;
          const { area, moment } = section(kind, 0.5, s);
          // the three segments are 90 s long; the bends turn toward the material when the turn is positive
          const expected = -(area * 90 * s - 2 * moment * 2 * Math.tan(turn / 2));
          const { error, data } = expectMitred(
            body,
            done,
            expected,
            3,
            2,
            Math.abs(turn),
            profile.type,
            `bar ${turn} ${profile.type} ${s} mm`,
            true,
            1e-7,
          );
          rows.push(
            `| bent bar ${turn} ${profile.type} | ${s} | ${data.gap.toExponential(2)} | ${data.junctionG1.toFixed(4)} | ${error.toExponential(2)} | ${millis.toFixed(0)} |`,
          );
        }
      }
    },
    300_000,
  );

  it('a rim that mixes tangent arcs and creased bends: the smooth junctions keep the plain G1 rule (no creaseRad), the four bends are judged beyond their supports crease', () => {
    const { outline, lower } = bar(0.09, 1);
    const body = prism(outline, 10);
    const corners = [0, 3, 4, 7].map((k) => [outline[k]![0], outline[k]![1], 5]);
    const rounded = made(body.doc, 'fillet_edge', { id: body.id, edgesNear: corners, radius: 3 });
    expect(rounded.result.error).toBeUndefined();
    const done = made(rounded.doc, 'fillet_edge', {
      id: rounded.id,
      edgesNear: [sideNear(lower, 1, 10)],
      radius: 1,
      profile: PROFILES[0].profile,
    });
    expect(done.result.error).toBeUndefined();
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    const joints = checked.blends.filter((row) => row.profile === 'conic').flatMap((row) => row.junctions ?? []);
    const creased = joints.filter((joint) => joint.creaseRad !== undefined);
    expect(creased).toHaveLength(4);
    for (const joint of creased) expect(joint.creaseRad).toBeCloseTo(0.09, 3);
    const smooth = joints.filter((joint) => joint.creaseRad === undefined);
    expect(smooth.length).toBeGreaterThanOrEqual(8);
    for (const joint of smooth) expect(joint.g1AngleRad).toBeLessThanOrEqual(0.01);
  }, 300_000);

  it('a wavy outline of 240 corners with reflex and convex creases (turns -0.05 to +0.09 rad) is mitred with signed turns', () => {
    const points: Point[] = Array.from({ length: 240 }, (_, k) => {
      const a = (2 * Math.PI * k) / 240;
      const r = 50 * (1 + 0.1 * Math.sin(5 * a));
      return [r * Math.cos(a), r * Math.sin(a)] as const;
    });
    const body = prism(points, 20);
    const done = made(body.doc, 'fillet_edge', {
      id: body.id,
      edgesNear: [sideNear(points, 3, 20)],
      radius: 0.5,
      profile: PROFILES[0].profile,
    });
    expect(done.result.error).toBeUndefined();
    const { area, moment } = section(0, 0.5, 0.5);
    const { length, turns } = lengthAndTurns(points);
    const change = volume(done.doc, done.id) - volume(body.doc, body.id);
    expect(Math.abs(change + (area * length - 2 * moment * turns)) / Math.abs(change)).toBeLessThan(1e-6);
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    expect(checked.blends.filter((row) => row.kind === 'edge' && row.profile === 'conic')).toHaveLength(240);
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.creaseRad).toBeGreaterThan(0.05);
    expect(data.creaseRad).toBeLessThan(0.099);
  }, 300_000);

  it('replay and regeneration: replay_history gives the identical recipe and volume; an upstream edit re-mitres the chain', () => {
    const points = regular(64, 50);
    const body = prism(points, 20);
    const done = made(body.doc, 'fillet_edge', {
      id: body.id,
      edgesNear: [sideNear(points, 0, 20)],
      radius: 1,
      profile: PROFILES[0].profile,
    });
    expect(done.result.error).toBeUndefined();
    const recipe = (document: Doc): unknown => (document.entities[document.order[0] as string] as MeshSolidEntity).brep;
    const replayed = execute(done.doc, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(JSON.stringify(recipe(replayed.document))).toBe(JSON.stringify(recipe(done.doc)));
    const result = replayed.document.order[0] as string;
    expect(Math.abs(volume(replayed.document, result) - volume(done.doc, done.id))).toBeLessThan(1e-9 * volume(done.doc, done.id));
    const edited = execute(done.doc, 'edit_step_params', {
      stepId: done.doc.featureHistory[0]?.id,
      params: { profile: points, depth: 30 },
    });
    expect(edited.rejected).not.toBe(true);
    const longer = edited.document.order[0] as string;
    expect(check(edited.document, longer).status).toBe('pass');
    expect(volume(edited.document, longer)).toBeGreaterThan(volume(done.doc, done.id));
  }, 300_000);

  it('what is still refused is refused by name with the measured reason: a crease OCCT does not chain, a varying size on a creased chain, a corner of 8 sides', () => {
    // 0.1005 rad: OCCT does not chain the bends, the blend runs out onto the next wall
    const { outline, lower } = bar(0.1005, 1);
    const body = prism(outline, 10);
    const unchained = execute(body.doc, 'fillet_edge', {
      id: body.id,
      edgesNear: [sideNear(lower, 1, 10)],
      radius: 1,
      profile: PROFILES[0].profile,
    });
    expect(unchained.document).toBe(body.doc);
    expect(unchained.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', ids: [body.id] });
    expect(unchained.summary).toContain('crease of 0.1005 rad');
    expect(unchained.summary).toContain('about 0.1 rad');
    // 8 sides: a crease of 0.785 rad is a corner, not a chain
    const octagon = regular(8, 50);
    const corner = prism(octagon, 20);
    const sharp = execute(corner.doc, 'fillet_edge', {
      id: corner.id,
      edgesNear: [sideNear(octagon, 0, 20)],
      radius: 1,
      profile: PROFILES[0].profile,
    });
    expect(sharp.document).toBe(corner.doc);
    expect(sharp.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', ids: [corner.id] });
    expect(sharp.summary).toMatch(/runs out onto the next flat face at a crease of 0\.7\d* rad|away from square/);
    // a varying size on a creased chain: OCCT's variable-radius fillet cannot round it, so there is no circular blend to cut the profile from
    const points = regular(64, 50);
    const rim = prism(points, 20);
    const varying = execute(rim.doc, 'fillet_edge', {
      id: rim.id,
      edges: [{ near: sideNear(points, 0, 20), size: 1, sizeEnd: 1.5 }],
      profile: PROFILES[0].profile,
    });
    expect(varying.document).toBe(rim.doc);
    expect(varying.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(varying.summary).toContain('could not be built');
  }, 300_000);
});
