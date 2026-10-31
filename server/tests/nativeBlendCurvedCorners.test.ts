/**
 * BLD 13.22 on the native OCCT kernel: a setback corner where a rounded edge is curved and a face is curved (a cylinder). The analytic builder takes straight edges between planar faces only; here
 * OCCT's rolling-ball blend is cut inside a ball around the vertex and the hole filled. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Face {
  readonly name?: string;
  readonly surface: string;
}
interface Row {
  readonly kind: string;
  readonly contacts: ReadonlyArray<{ readonly g0Gap: number; readonly g1AngleRad: number; readonly g1EndAngleRad: number }>;
}

describeNative('BLD 13.22: setback corners on curved edges and faces (native OCCT kernel)', () => {
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

  // A 10 x 10 x 5 block cut by a cylinder of radius 12 about the z axis: its corner (10, y, 5) has a straight top edge, a straight edge between the cylinder and the side plane, and the circular top edge.
  const dshape = (): { doc: CadDocument; id: string; vertex: [number, number, number]; edges: Array<[number, number, number]> } => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 5], position: [5, 5, 2.5] });
    const cylinder = execute(box.document, 'add_cylinder', { radius: 12, height: 5, position: [0, 0, 2.5] });
    const cut = execute(cylinder.document, 'boolean', { op: 'intersect', a: box.affected[0], b: cylinder.affected[0], engine: 'kernel' });
    const y = Math.sqrt(144 - 100);
    return {
      doc: cut.document,
      id: cut.affected[0] as string,
      vertex: [10, y, 5],
      edges: [
        [8.485, 8.485, 5],
        [10, 3, 5],
        [10, y, 2.5],
      ],
    };
  };

  it('a vertex of a circular edge and two straight edges, one of them against a cylinder, takes a setback corner: valid, tangent, close to the rolling-ball blend', () => {
    const { doc, id, vertex, edges } = dshape();
    const plain = execute(doc, 'fillet_edge', { id, edgesNear: edges, radius: 0.5 });
    expect(plain.error).toBeUndefined();
    const done = execute(doc, 'fillet_edge', {
      id,
      edgesNear: edges,
      radius: 0.5,
      corners: [{ near: vertex, type: 'setback', setback: 1.2 }],
    });
    expect(done.error, done.summary).toBeUndefined();
    const result = done.affected[0] as string;
    const list = faces(done.document, result);
    expect(list.some((face) => face.name?.startsWith('blend(v:'))).toBe(true);
    const checked = execute(done.document, 'check_blends', { ids: [result] }).data as { status: string; blends: Row[] };
    expect(checked.status).not.toBe('fail');
    const patches = checked.blends.filter((blend) => blend.kind === 'corner');
    expect(patches.length).toBeGreaterThan(0);
    for (const contact of patches.flatMap((row) => row.contacts)) {
      expect(contact.g1AngleRad).toBeLessThan(0.0095);
      expect(contact.g0Gap).toBeLessThan(5e-6 * Math.hypot(10, 10, 5));
    }
    const rolling = volume(plain.document, plain.affected[0] as string);
    expect(Math.abs(volume(done.document, result) - rolling) / rolling).toBeLessThan(1e-3);
  });
});
