/**
 * DES-6c 13.33 on the native OCCT kernel: a setback corner at a vertex where two rounded edges meet a third edge that stays sharp (two top edges of a box rounded, the vertical one left),
 * through fillet_edge corners and read back by check_blends (the crease spoke), plus the sealed shell refusal of a solid with star corner faces (13.33.5). Skipped when the llull-kernel
 * binary is not built.
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
  readonly profile: string;
  readonly contacts: readonly Contact[];
}
interface Face {
  readonly name?: string;
  readonly surface: string;
}

describeNative('DES-6c 13.33: a sharp third edge at a setback corner (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const cube = (): { doc: CadDocument; id: string } => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    return { doc: made.document, id: made.affected[0] as string };
  };
  const faces = (doc: CadDocument, id: string): Face[] => (execute(doc, 'inspect_topology', { id }).data as { faces: Face[] }).faces;
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  // the box is centred on the origin: its vertex (-5, -5, -5) has the edges along x, y (rounded here) and z (left sharp)
  const rounded = (setback: number): ReturnType<typeof execute> => {
    const { doc, id } = cube();
    return execute(doc, 'fillet_edge', {
      id,
      edgesNear: [
        [0, -5, -5],
        [-5, 0, -5],
      ],
      radius: 1,
      corners: [{ near: [-5, -5, -5], type: 'setback', setback }],
    });
  };

  it('two rounded edges and a sharp third: a star of 5 with a crease spoke, valid, in the volume of the rolling-ball mitre, check_blends reads the crease', () => {
    const done = rounded(2);
    expect(done.error, done.summary).toBeUndefined();
    const id = done.affected[0] as string;
    // the result names the crease the star keeps: the sharp edge of the source and its (signed, convex) dihedral at the vertex
    const reported = (done.data as { corners: { vertex: number[]; crease: { sharpEdge: number; entryRad: number } }[] }).corners;
    expect(reported).toHaveLength(1);
    expect(reported[0]?.crease.entryRad).toBeCloseTo(Math.PI / 2, 6);
    expect(Number.isInteger(reported[0]?.crease.sharpEdge)).toBe(true);
    expect(done.summary).toContain('Sharp edge kept at 1 corner(s)');
    expect(done.summary).toContain('fades to nothing at the pole');
    const list = faces(done.document, id);
    expect(list.filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(5);
    expect(list.filter((face) => face.surface === 'cylinder')).toHaveLength(2);
    // the closed form of the mitre of the two edges: 1000 - 2 r^2 (1 - pi/4) L + r^3 (5/3 - pi/2); the patch removes a little more
    const mitre = 1000 - 2 * (1 - Math.PI / 4) * 10 + (5 / 3 - Math.PI / 2);
    const own = volume(done.document, id);
    expect(own).toBeLessThan(mitre);
    expect(own).toBeGreaterThan(mitre - 1);
    const checked = execute(done.document, 'check_blends', { ids: [id] }).data as { status: string; blends: Row[] };
    expect(checked.status).not.toBe('fail');
    const patchRows = checked.blends.filter((blend) => blend.kind === 'corner');
    expect(patchRows).toHaveLength(5);
    const creases = patchRows.flatMap((row) => row.contacts).filter((contact) => contact.order === 'crease');
    // the one crease spoke is a contact of the two sub-patches it separates
    expect(creases).toHaveLength(2);
    for (const crease of creases) {
      expect(crease.creaseRad).toBeCloseTo(Math.PI / 2, 6);
      expect(crease.g1AngleRad).toBeLessThan(0.01);
    }
    const ordinary = patchRows.flatMap((row) => row.contacts).filter((contact) => contact.order !== 'crease');
    for (const contact of ordinary) {
      expect(contact.g1AngleRad).toBeLessThan(0.01);
      expect(contact.g0Gap).toBeLessThan(0.2e-6 * Math.sqrt(3) * 10);
    }
  });

  it('a setback of the sharp edge of its own (setbacks) moves the entry point; `all` skips a vertex with a sharp edge; the other refusals are named', () => {
    const { doc, id } = cube();
    const edgesNear = [
      [0, -5, -5],
      [-5, 0, -5],
    ];
    const own = execute(doc, 'fillet_edge', {
      id,
      edgesNear,
      radius: 1,
      corners: [{ near: [-5, -5, -5], type: 'setback', setback: 2, setbacks: [{ near: [-5, -5, 0], distance: 3 }] }],
    });
    expect(own.error, own.summary).toBeUndefined();
    const plain = rounded(2);
    expect(volume(own.document, own.affected[0] as string)).toBeLessThan(volume(plain.document, plain.affected[0] as string));
    const all = execute(doc, 'fillet_edge', { id, edgesNear, radius: 1, corners: [{ all: true, setback: 2 }] });
    expect(all.document).toBe(doc);
    expect(all.summary).toContain('no vertex has 3 or more rounded edges');
    // two edges of the vertex left sharp
    const one = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [[0, -5, -5]],
      radius: 1,
      corners: [{ near: [-5, -5, -5], type: 'setback', setback: 2 }],
    });
    expect(one.document).toBe(doc);
    expect(one.summary).toContain('at most one edge');
    // a setback that does not outrun the blends
    const short = rounded(0.5);
    expect(short.error?.code).toBe('BLD_SETBACK_TOO_SHORT');
  });
});
