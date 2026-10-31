/**
 * DES-6c 13.39 on the native OCCT kernel: a vertex where two rounded edges meet a third edge that stays sharp, for a conic / curvature PROFILE (automatic corners, no `corners` entry) and for the
 * rolling-ball trim builder (a cylinder block, `corners` with a setback ball), through fillet_edge and read back by check_blends (the crease spoke). Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Contact {
  readonly order: string;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly creaseRad?: number;
}
interface Row {
  readonly kind: string;
  readonly contacts: readonly Contact[];
}
interface Face {
  readonly name?: string;
}
interface Reported {
  readonly corners: Array<{ readonly vertex: number[]; readonly crease: { readonly sharpEdge: number; readonly entryRad: number } }>;
  readonly profile?: {
    readonly cornerSetbackFactor: number;
    readonly corners: Array<{
      readonly patch: string;
      readonly continuity: string;
      readonly g2Refused?: string;
      readonly setbacks: unknown[];
    }>;
  };
}

describeNative('DES-6c 13.39: a sharp third edge at a profile corner and at a trimmed corner (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const faces = (doc: CadDocument, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const patches = (doc: CadDocument, id: string): Face[] => faces(doc, id).filter((face) => face.name?.startsWith('blend(v:'));
  const checked = (doc: CadDocument, id: string): { status: string; blends: Row[] } =>
    execute(doc, 'check_blends', { ids: [id] }).data as { status: string; blends: Row[] };

  // the box has its minimum corner at the origin: the vertex (0, 0, 0) has the edges along x, y (profiled here) and z (left sharp)
  const profiled = (profile: Record<string, unknown>): ReturnType<typeof execute> => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], anchor: 'min' });
    return execute(made.document, 'fillet_edge', {
      id: made.affected[0] as string,
      edgesNear: [
        [5, 0, 0],
        [0, 5, 0],
      ],
      radius: 1,
      profile,
    });
  };

  it('a conic profile on two edges of a vertex: a star of 5 with a crease spoke at the dihedral, the crease reported, check_blends reads it', () => {
    const done = profiled({ type: 'conic', rho: 0.5 });
    expect(done.error, done.summary).toBeUndefined();
    const id = done.affected[0] as string;
    const data = done.data as Reported;
    expect(data.corners).toHaveLength(1);
    expect(data.corners[0]?.crease.entryRad).toBeCloseTo(Math.PI / 2, 6);
    expect(done.summary).toContain('Sharp edge kept at 1 corner(s)');
    expect(data.profile?.corners).toHaveLength(1);
    expect(data.profile?.corners[0]?.setbacks).toHaveLength(3);
    expect(data.profile?.corners[0]?.patch).toBe('exact');
    expect(patches(done.document, id)).toHaveLength(5);
    // a parabola removes 1/6 of the section: the mitre is 996.7333, the star removes the sliver
    const own = volume(done.document, id);
    expect(own).toBeLessThan(996.7333);
    expect(own).toBeGreaterThan(995.7);
    const result = checked(done.document, id);
    expect(result.status).not.toBe('fail');
    const contacts = result.blends.filter((row) => row.kind === 'corner').flatMap((row) => row.contacts);
    const creases = contacts.filter((contact) => contact.order === 'crease');
    expect(creases).toHaveLength(2);
    for (const crease of creases) {
      expect(crease.creaseRad).toBeCloseTo(Math.PI / 2, 6);
      expect(crease.g1AngleRad).toBeLessThan(0.01);
    }
    for (const contact of contacts.filter((one) => one.order !== 'crease')) {
      expect(contact.g1AngleRad).toBeLessThan(0.01);
      expect(contact.g0Gap).toBeLessThan(1e-6 * Math.sqrt(300));
    }
  });

  it('a curvature profile gets the G1 star and the data says why it is not G2', () => {
    const done = profiled({ type: 'curvature', shape: 0.5 });
    expect(done.error, done.summary).toBeUndefined();
    const data = done.data as Reported;
    expect(data.corners[0]?.crease.entryRad).toBeCloseTo(Math.PI / 2, 6);
    expect(data.profile?.corners[0]?.continuity).toBe('G1');
    expect(data.profile?.corners[0]?.g2Refused).toContain('unrounded edge enters the hole');
    expect(checked(done.document, done.affected[0] as string).status).not.toBe('fail');
  });

  // A 10 x 10 x 5 block cut by a cylinder of radius 12 about the z axis: its corner (10, y, 5) has a straight top edge, a straight edge between the cylinder and the side plane, and the circular top edge.
  const block = (): { doc: CadDocument; id: string; y: number } => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 5], position: [5, 5, 2.5] });
    const cylinder = execute(box.document, 'add_cylinder', { radius: 12, height: 5, position: [0, 0, 2.5] });
    const cut = execute(cylinder.document, 'boolean', { op: 'intersect', a: box.affected[0], b: cylinder.affected[0], engine: 'kernel' });
    return { doc: cut.document, id: cut.affected[0] as string, y: Math.sqrt(144 - 100) };
  };

  it('the trim builder holds a sharp straight edge: a star of 5 with the crease reported, volume within 0.1 of the rolling-ball mitre', () => {
    const { doc, id, y } = block();
    const edgesNear: Array<[number, number, number]> = [
      [8.485, 8.485, 5],
      [10, y, 2.5],
    ];
    const plain = execute(doc, 'fillet_edge', { id, edgesNear, radius: 0.5 });
    expect(plain.error, plain.summary).toBeUndefined();
    const done = execute(doc, 'fillet_edge', {
      id,
      edgesNear,
      radius: 0.5,
      corners: [{ near: [10, y, 5], type: 'setback', setback: 1.2 }],
    });
    expect(done.error, done.summary).toBeUndefined();
    const result = done.affected[0] as string;
    expect(patches(done.document, result)).toHaveLength(5);
    const crease = (done.data as Reported).corners[0]?.crease;
    expect(crease?.entryRad).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(volume(done.document, result) - volume(plain.document, plain.affected[0] as string))).toBeLessThan(0.1);
    const read = checked(done.document, result);
    expect(read.status).not.toBe('fail');
    const creases = read.blends
      .filter((row) => row.kind === 'corner')
      .flatMap((row) => row.contacts)
      .filter((contact) => contact.order === 'crease');
    expect(creases).toHaveLength(2);
  });

  it('the trim builder refuses a CURVED sharp edge by name', () => {
    const { doc, id, y } = block();
    const done = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [10, 3, 5],
        [10, y, 2.5],
      ],
      radius: 0.5,
      corners: [{ near: [10, y, 5], type: 'setback', setback: 1.2 }],
    });
    expect(done.document).toBe(doc);
    expect(done.summary).toContain('BLD_CORNER_UNSUPPORTED');
    expect(done.summary).toContain('must be a straight line');
  });
});
