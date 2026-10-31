/**
 * BLD M2 remainder on the native OCCT kernel (DES-6c step 2, TECHNICAL_SPEC §13.11): conic and curvature profiles on curved edges and faces,
 * blends whose size varies, tangent chains of blends, G1 corner patches where profiled edges meet, and what is still refused. Every tolerance is
 * relative to the part (check_blends defaults: 1e-6 x diagonal, 5x for corner patches). Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface Face {
  readonly name?: string;
  readonly surface?: string;
}
interface Joint {
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  readonly order: string;
  readonly neighbour?: string;
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
  readonly tolerances: { readonly g0: { readonly value: number }; readonly g0Profile?: { readonly value: number } };
  readonly unverified: number;
  readonly unverifiedJunctions: number;
}
interface ProfileData {
  readonly builder: string;
  readonly gap?: number;
  readonly gapLimit?: number;
  readonly junctionG1?: number;
  readonly fallback?: { readonly edges: string[]; readonly reason: string };
  readonly cornerSetbackFactor?: number;
  readonly corners?: Array<{ readonly setbacks: Array<{ readonly distance: number }> }>;
}

/** 2 pi |closed integral of rho^2 / 2 dz| over corner -> a, the rational quadratic a, t, b of weight w, b -> corner: the revolved spandrel. */
function revolvedSpandrel(a: readonly [number, number], t: readonly [number, number], b: readonly [number, number], w: number): number {
  const n = 40000;
  let sum = 0;
  let previous = a;
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    const basis = [(1 - u) * (1 - u), 2 * u * (1 - u) * w, u * u] as const;
    const norm = basis[0] + basis[1] + basis[2];
    const point = [
      (basis[0] * a[0] + basis[1] * t[0] + basis[2] * b[0]) / norm,
      (basis[0] * a[1] + basis[1] * t[1] + basis[2] * b[1]) / norm,
    ] as const;
    sum += 0.25 * (previous[0] ** 2 + point[0] ** 2) * (point[1] - previous[1]);
    previous = point;
  }
  const line = (from: readonly [number, number], to: readonly [number, number]): number =>
    0.25 * (from[0] ** 2 + to[0] ** 2) * (to[1] - from[1]);
  return 2 * Math.PI * Math.abs(sum + line(b, t) + line(t, a));
}

