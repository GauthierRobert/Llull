/**
 * DES-6c (06 BLD §13.40): the curvature (G2) profile with two legs (`size2`) on a cylinder rim and a sphere cap, on the native OCCT kernel. check_blends must read
 * G2 at both contacts (the section takes each support's normal curvature in the station plane), the removed volume is compared with an integral the test
 * computes itself (the quintic section revolved about the axis), and the legs read back. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
type P = readonly [number, number];
interface Contact {
  readonly order: string;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
}
interface Checked {
  readonly status: string;
  readonly blends: ReadonlyArray<{ readonly profile: string; readonly radius?: unknown; readonly contacts: readonly Contact[] }>;
  readonly legs?: ReadonlyArray<{
    readonly op: string;
    readonly maxDeviation: number | null;
    readonly legs: ReadonlyArray<{ first: number; second: number }>;
  }>;
  readonly findings: ReadonlyArray<{ code: string; severity: string }>;
  readonly unverified: number;
}

const lerp = (from: P, to: P, k: number): P => [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];

/** 2 pi |closed integral of rho^2 / 2 dz| over the closed polygon `points` (rho, z): the volume of its revolution. */
function revolved(points: readonly P[]): number {
  let sum = 0;
  points.forEach((p, k) => {
    const q = points[(k + 1) % points.length] as P;
    sum += ((p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) / 6) * (q[1] - p[1]);
  });
  return 2 * Math.PI * Math.abs(sum);
}

/** The curvature section a, t, b of shape `shape`: the quintic whose 3rd / 4th poles are moved by `bendA` / `bendB`, sampled at n + 1 points. */
function quintic(a: P, t: P, b: P, shape: number, bendA: P, bendB: P, n = 20000): P[] {
  const [lead, reach] = [0.8 * shape, 0.4 * shape + 0.6];
  const [pa, pb] = [lerp(a, t, reach), lerp(b, t, reach)];
  const poles: P[] = [a, lerp(a, t, lead), [pa[0] + bendA[0], pa[1] + bendA[1]], [pb[0] + bendB[0], pb[1] + bendB[1]], lerp(b, t, lead), b];
  const binomial = [1, 5, 10, 10, 5, 1];
  return Array.from({ length: n + 1 }, (_, k) => {
    const u = k / n;
    return poles.reduce<P>(
      (sum, p, i) => {
        const weight = (binomial[i] as number) * u ** i * (1 - u) ** (5 - i);
        return [sum[0] + weight * p[0], sum[1] + weight * p[1]];
      },
      [0, 0],
    );
  });
}

