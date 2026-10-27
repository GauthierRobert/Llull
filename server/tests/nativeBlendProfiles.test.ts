/**
 * BLD M2 on the native OCCT kernel (docs/design/06-variable-blends, validation pack): conic, curvature-continuous and asymmetric blend sections
 * for straight edges between planar faces (VC-BLD-07, 08, 09, 15 refusals, 21); curved edges, varying sizes and corners: nativeBlendRails.test.ts. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
interface Face {
  readonly name?: string;
  readonly area: number;
  readonly surface?: string;
}
interface Contact {
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  readonly order: string;
}

describeNative('BLD M2: conic, curvature and asymmetric blend sections (native OCCT kernel)', () => {
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
  const block = (): { doc: Doc; id: string } => made(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const faces = (doc: Doc, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const topEdge = [0, 5, 2.5] as const;
  const fillet = (
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute>; before: { doc: Doc; id: string } } => {
    const before = block();
    return { ...made(before.doc, 'fillet_edge', { id: before.id, ...params }), before };
  };

  it.each([
    [0.25, 993.646111101],
    [Math.SQRT2 - 1, 995.707963268],
    [0.5, 996.666666667],
    [0.75, 998.912905349],
  ])('VC-BLD-07: conic rho %f on the block top edge removes the closed-form spandrel (V %f)', (rho, expected) => {
    const done = fillet({ edgesNear: [topEdge], radius: 1, profile: { type: 'conic', rho } });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - expected)).toBeLessThan(1e-3);
    const list = faces(done.doc, done.id);
    expect(list.some((face) => face.name === `blend(e(${done.before.id}:y+|${done.before.id}:z+))`)).toBe(true);
    expect(done.result.summary).toContain('conic profile');
  });

  it('VC-BLD-07: rho = sqrt 2 - 1 reproduces the circular fillet volume', () => {
    const circular = fillet({ edgesNear: [topEdge], radius: 1 });
    const conic = fillet({ edgesNear: [topEdge], radius: 1, profile: { type: 'conic', rho: Math.SQRT2 - 1 } });
    expect(Math.abs(volume(conic.doc, conic.id) - volume(circular.doc, circular.id))).toBeLessThan(1e-6);
  });

  it('VC-BLD-08: legs 1 (top) x 2 (side) with the circular section are the elliptic quarter: V 991.415927', () => {
    const done = fillet({ edges: [{ near: topEdge, size: 1, size2: 2, side1Near: [0, 0, 2.5] }] });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 991.415926536)).toBeLessThan(1e-3);
    const list = faces(done.doc, done.id);
    const top = list.find((face) => face.name === `${done.before.id}:z+`)?.area ?? 0;
    const side = list.find((face) => face.name === `${done.before.id}:y+`)?.area ?? 0;
    expect(top).toBeCloseTo(200 - 20 * 1, 6);
    expect(side).toBeCloseTo(100 - 20 * 2, 6);
    const swapped = fillet({ edges: [{ near: topEdge, size: 1, size2: 2, side1Name: `${done.before.id}:y+` }] });
    const swappedList = faces(swapped.doc, swapped.id);
    expect(swappedList.find((face) => face.name === `${swapped.before.id}:y+`)?.area).toBeCloseTo(100 - 20 * 1, 6);
    expect(swappedList.find((face) => face.name === `${swapped.before.id}:z+`)?.area).toBeCloseTo(200 - 20 * 2, 6);
  });

  it('VC-BLD-09: the curvature profile (shape 0.5, tangent distance 1) removes 0.1 d^2 L = 2 and is G2 at both contacts', () => {
    const done = fillet({ edgesNear: [topEdge], radius: 1, profile: { type: 'curvature', shape: 0.5 } });
    expect(done.result.error).toBeUndefined();
    expect(Math.abs(volume(done.doc, done.id) - 998)).toBeLessThan(1e-3);
    const check = execute(done.doc, 'check_blends', { require: 'G2' });
    const data = check.data as {
      status: string;
      blends: Array<{ profile: string; contacts: Contact[]; radius?: unknown }>;
      findings: Array<{ code: string }>;
    };
    expect(data.status).toBe('pass');
    expect(data.blends).toHaveLength(1);
    expect(data.blends[0]?.profile).toBe('curvature');
    expect(data.blends[0]).not.toHaveProperty('radius');
    expect(data.blends[0]?.contacts).toHaveLength(2);
    for (const contact of data.blends[0]?.contacts ?? []) {
      expect(contact.order).toBe('G2');
      expect(contact.g1AngleRad).toBeLessThan(1e-6);
      expect(contact.g2Gap).toBeLessThan(1e-6);
    }
    expect(data.findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_G2_JUMP');
  });

  it('a conic profile is G1 only: check_blends with require G2 fails with BLD_CHECK_G2_JUMP', () => {
    const done = fillet({ edgesNear: [topEdge], radius: 1, profile: { type: 'conic', rho: 0.5 } });
    const check = execute(done.doc, 'check_blends', { require: 'G2' });
    expect((check.data as { status: string }).status).toBe('fail');
    expect((check.data as { findings: Array<{ code: string }> }).findings.map((finding) => finding.code)).toContain('BLD_CHECK_G2_JUMP');
  });

  it('the profile blend stays an exact solid: later edits and STEP export see true faces', () => {
    const done = fillet({ edgesNear: [topEdge], radius: 1, profile: { type: 'conic', rho: 0.5 } });
    const analysis = execute(done.doc, 'inspect_topology', { id: done.id }).data as { faces: Face[] };
    expect(analysis.faces).toHaveLength(7);
    const next = made(done.doc, 'fillet_edge', { id: done.id, edgesNear: [[0, -5, 2.5]], radius: 0.5 });
    expect(next.result.error).toBeUndefined();
    expect(volume(next.doc, next.id)).toBeLessThan(volume(done.doc, done.id));
  });

  it('a concave edge gets the spandrel added (fuse): an L-shaped extrusion inner corner, conic rho 0.5, adds (1 - ...) d^2 L / 3', () => {
    const profile = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const l = made(createEmptyDocument(), 'extrude_profile', { profile, depth: 10 });
    const before = volume(l.doc, l.id);
    const done = made(l.doc, 'fillet_edge', { id: l.id, edgesNear: [[4, 4, 5]], radius: 1, profile: { type: 'conic', rho: 0.5 } });
    expect(done.result.error).toBeUndefined();
    // parabolic spandrel between the corner and the arc: 2/3 of the triangle d^2 / 2 ... removed area (1 - 2/3) d^2 / 2 = d^2 / 6; the fuse adds it
    expect(volume(done.doc, done.id) - before).toBeCloseTo(10 / 6, 3);
  });

  it('BLD_PROFILE_FAILED names what the kernel does not build: a second leg on a curved edge, a leg with a varying size, a third edge left sharp at a vertex, a size no fillet has', () => {
    const { doc, id } = block();
    const cylinder = made(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 10 });
    const legs = execute(cylinder.doc, 'fillet_edge', {
      id: cylinder.id,
      edges: [{ near: [5, 0, 5], size: 1, size2: 2, side1Near: [0, 0, 5] }],
    });
    expect(legs.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', ids: [cylinder.id] });
    expect(legs.summary).toContain('straight');
    expect(legs.document).toBe(cylinder.doc);
    const varying = execute(doc, 'fillet_edge', { id, edges: [{ near: topEdge, size: 1, sizeEnd: 2, size2: 2, side1Near: [0, 0, 2.5] }] });
    expect(varying.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', paths: ['edges[0].size2'] });
    const corner = execute(doc, 'fillet_edge', { id, edgesNear: [topEdge, [10, 0, 2.5]], radius: 1, profile: { type: 'conic', rho: 0.5 } });
    expect(corner.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(corner.summary).toContain('not rounded');
    const long = execute(doc, 'fillet_edge', { id, edgesNear: [topEdge], radius: 9, profile: { type: 'conic', rho: 0.5 } });
    expect(long.error).toMatchObject({ code: 'BLD_PROFILE_FAILED' });
    expect(long.summary).toContain('could not be built');
    expect(long.error?.remediation).toContain('circular profile');
  });

  it.each([64, 120])(
    'a %d-sided prism top rim: OCCT chains every side edge across creases of up to 0.1 rad, the profile blend mitres them, and every chain member reads as the conic profile in check_blends',
    (sides) => {
      const ring = (k: number): [number, number] => [50 * Math.cos((2 * Math.PI * k) / sides), 50 * Math.sin((2 * Math.PI * k) / sides)];
      const prism = made(createEmptyDocument(), 'extrude_profile', {
        profile: Array.from({ length: sides }, (_, k) => ring(k)),
        depth: 20,
      });
      const [a, b] = [ring(0), ring(1)];
      const near = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 20];
      const done = execute(prism.doc, 'fillet_edge', { id: prism.id, edgesNear: [near], radius: 1, profile: { type: 'conic', rho: 0.5 } });
      expect(done.error).toBeUndefined();
      const turn = (2 * Math.PI) / sides;
      const profile = (done.data as { profile: { builder: string; gap: number; gapLimit: number; creaseRad: number; junctionG1: number } })
        .profile;
      expect(profile.builder).toBe('rails');
      expect(profile.gap).toBeLessThanOrEqual(profile.gapLimit);
      expect(profile.creaseRad).toBeCloseTo(turn, 3);
      expect(done.summary).toContain('mitred across creases');
      // check_blends at its defaults reads every chain member as the profile (the kernel's chain: LawRecord.chain) and passes
      const checked = execute(done.document, 'check_blends', { ids: [done.affected[0] as string] }).data as {
        status: string;
        unverified: number;
        unverifiedJunctions: number;
        findings: Array<{ severity: string }>;
        blends: Array<{
          kind: string;
          profile: string;
          contacts: unknown[];
          junctions?: Array<{ creaseRad?: number; g1AngleRad: number }>;
        }>;
      };
      expect(checked.status).toBe('pass');
      // a conic is G1 only: its curvature jump against the supports is an info finding, never a warn or a fail
      expect(checked.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
      expect(checked.unverified + checked.unverifiedJunctions).toBe(0);
      const rows = checked.blends.filter((blend) => blend.kind === 'edge');
      expect(rows).toHaveLength(sides);
      expect(rows.every((blend) => blend.profile === 'conic' && blend.contacts.length === 2)).toBe(true);
      const junctions = rows.flatMap((blend) => blend.junctions ?? []);
      expect(junctions).toHaveLength(sides);
      for (const joint of junctions) {
        expect(joint.creaseRad).toBeCloseTo(turn, 3);
        expect(joint.g1AngleRad).toBeLessThanOrEqual(turn + 0.0095);
      }
      // the circular fillet of the same edge chains the same sides and reads as circular
      const circular = execute(prism.doc, 'fillet_edge', { id: prism.id, edgesNear: [near], radius: 1 });
      expect(circular.error).toBeUndefined();
      const plain = execute(circular.document, 'check_blends', { ids: [circular.affected[0] as string] }).data as {
        blends: Array<{ kind: string; profile: string }>;
      };
      expect(plain.blends.filter((blend) => blend.kind === 'edge' && blend.profile === 'circular')).toHaveLength(sides);
    },
    300_000,
  );

  it('BLD_RHO_RANGE and BLD_SHAPE_RANGE are refused before any build; the document is unchanged', () => {
    const { doc, id } = block();
    const rho = execute(doc, 'fillet_edge', { id, edgesNear: [topEdge], radius: 1, profile: { type: 'conic', rho: 1.2 } });
    expect(rho.document).toBe(doc);
    expect(rho.error).toMatchObject({ code: 'BLD_RHO_RANGE', ids: [id], paths: ['profile.rho'] });
    expect(execute(doc, 'fillet_edge', { id, edgesNear: [topEdge], radius: 1, profile: { type: 'conic' } }).error?.code).toBe(
      'BLD_RHO_RANGE',
    );
    const shape = execute(doc, 'fillet_edge', { id, edgesNear: [topEdge], radius: 1, profile: { type: 'curvature', shape: 0.01 } });
    expect(shape.error).toMatchObject({ code: 'BLD_SHAPE_RANGE', paths: ['profile.shape'] });
  });
});