describeNative('BLD M2 remainder: profiles on curved edges and faces, varying sizes, corners (native OCCT kernel)', () => {
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
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const check = (doc: Doc, id: string, extra: Record<string, unknown> = {}): Checked =>
    execute(doc, 'check_blends', { ids: [id], ...extra }).data as Checked;
  const cylinder = (radius: number, height: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'add_cylinder', { radius, height, anchor: 'base-center' });
  const box = (size: [number, number, number]): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size, anchor: 'min' });
  const contactsOf = (checked: Checked, kind?: string): Row['contacts'][number][] =>
    checked.blends.filter((row) => kind === undefined || row.kind === kind).flatMap((row) => [...row.contacts]);

  it('a conic rim of a cylinder removes the revolved spandrel and passes check_blends (G1)', () => {
    const { doc, id } = cylinder(10, 20);
    const done = made(doc, 'fillet_edge', { id, edgesNear: [[10, 0, 20]], radius: 2, profile: { type: 'conic', rho: 0.5 } });
    expect(done.result.error).toBeUndefined();
    const expected = revolvedSpandrel([8, 20], [10, 20], [10, 18], 1);
    expect(Math.abs(volume(doc, id) - volume(done.doc, done.id) - expected)).toBeLessThan(1e-6 * expected);
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    expect(checked.blends).toHaveLength(1);
    expect(checked.blends[0]?.profile).toBe('conic');
    expect(checked.blends[0]?.contacts).toHaveLength(2);
    expect(faces(done.doc, done.id).some((face) => face.name?.startsWith('blend(e('))).toBe(true);
  });

  it('a curvature rim is G2 to a plane and a cylinder; on a sphere band it matches the curvature of the sphere', () => {
    const rim = cylinder(10, 20);
    const flat = made(rim.doc, 'fillet_edge', {
      id: rim.id,
      edgesNear: [[10, 0, 20]],
      radius: 2,
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(flat.result.error).toBeUndefined();
    const flatCheck = check(flat.doc, flat.id, { require: 'G2' });
    expect(flatCheck.status).toBe('pass');
    for (const contact of contactsOf(flatCheck)) expect(contact.order).toBe('G2');
    const sphere = made(createEmptyDocument(), 'add_sphere', { radius: 5 });
    const slab = made(sphere.doc, 'add_box', { size: [20, 20, 5] });
    const band = made(slab.doc, 'boolean', { op: 'intersect', a: sphere.id, b: slab.id });
    expect(band.result.error).toBeUndefined();
    const top = Math.sqrt(25 - 2.5 ** 2);
    const done = made(band.doc, 'fillet_edge', {
      id: band.id,
      edgesNear: [
        [top, 0, 2.5],
        [top, 0, -2.5],
      ],
      radius: 0.4,
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    const checked = check(done.doc, done.id, { require: 'G2' });
    expect(checked.status).toBe('pass');
    expect(contactsOf(checked)).toHaveLength(4);
    for (const contact of contactsOf(checked)) {
      expect(contact.order).toBe('G2');
      expect(contact.g2Gap * 5).toBeLessThan(1e-6);
    }
    const conic = made(band.doc, 'fillet_edge', {
      id: band.id,
      edgesNear: [[top, 0, 2.5]],
      radius: 0.4,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(check(conic.doc, conic.id, { require: 'G2' }).status).toBe('fail');
  });

  it('the concave ring around a boss gets material added: the revolved spandrel on the outside', () => {
    const plate = made(createEmptyDocument(), 'add_box', { size: [60, 60, 5], anchor: 'min' });
    const boss = made(plate.doc, 'add_cylinder', { radius: 10, height: 15, position: [30, 30, 5], anchor: 'base-center' });
    const fused = made(boss.doc, 'boolean', { op: 'union', a: plate.id, b: boss.id });
    expect(fused.result.error).toBeUndefined();
    const done = made(fused.doc, 'fillet_edge', {
      id: fused.id,
      edgesNear: [[40, 30, 5]],
      radius: 2,
      profile: { type: 'conic', rho: 0.4 },
    });
    expect(done.result.error).toBeUndefined();
    const expected = revolvedSpandrel([12, 0], [10, 0], [10, 2], 0.4 / 0.6);
    expect(Math.abs(volume(done.doc, done.id) - volume(fused.doc, fused.id) - expected)).toBeLessThan(1e-6 * expected);
    expect(check(done.doc, done.id).status).toBe('pass');
  });

  it('a size that varies (radiusEnd, edges[].sizes, law) is built with a profile: contact lines of the circular fillet, section area in the conic ratio', () => {
    const { doc, id } = box([20, 10, 10]);
    const circular = made(doc, 'fillet_edge', { id, edges: [{ near: [10, 10, 10], size: 1, sizeEnd: 2 }] });
    const conic = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10, 10, 10], size: 1, sizeEnd: 2 }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(conic.result.error).toBeUndefined();
    const ratio = 1 / 6 / (1 - Math.PI / 4);
    const removedCircular = volume(doc, id) - volume(circular.doc, circular.id);
    const removedConic = volume(doc, id) - volume(conic.doc, conic.id);
    expect(Math.abs(removedConic - ratio * removedCircular)).toBeLessThan(1e-4 * removedCircular);
    const checked = check(conic.doc, conic.id);
    expect(checked.status).toBe('pass');
    expect(checked.blends[0]?.profile).toBe('conic');
    const shorthand = made(doc, 'fillet_edge', {
      id,
      edgesNear: [[10, 10, 10]],
      radius: 1,
      radiusEnd: 2,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(volume(shorthand.doc, shorthand.id)).toBeCloseTo(volume(conic.doc, conic.id), 9);
    const piecewise = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10, 10, 10], size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' }],
      profile: { type: 'curvature', shape: 0.4 },
    });
    expect(piecewise.result.error).toBeUndefined();
    expect(check(piecewise.doc, piecewise.id, { require: 'G2' }).status).toBe('pass');
    const expression = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10, 10, 10], law: { expression: '1 + 0.5 * sin(pi * t)', samples: 9 } }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(expression.result.error).toBeUndefined();
  });

  it('a profile follows a tangent chain: the loop of a rounded outline is one closed blend, even when one edge is picked', () => {
    const slab = box([40, 30, 6]);
    const vertical = made(slab.doc, 'fillet_edge', {
      id: slab.id,
      edgesNear: [
        [0, 0, 3],
        [40, 0, 3],
        [0, 30, 3],
        [40, 30, 3],
      ],
      radius: 5,
    });
    expect(vertical.result.error).toBeUndefined();
    const all = made(vertical.doc, 'fillet_edge', {
      id: vertical.id,
      edgesNear: [[20, 30, 6]],
      radius: 1.5,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(all.result.error).toBeUndefined();
    const checked = check(all.doc, all.id);
    expect(checked.status).toBe('pass');
    expect(checked.blends.filter((row) => row.profile === 'conic')).toHaveLength(8);
    expect(checked.blends.filter((row) => row.profile === 'circular')).toHaveLength(4);
    // the 8 junctions between consecutive blends of the loop are measured: closed to the default g0 and tangent
    const junctions = checked.blends.flatMap((row) => [...(row.junctions ?? [])]);
    expect(junctions).toHaveLength(8);
    for (const joint of junctions) {
      expect(joint.g0Gap).toBeLessThan(checked.tolerances.g0.value);
      expect(joint.g1AngleRad).toBeLessThan(1e-3);
      expect(joint.neighbour).toContain('blend(e(');
    }
    const flat = made(vertical.doc, 'fillet_edge', {
      id: vertical.id,
      edgesNear: [[20, 30, 6]],
      radius: 1.5,
      profile: { type: 'curvature', shape: 0.5 },
    });
    const curvature = check(flat.doc, flat.id, { require: 'G2' }).blends.filter((row) => row.profile === 'curvature');
    expect(curvature).toHaveLength(8);
    for (const contact of curvature.flatMap((row) => [...row.contacts])) expect(contact.order).toBe('G2');
  });

  it('edges that meet at a vertex are profiled together and get G1 corner patches (a cube, every edge)', () => {
    const { doc, id } = box([10, 10, 10]);
    const done = made(doc, 'fillet_edge', { id, radius: 1, profile: { type: 'conic', rho: 0.5 } });
    expect(done.result.error).toBeUndefined();
    const list = faces(done.doc, done.id);
    expect(list).toHaveLength(66);
    expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(48);
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    expect(checked.blends.filter((row) => row.kind === 'corner')).toHaveLength(48);
    const solid = volume(done.doc, done.id);
    // golden of this build (the exact corner stars of 13.21; the thin-plate fill gave 975.822), and the analytic upper bound with the setbacks it chose:
    // the 12 parabolic prisms (area d^2 / 6) over the edge less a setback at each end are removed at least
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.builder).toBe('corners');
    const setback = data.corners?.[0]?.setbacks[0]?.distance ?? 0;
    expect(setback).toBeCloseTo(2, 9);
    expect(solid).toBeLessThan(1000 - 12 * (10 - 2 * setback) * (1 / 6));
    expect(Math.abs(solid - 974.138)).toBeLessThan(0.05);
    // and it stays within 2e-3 of the circular rolling-ball cube (975.587), whose edges remove 4.7 mm3 more over the same span (the centre of a star is a calibrated height: 13.21.4)
    const circular = made(box([10, 10, 10]).doc, 'fillet_edge', { id: 'box-1.1', radius: 1 });
    expect(Math.abs(solid - volume(circular.doc, circular.id)) / solid).toBeLessThan(2e-3);
  });

  it('reports how the corners were made: the setback factor and the setback of every edge at every corner, in data and in the summary', () => {
    const { doc, id } = box([10, 10, 10]);
    const done = made(doc, 'fillet_edge', { id, radius: 1, profile: { type: 'curvature', shape: 0.5 } });
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.cornerSetbackFactor).toBe(2);
    expect(data.corners).toHaveLength(8);
    for (const corner of data.corners ?? []) for (const entry of corner.setbacks) expect(entry.distance).toBeCloseTo(2, 9);
    expect(done.result.summary).toContain('8 corner patch(es), setback 2 x the least distance');
  });

  it('reports the measured gap to the neighbouring faces in data; a part too small for the circular blend OCCT gives is refused with the gap', () => {
    const rim = cylinder(10, 20);
    const done = made(rim.doc, 'fillet_edge', { id: rim.id, edgesNear: [[10, 0, 20]], radius: 2, profile: { type: 'conic', rho: 0.5 } });
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.builder).toBe('rails');
    expect(data.gap).toBeLessThanOrEqual(data.gapLimit ?? 0);
    expect(data.gapLimit).toBeGreaterThan(0);
    expect(done.result.summary).toContain('measured gap');
    // a 0.3 mm sphere band: OCCT's own circular blend is a few 1e-6 off its supports (absolute), above 5e-6 x the diagonal
    const small = 0.03;
    const ball = made(createEmptyDocument(), 'add_sphere', { radius: 5 * small });
    const slab = made(ball.doc, 'add_box', { size: [20 * small, 20 * small, 5 * small] });
    const band = made(slab.doc, 'boolean', { op: 'intersect', a: ball.id, b: slab.id });
    const top = Math.sqrt((5 * small) ** 2 - (2.5 * small) ** 2);
    const refused = execute(band.doc, 'fillet_edge', {
      id: band.id,
      edgesNear: [
        [top, 0, 2.5 * small],
        [top, 0, -2.5 * small],
      ],
      radius: 0.4 * small,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(refused.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(refused.summary).toContain('meet their neighbours only to');
    expect(refused.document).toBe(band.doc);
  });

  const roundedCap = (): { doc: Doc; id: string } => {
    const ball = made(createEmptyDocument(), 'add_sphere', { radius: 20 });
    const stadium = made(ball.doc, 'add_box', { size: [20, 12, 60] });
    const rounded = made(stadium.doc, 'fillet_edge', {
      id: stadium.id,
      edgesNear: [
        [10, 6, 0],
        [-10, 6, 0],
        [10, -6, 0],
        [-10, -6, 0],
      ],
      radius: 4,
    });
    const cap = made(rounded.doc, 'boolean', { op: 'intersect', a: ball.id, b: rounded.id });
    expect(cap.result.error).toBeUndefined();
    return cap;
  };

  it('a curvature chain over walls that change curvature falls back to the G1 quartic: reported in the summary and in data, the edges named, the junctions held to 0.01 rad', () => {
    const cap = roundedCap();
    const done = made(cap.doc, 'fillet_edge', {
      id: cap.id,
      edgesNear: [[8.765, -4.89, 17.299]],
      radius: 0.5,
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    const data = (done.result.data as { profile: ProfileData }).profile;
    expect(data.fallback?.edges.length).toBeGreaterThan(1);
    expect(data.fallback?.reason).toContain('support curvature jumps');
    expect(data.junctionG1).toBeGreaterThan(1e-3);
    expect(data.junctionG1).toBeLessThanOrEqual(0.0095);
    expect(done.result.summary).toContain('fell back to the G1 quartic');
    expect(done.result.summary).toContain('blends of a chain meet at up to');
    for (const name of data.fallback?.edges ?? []) expect(done.result.summary).toContain(name);
    // fillet_edge never returns a shape its own check_blends default fails: the junctions are measured and within g1AngleRad and g0Profile
    const checked = check(done.doc, done.id);
    expect(checked.status).toBe('pass');
    const junctions = checked.blends.flatMap((row) => [...(row.junctions ?? [])]);
    expect(junctions.length).toBeGreaterThan(0);
    for (const joint of junctions) {
      expect(joint.g1AngleRad).toBeLessThan(0.01);
      expect(joint.g0Gap).toBeLessThan(checked.tolerances.g0Profile?.value ?? 0);
    }
    expect(checked.tolerances.g0Profile?.value).toBeCloseTo(5 * checked.tolerances.g0.value, 9);
    expect(checked.unverifiedJunctions).toBe(0);
    // a circular rim that builds in the curved pass reports no fallback
    const rim = cylinder(10, 20);
    const clean = made(rim.doc, 'fillet_edge', {
      id: rim.id,
      edgesNear: [[10, 0, 20]],
      radius: 2,
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect((clean.result.data as { profile: ProfileData }).profile.fallback).toBeUndefined();
  });

  it('a chain whose blends would meet at more than the check_blends G1 default is refused with the angle and the passes; a conic of the same blend builds and reports its angle', () => {
    const cap = roundedCap();
    const picked = { id: cap.id, edgesNear: [[8.765, -4.89, 17.299]], radius: 1 };
    const refused = execute(cap.doc, 'fillet_edge', { ...picked, profile: { type: 'curvature', shape: 0.5 } });
    expect(refused.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(refused.summary).toContain('zero-curvature quartic');
    expect(refused.summary).toContain('limit 0.0095 rad');
    expect(refused.document).toBe(cap.doc);
    const conic = made(cap.doc, 'fillet_edge', { ...picked, profile: { type: 'conic', rho: 0.5 } });
    expect(conic.result.error).toBeUndefined();
    const angle = (conic.result.data as { profile: ProfileData }).profile.junctionG1 ?? 1;
    expect(angle).toBeGreaterThan(1e-3);
    expect(angle).toBeLessThanOrEqual(0.0095);
    expect(check(conic.doc, conic.id).status).toBe('pass');
  });

  it('two separate steps never make a junction: a rim blend and a later blend that meet at a crease give no junction row and no unmeasured warning', () => {
    const cube = made(createEmptyDocument(), 'add_box', { size: [20, 20, 20], anchor: 'min' });
    const first = made(cube.doc, 'fillet_edge', { id: cube.id, edgesNear: [[10, 0, 20]], radius: 2 });
    const second = made(first.doc, 'fillet_edge', { id: first.id, edgesNear: [[0, 0, 10]], radius: 3 });
    expect(second.result.error).toBeUndefined();
    const checked = check(second.doc, second.id);
    expect(checked.blends.flatMap((row) => [...(row.junctions ?? [])])).toEqual([]);
    expect(checked.unverified).toBe(0);
    expect(checked.unverifiedJunctions).toBe(0);
    expect(checked.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_UNVERIFIED_CONTACT');
  });

  it('works at every size: G0 and G1 pass check_blends from a 1 mm to a 1000 mm part (the part is 10 s across), relative to the part', () => {
    for (const size of [1, 10, 100, 1000]) {
      const cases: Array<[string, (s: number) => ReturnType<typeof made>]> = [
        [
          'rim conic',
          (s) => {
            const rim = cylinder(5 * s, 10 * s);
            return made(rim.doc, 'fillet_edge', {
              id: rim.id,
              edgesNear: [[5 * s, 0, 10 * s]],
              radius: s,
              profile: { type: 'conic', rho: 0.5 },
            });
          },
        ],
        [
          'rim curvature varying',
          (s) => {
            const rim = cylinder(5 * s, 10 * s);
            return made(rim.doc, 'fillet_edge', {
              id: rim.id,
              edges: [{ near: [5 * s, 0, 10 * s], size: s, sizeEnd: s, sizes: [{ t: 0.5, size: 0.5 * s }] }],
              profile: { type: 'curvature', shape: 0.5 },
            });
          },
        ],
        [
          'variable straight edge',
          (s) => {
            const block = box([20 * s, 10 * s, 10 * s]);
            return made(block.doc, 'fillet_edge', {
              id: block.id,
              edges: [{ near: [10 * s, 10 * s, 10 * s], size: s, sizeEnd: 2 * s }],
              profile: { type: 'conic', rho: 0.4 },
            });
          },
        ],
        [
          'cube corners',
          (s) => {
            const cube = box([10 * s, 10 * s, 10 * s]);
            return made(cube.doc, 'fillet_edge', { id: cube.id, radius: s, profile: { type: 'curvature', shape: 0.5 } });
          },
        ],
      ];
      for (const [label, build] of cases) {
        const done = build(size / 10);
        expect(done.result.error, `${label} at ${size}`).toBeUndefined();
        const checked = check(done.doc, done.id);
        expect(checked.status, `${label} at ${size}`).toBe('pass');
        expect(checked.findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
        expect(contactsOf(checked).length).toBeGreaterThan(0);
      }
    }
  }, 180_000);

  it('replay and regeneration: an upstream edit re-runs the profile on the same edge; replay_history gives the identical recipe', () => {
    const { doc, id } = cylinder(10, 20);
    const done = made(doc, 'fillet_edge', {
      id,
      edges: [{ near: [10, 0, 20], size: 2, sizeEnd: 2, sizes: [{ t: 0.5, size: 1.5 }] }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(done.result.error).toBeUndefined();
    const recipe = (document: Doc): unknown => (document.entities[document.order[0] as string] as MeshSolidEntity).brep;
    const replayed = execute(done.doc, 'replay_history', {});
    expect(replayed.rejected).not.toBe(true);
    expect(JSON.stringify(recipe(replayed.document))).toBe(JSON.stringify(recipe(done.doc)));
    const edited = execute(done.doc, 'edit_step_params', {
      stepId: done.doc.featureHistory[0]?.id,
      params: { radius: 14, height: 20, anchor: 'base-center' },
    });
    expect(edited.rejected).not.toBe(true);
    expect((recipe(edited.document) as { op: string; profile?: unknown }).profile).toEqual({ type: 'conic', rho: 0.5 });
    const result = edited.document.order[0] as string;
    expect(check(edited.document, result).status).toBe('pass');
    expect(volume(edited.document, result)).toBeGreaterThan(volume(done.doc, done.id));
  });

  it('BLD_PROFILE_FAILED names what is still not built: a third edge left sharp at a vertex, a second leg on a curved edge or with a varying size, a size no fillet has', () => {
    const { doc, id } = box([20, 10, 10]);
    const sharp = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [10, 0, 10],
        [20, 5, 10],
      ],
      radius: 1,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(sharp.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', ids: [id] });
    expect(sharp.summary).toContain('not rounded');
    expect(sharp.document).toBe(doc);
    const rim = cylinder(10, 20);
    const legs = execute(rim.doc, 'fillet_edge', { id: rim.id, edges: [{ near: [10, 0, 20], size: 1, size2: 2, side1Near: [0, 0, 20] }] });
    expect(legs.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(legs.summary).toContain('straight');
    const both = execute(doc, 'fillet_edge', { id, edges: [{ near: [10, 5, 10], size: 1, sizeEnd: 2, size2: 2, side1Near: [10, 5, 10] }] });
    expect(both.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', paths: ['edges[0].size2'] });
    const atVertex = [
      [10, 0, 10],
      [20, 5, 10],
      [20, 0, 5],
    ];
    for (const picked of [atVertex.slice(0, 2), atVertex]) {
      const varying = execute(doc, 'fillet_edge', {
        id,
        edges: picked.map((near) => ({ near, size: 1, sizeEnd: 2 })),
        profile: { type: 'conic', rho: 0.5 },
      });
      expect(varying.error, `${picked.length} edges`).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
      expect(varying.summary).toContain('meet at a vertex need one constant size');
    }
    const huge = execute(doc, 'fillet_edge', { id, edgesNear: [[10, 5, 10]], radius: 12, profile: { type: 'conic', rho: 0.5 } });
    expect(huge.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(huge.error?.remediation).toContain('circular profile');
  });
});