describeNative('DES-6c 13.40: the curvature profile with two legs (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
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
  const check = (doc: Doc, id: string, require?: 'G2'): Checked =>
    execute(doc, 'check_blends', { ids: [id], ...(require ? { require } : {}) }).data as Checked;
  const contactsOf = (checked: Checked): Contact[] => checked.blends.flatMap((row) => [...row.contacts]);

  it('a cylinder rim with legs 1 (top) x 3 (side) is G2 to both supports, removes the revolved quintic, and reads its legs back', () => {
    const rim = made(createEmptyDocument(), 'add_cylinder', { radius: 10, height: 20, anchor: 'base-center' });
    const done = made(rim.doc, 'fillet_edge', {
      id: rim.id,
      edges: [{ near: [10, 0, 20], size: 1, size2: 3, side1Near: [0, 0, 20] }],
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    const expected = revolved([[10, 20], ...quintic([9, 20], [10, 20], [10, 17], 0.5, [0, 0], [0, 0])]);
    expect(Math.abs(volume(rim.doc, rim.id) - volume(done.doc, done.id) - expected)).toBeLessThan(3e-6 * expected);
    const checked = check(done.doc, done.id, 'G2');
    expect(checked.status).toBe('pass');
    const contacts = contactsOf(checked);
    expect(contacts).toHaveLength(2);
    for (const contact of contacts) {
      expect(contact.order).toBe('G2');
      expect(contact.g1AngleRad).toBeLessThan(1e-4);
      expect(contact.g0Gap).toBeLessThan(1e-6 * 34.6);
    }
    expect(checked.blends[0]?.radius).toBeUndefined();
    const [row] = checked.legs ?? [];
    expect(row).toMatchObject({ op: 'fillet' });
    expect(row?.maxDeviation).toBeLessThan(1e-3);
    expect(row?.legs[0]).toMatchObject({ first: expect.closeTo(1, 3), second: expect.closeTo(3, 3) });
  });

  it('a sphere cap (R 10 cut at z = 5) with legs 1 (top) x 3 (sphere chord) is G2 to the plane and to the sphere, and removes the revolved quintic bent by 1 / R', () => {
    const ball = made(createEmptyDocument(), 'add_sphere', { radius: 10 });
    const block = made(ball.doc, 'add_box', { size: [30, 30, 20], anchor: 'min', position: [-15, -15, -15] });
    const cap = made(block.doc, 'boolean', { op: 'intersect', a: ball.id, b: block.id });
    expect(cap.result.error).toBeUndefined();
    const [r, z, dTop, dSphere, shape] = [10, 5, 1, 3, 0.5];
    const rho = Math.sqrt(r * r - z * z);
    const done = made(cap.doc, 'fillet_edge', {
      id: cap.id,
      edges: [{ near: [rho, 0, z], size: dTop, size2: dSphere, side1Near: [0, 0, z] }],
      profile: { type: 'curvature', shape },
    });
    expect(done.result.error).toBeUndefined();
    // B: the meridian point at the chord dSphere below the corner; T: the plane line meets the tangent of the sphere at B
    const toCorner = Math.hypot(rho, z);
    const along = (toCorner * toCorner + r * r - dSphere * dSphere) / (2 * toCorner);
    const height = Math.sqrt(r * r - along * along);
    const unit: P = [rho / toCorner, z / toCorner];
    const candidates: P[] = [
      [along * unit[0] + height * -unit[1], along * unit[1] + height * unit[0]],
      [along * unit[0] - height * -unit[1], along * unit[1] - height * unit[0]],
    ];
    const b = ((candidates[0] as P)[1] < (candidates[1] as P)[1] ? candidates[0] : candidates[1]) as P;
    const a: P = [rho - dTop, z];
    const t: P = [(r * r - z * b[1]) / b[0], z];
    // the sphere curves toward its centre (1 / R) at B, on the side of A: the 4th pole moves by 1.25 kappa lead^2 that way
    const reach = Math.hypot(t[0] - b[0], t[1] - b[1]);
    const lead = 0.8 * shape * reach;
    const radial: P = [b[0] / r, b[1] / r];
    const side = radial[0] * (a[0] - b[0]) + radial[1] * (a[1] - b[1]) > 0 ? 1 : -1;
    const offset = (1.25 / r) * lead * lead;
    const outline: P[] = [[rho, z], a, ...quintic(a, t, b, shape, [0, 0], [side * radial[0] * offset, side * radial[1] * offset])];
    const [start, end] = [Math.atan2(b[1], b[0]), Math.atan2(z, rho)];
    for (let k = 0; k <= 20000; k++) {
      const angle = start + ((end - start) * k) / 20000;
      outline.push([r * Math.cos(angle), r * Math.sin(angle)]);
    }
    const expected = revolved(outline);
    expect(Math.abs(volume(cap.doc, cap.id) - volume(done.doc, done.id) - expected)).toBeLessThan(1e-5 * expected);
    const checked = check(done.doc, done.id, 'G2');
    expect(checked.status).toBe('pass');
    const contacts = contactsOf(checked);
    expect(contacts).toHaveLength(2);
    for (const contact of contacts) {
      expect(contact.order).toBe('G2');
      expect(contact.g1AngleRad).toBeLessThan(1e-4);
    }
    expect(checked.legs?.[0]?.maxDeviation).toBeLessThan(1e-3);
    expect(checked.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_G2_JUMP');
  });

  it('refuses by name when the supports curvature gives no G2 section: a ball on a plate curves away from the corner', () => {
    const plate = made(createEmptyDocument(), 'add_box', { size: [60, 60, 5], anchor: 'min', position: [-30, -30, 0] });
    const ball = made(plate.doc, 'add_sphere', { radius: 5, position: [0, 0, 7] });
    const joined = made(ball.doc, 'boolean', { op: 'union', a: plate.id, b: ball.id });
    expect(joined.result.error).toBeUndefined();
    const foot = Math.sqrt(25 - 4);
    const refused = execute(joined.doc, 'fillet_edge', {
      id: joined.id,
      edges: [{ near: [foot, 0, 5], size: 1, size2: 3, side1Near: [20, 0, 5] }],
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(refused.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(refused.summary).toContain('leaves the triangle of its tangent lines');
    expect(refused.summary).toContain('normal curvatures 0 and -0.2');
    expect(refused.document).toBe(joined.doc);
  });
});
