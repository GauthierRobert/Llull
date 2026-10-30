/**
 * 03 WRP M5: split_at_silhouette on the fake exact kernel (the native kernel proves the geometry in server/tests/nativeSilhouette.test.ts): the happy path with its curves and the
 * split data, the partial-parting-line summary, every refusal by code, purity.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { cylinder, emptyDoc, make, sphere, useFakeKernel } from './support';

interface Silhouette {
  readonly curves: Array<{ id: string; face: number; kind: string; length: number }>;
  readonly edgeOn: number[];
  readonly onEdge: number[];
  readonly unsupported: Array<{ face: number; surface: string; reason: string }>;
}

describe('split_at_silhouette (fake kernel)', () => {
  useFakeKernel();

  it('a cylinder r 20 h 40 seen along x: two generatrix curves of length 40 on the side face, the side face divided (3 -> 5 faces on the fake), the curves kept and replayable', () => {
    const { doc, id } = cylinder();
    const done = execute(doc, 'split_at_silhouette', { id, direction: [1, 0, 0] });
    expect(done.rejected, done.summary).toBeUndefined();
    const found = (done.data as { silhouette: Silhouette }).silhouette;
    expect(found.curves.map((c) => [c.kind, c.face])).toEqual([
      ['line', 0],
      ['line', 0],
    ]);
    for (const curve of found.curves) expect(curve.length).toBeCloseTo(40, 9);
    expect(found.edgeOn).toEqual([1, 2]);
    const info = done.data as { facesBefore: number; facesAfter: number };
    expect([info.facesBefore, info.facesAfter]).toEqual([3, 5]); // the fake divides a face into chains + 1 parts (the native kernel gives 4: server/tests)
    expect(done.document.entities[id]).toBeUndefined();
    for (const curve of found.curves) {
      const entity = done.document.entities[curve.id] as { kind: string; onFace?: { faceIndex: number; frame?: string; entityId: string } };
      expect(entity.kind).toBe('nurbs_curve');
      expect(entity.onFace).toMatchObject({ faceIndex: 0, frame: 'native', entityId: id });
      expect(done.affected).toContain(curve.id);
    }
    expect(done.summary).toContain('silhouette');
    expect(done.summary).not.toContain('PARTIAL');
    expect(expectPure(doc, () => execute(doc, 'split_at_silhouette', { id, direction: [1, 0, 0] }))).toBeUndefined();
  });

  it('a sphere seen along its axis gives one closed circle of length 2 pi r', () => {
    const { doc, id } = sphere();
    const done = execute(doc, 'split_at_silhouette', { id, direction: [0, 0, 2] });
    expect(done.rejected, done.summary).toBeUndefined();
    const found = (done.data as { silhouette: Silhouette }).silhouette;
    expect(found.curves.map((c) => c.kind)).toEqual(['circle']);
    expect(found.curves[0]?.length).toBeCloseTo(2 * Math.PI * 25, 9);
  });

  it('refuses by code: nothing to split, an unsupported face, a zero direction, a missing solid and a split the kernel cannot make', () => {
    const box = make(emptyDoc(), 'add_box', { size: [10, 20, 30] });
    const none = expectRefusal(box.doc, 'split_at_silhouette', { id: box.id, direction: [0, 0, 1] }, 'WRP_SILHOUETTE_NONE', 'direction');
    expect((none.data as { silhouette: Silhouette }).silhouette.edgeOn).toHaveLength(4);
    const torus = make(emptyDoc(), 'add_torus', { ringRadius: 30, tubeRadius: 8 });
    const unsupported = expectRefusal(
      torus.doc,
      'split_at_silhouette',
      { id: torus.id, direction: [1, 0, 0] },
      'WRP_SILHOUETTE_UNSUPPORTED',
      'id',
    );
    expect(unsupported.summary).toContain('equatorial plane');
    expectRefusal(box.doc, 'split_at_silhouette', { id: box.id, direction: [0, 0, 0] }, 'WRP_PARAM_INVALID', 'direction');
    expectRefusal(box.doc, 'split_at_silhouette', { id: 'missing', direction: [1, 0, 0] }, 'WRP_ENTITY_NOT_FOUND');
    expectRefusal(emptyDoc(), 'split_at_silhouette', { id: 'missing', direction: [1, 0, 0] }, 'WRP_ENTITY_NOT_FOUND');
  });
});

describe('split_at_silhouette with a torus end (a partial parting line)', () => {
  useFakeKernel({ stadium: 'torus-end' });

  it('splits the faces it can and names the one it cannot in the summary and in data.silhouette.unsupported', () => {
    const { doc, id } = make(emptyDoc(), 'add_box', { size: [40, 20, 10] });
    const done = execute(doc, 'split_at_silhouette', { id, direction: [1, 1, 0] });
    expect(done.rejected, done.summary).toBeUndefined();
    const found = (done.data as { silhouette: Silhouette }).silhouette;
    expect(found.curves).toHaveLength(1);
    expect(found.unsupported.map((u) => [u.face, u.surface])).toEqual([[1, 'torus']]);
    expect(done.summary).toContain('PARTIAL parting line');
    expect(done.summary).toContain('face 1 (torus');
  });
});

describe('split_at_silhouette with a splitter that divides nothing', () => {
  useFakeKernel({ noSplit: true });

  it('names the split refusal, leaves the document unchanged and returns no affected ids', () => {
    const { doc, id } = cylinder();
    const refused = execute(doc, 'split_at_silhouette', { id, direction: [1, 0, 0] });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(doc);
    expect(refused.affected).toEqual([]);
    expect(refused.error?.code).toBe('WRP_SPLIT_NO_EFFECT');
    expect(refused.summary).toContain('split_at_silhouette: ');
  });
});
