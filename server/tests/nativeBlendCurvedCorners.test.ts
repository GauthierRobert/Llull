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
  readonly profile: string;
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

  it('a vertex of a circular edge and two straight edges, one of them against a cylinder, takes a setback corner: a star of exact sub-patches, valid, tangent, at the default g0, close to the rolling-ball blend', () => {
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
    expect(list).toHaveLength(16); // the block, the cylinder, 3 blends and a star of 6
    const names = list.map((face) => face.name ?? '').filter((name) => name.startsWith('blend(v:'));
    expect(names).toHaveLength(6);
    expect(names.every((name) => /#[1-6]$/.test(name))).toBe(true);
    const checked = execute(done.document, 'check_blends', { ids: [result] }).data as { status: string; blends: Row[] };
    expect(checked.status).not.toBe('fail');
    const patches = checked.blends.filter((blend) => blend.kind === 'corner');
    expect(patches).toHaveLength(6);
    expect(patches.every((row) => row.profile === 'star')).toBe(true);
    const diagonal = Math.hypot(10, 10, 5);
    for (const contact of patches.flatMap((row) => row.contacts)) {
      expect(contact.g1AngleRad).toBeLessThan(0.0095);
      expect(contact.g0Gap).toBeLessThan(1e-6 * diagonal); // the default g0, not the 5x of the plate
    }
    const rolling = volume(plain.document, plain.affected[0] as string);
    expect(Math.abs(volume(done.document, result) - rolling) / rolling).toBeLessThan(1e-3);
  });

  it('a radius that is linear along the edges (size to sizeEnd) works on the curved edges and faces too: a star, valid, close to the plain evolving fillet', () => {
    const { doc, id, vertex, edges } = dshape();
    const laws = edges.map((near) => ({ near, size: 0.5, sizeEnd: 0.7, interpolation: 'linear' as const }));
    const plain = execute(doc, 'fillet_edge', { id, edges: laws });
    expect(plain.error, plain.summary).toBeUndefined();
    const done = execute(doc, 'fillet_edge', { id, edges: laws, corners: [{ near: vertex, type: 'setback', setback: 1.5 }] });
    expect(done.error, done.summary).toBeUndefined();
    const result = done.affected[0] as string;
    const names = faces(done.document, result)
      .map((face) => face.name ?? '')
      .filter((name) => name.startsWith('blend(v:'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.every((name) => /#\d+$/.test(name))).toBe(true);
    // check_blends reads the realised radius of OCCT's evolving fillet against the law along the curved edge (the law is linear in the parameter): the plain fillet fails that check by itself, the corner must
    // add no failure of its own
    type Found = { findings: Array<{ code: string; severity: string }> };
    const failures = (document: CadDocument, entity: string): string[] =>
      (execute(document, 'check_blends', { ids: [entity] }).data as Found).findings
        .filter((finding) => finding.severity === 'fail')
        .map((finding) => finding.code);
    const own = failures(plain.document, plain.affected[0] as string);
    expect(failures(done.document, result).filter((code) => !own.includes(code))).toEqual([]);
    const rolling = volume(plain.document, plain.affected[0] as string);
    expect(Math.abs(volume(done.document, result) - rolling) / rolling).toBeLessThan(2e-3);
  });

  it('different setbacks at the vertex (setbacks overrides) cut each edge by a plane at its own distance along it (13.22.6): built within the limits (13.22.6)', () => {
    const { doc, id, vertex, edges } = dshape();
    const plain = execute(doc, 'fillet_edge', { id, edgesNear: edges, radius: 0.5 });
    const withSetback = (distance: number): ReturnType<typeof execute> =>
      execute(doc, 'fillet_edge', {
        id,
        edgesNear: edges,
        radius: 0.5,
        corners: [{ near: vertex, type: 'setback', setback: 1.2, setbacks: [{ near: edges[1] as [number, number, number], distance }] }],
      });
    const done = withSetback(1.3);
    expect(done.error, done.summary).toBeUndefined();
    const result = done.affected[0] as string;
    expect(faces(done.document, result).some((face) => face.name?.startsWith('blend(v:'))).toBe(true);
    const checked = execute(done.document, 'check_blends', { ids: [result] }).data as { status: string };
    expect(checked.status).not.toBe('fail');
    const rolling = volume(plain.document, plain.affected[0] as string);
    expect(Math.abs(volume(done.document, result) - rolling) / rolling).toBeLessThan(2e-3);
    // the setback is a distance ALONG the edge: the blend of the straight top edge (length sqrt(44) = 6.633) ends 1.3 from the vertex, so its cylinder spans 6.633 - 1.3 (a ball would cut it at
    // sqrt(1.3^2 - 0.5^2) = 1.2, or at the largest setback)
    const spans = faces(done.document, result)
      .filter((face) => face.surface === 'cylinder')
      .map((face) => (face.axis?.span?.[1] ?? 0) - (face.axis?.span?.[0] ?? 0));
    expect(spans.some((span) => Math.abs(span - (Math.sqrt(44) - 1.3)) < 1e-4)).toBe(true);
    // 1.6 along the same edge: builds too (C0 knots at the joints of the chains, 13.22.6; before, the star was refused at 0.00965 rad and the plate missed the blend ends)
    const longer = withSetback(1.6);
    expect(longer.error, longer.summary).toBeUndefined();
    expect(Math.abs(volume(longer.document, longer.affected[0] as string) - rolling) / rolling).toBeLessThan(2e-3);
  });

  it('an edge of the vertex marked rollingBall has no setback of its own: the kernel rounds it and the same ball cuts it (13.22)', () => {
    const { doc, id, vertex, edges } = dshape();
    const plain = execute(doc, 'fillet_edge', { id, edgesNear: edges, radius: 0.5 });
    const done = execute(doc, 'fillet_edge', {
      id,
      edgesNear: edges,
      radius: 0.5,
      corners: [
        { near: vertex, type: 'setback', setback: 1.2, setbacks: [{ near: edges[1] as [number, number, number], rollingBall: true }] },
      ],
    });
    expect(done.error, done.summary).toBeUndefined();
    const result = done.affected[0] as string;
    expect(faces(done.document, result).filter((face) => face.name?.startsWith('blend(v:'))).toHaveLength(6);
    const rolling = volume(plain.document, plain.affected[0] as string);
    expect(Math.abs(volume(done.document, result) - rolling) / rolling).toBeLessThan(1e-3);
    const checked = execute(done.document, 'check_blends', { ids: [result] }).data as { status: string };
    expect(checked.status).not.toBe('fail');
    const both = execute(doc, 'fillet_edge', {
      id,
      edgesNear: edges,
      radius: 0.5,
      corners: [
        {
          near: vertex,
          type: 'setback',
          setback: 1.2,
          setbacks: [{ near: edges[1] as [number, number, number], rollingBall: true, distance: 1 }],
        },
      ],
    });
    expect(both.affected).toHaveLength(0);
    expect(both.summary).toContain('both distance and rollingBall');
  });

  it('refuses by name an edge at the setback vertex that is not rounded, a ball that does not hold the rolling-ball corner, and a step that mixes the two builders', () => {
    const { doc, id, vertex, edges } = dshape();
    const left = execute(doc, 'fillet_edge', {
      id,
      edgesNear: edges.slice(0, 2),
      radius: 0.5,
      corners: [{ near: vertex, type: 'setback', setback: 1.2 }],
    });
    expect(left.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    expect(left.summary).toContain('not rounded');
    const short = execute(doc, 'fillet_edge', {
      id,
      edgesNear: edges,
      radius: 0.5,
      corners: [{ near: vertex, type: 'setback', setback: 0.5 }],
    });
    expect(short.error?.code).toBe('BLD_SETBACK_TOO_SHORT');
    // the vertex (0, 0, 5) of the block is a plain cube corner: the analytic builder (along the edge); the other vertex is on a curved edge (a ball): one step cannot do both
    const mixed = execute(doc, 'fillet_edge', {
      id,
      edgesNear: [...edges, [3, 0, 5], [0, 3, 5], [0, 0, 2.5]],
      radius: 0.5,
      corners: [
        { near: vertex, type: 'setback', setback: 1.2 },
        { near: [0, 0, 5], type: 'setback', setback: 1.2 },
      ],
    });
    expect(mixed.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    expect(mixed.summary).toContain('mix');
  });
});
