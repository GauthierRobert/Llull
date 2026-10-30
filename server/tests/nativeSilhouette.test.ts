/**
 * 03 WRP M5 on the native OCCT kernel: split_at_silhouette (the parting line of a mould). Closed forms: a cylinder seen side-on splits along two generatrices (length = height), a
 * sphere along a great circle (two hemispheres of area 2 pi r^2), a cone along two generatrices through its apex (slant length). Skipped when the llull-kernel binary (with the
 * `emboss` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

interface Silhouette {
  readonly curves: Array<{ id: string; face: number; kind: string; length: number }>;
  readonly edgeOn: number[];
  readonly onEdge: number[];
  readonly unsupported: Array<{ face: number; surface: string; reason: string }>;
}

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP silhouette' })('WRP silhouette split on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const base = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });
  const must = (doc: CadDocument, name: string, params: Record<string, unknown>): Run => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };
  const split = (doc: CadDocument, id: string, direction: number[]): Run => must(doc, 'split_at_silhouette', { id, direction });
  const silhouette = (done: Run): Silhouette => (done.data as { silhouette: Silhouette }).silhouette;
  const volume = (doc: CadDocument, id: string): number =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  const solidOf = (done: Run): string => done.affected.find((id) => done.document.entities[id]?.kind !== 'nurbs_curve') as string;
  const areas = (done: Run): number[] =>
    (execute(done.document, 'inspect_faces', { entityId: solidOf(done) }).data as { faces: Array<{ area: number }> }).faces.map(
      (f) => f.area,
    );

  it('a cylinder r 20 h 40 seen along x splits along the generatrices at y = +-20: 2 curves of length 40, 3 -> 4 faces, the volume unchanged', () => {
    const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
    const done = split(body.document, body.affected[0] as string, [1, 0, 0]);
    const found = silhouette(done);
    expect(found.curves).toHaveLength(2);
    for (const curve of found.curves) {
      expect(curve.kind).toBe('line');
      expect(curve.length).toBeCloseTo(40, 9);
    }
    const data = done.data as { facesBefore: number; facesAfter: number; volumeBefore: number; volumeAfter: number };
    expect([data.facesBefore, data.facesAfter]).toEqual([3, 4]);
    expect(relative(data.volumeAfter, data.volumeBefore)).toBeLessThan(1e-5);
    expect(relative(volume(done.document, solidOf(done)), Math.PI * 400 * 40)).toBeLessThan(1e-5);
    const curve = done.document.entities[found.curves[0]?.id as string] as { curve: { poles: number[][] }; onFace?: { faceIndex: number } };
    expect(Math.abs(Math.abs(curve.curve.poles[0]?.[1] as number) - 20)).toBeLessThan(1e-9);
    expect(curve.onFace?.faceIndex).toBe(found.curves[0]?.face);
    const halves = areas(done).filter((area) => Math.abs(area - Math.PI * 20 * 40) < 1e-3);
    expect(halves).toHaveLength(2);
  });

  it('a sphere r 25 seen along its axis splits along the equator: one circle 2 pi r long, two hemispheres of area 2 pi r^2', () => {
    const body = must(base(), 'add_sphere', { radius: 25 });
    const done = split(body.document, body.affected[0] as string, [0, 0, 1]);
    const found = silhouette(done);
    expect(found.curves.map((c) => c.kind)).toEqual(['circle']);
    expect(found.curves[0]?.length).toBeCloseTo(2 * Math.PI * 25, 9);
    expect((done.data as { facesAfter: number }).facesAfter).toBe(2);
    for (const area of areas(done)) expect(relative(area, 2 * Math.PI * 625)).toBeLessThan(1e-4);
    expect(relative(volume(done.document, solidOf(done)), (4 / 3) * Math.PI * 25 ** 3)).toBeLessThan(1e-5);
  });

  it('a sphere seen along an oblique direction splits along the great circle perpendicular to it', () => {
    const body = must(base(), 'add_sphere', { radius: 25 });
    const done = split(body.document, body.affected[0] as string, [1, 2, 2]);
    expect(silhouette(done).curves.map((c) => c.kind)).toEqual(['circle']);
    for (const area of areas(done)) expect(relative(area, 2 * Math.PI * 625)).toBeLessThan(1e-3);
  });

  it('a cone r 20 h 40 seen along x splits along two generatrices through the apex, each the slant length sqrt(20^2 + 40^2)', () => {
    const body = must(base(), 'add_cone', { radius: 20, height: 40 });
    const done = split(body.document, body.affected[0] as string, [1, 0, 0]);
    const found = silhouette(done);
    expect(found.curves).toHaveLength(2);
    for (const curve of found.curves) expect(curve.length).toBeCloseTo(Math.hypot(20, 40), 7);
    expect((done.data as { facesAfter: number }).facesAfter).toBe(3);
    const halves = areas(done).filter((area) => Math.abs(area - (Math.PI * 20 * Math.hypot(20, 40)) / 2) < 1e-3);
    expect(halves).toHaveLength(2);
  });

  it('a cylinder cut by a tilted plane: each generatrix is cut short where the slanted top edge crosses it, and the split still works', () => {
    const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
    const cutter = must(body.document, 'add_box', { size: [200, 200, 100], position: [0, 0, 70], rotation: [0, 0.349, 0] });
    const cut = must(cutter.document, 'boolean', { op: 'subtract', a: body.affected[0], b: cutter.affected[0] });
    const done = split(cut.document, cut.affected[0] as string, [1, 0, 0]);
    const found = silhouette(done);
    expect(found.curves).toHaveLength(2);
    const [a, b] = found.curves.map((c) => c.length) as [number, number];
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
    expect(a).toBeLessThan(40);
    expect(a).toBeGreaterThan(20);
    const counts = done.data as { facesBefore: number; facesAfter: number };
    expect(counts.facesAfter).toBeGreaterThan(counts.facesBefore);
    expect(relative(volume(done.document, solidOf(done)), volume(cut.document, cut.affected[0] as string))).toBeLessThan(1e-5);
  });

  it('a sphere seen along x or y (the great circle through the poles) is refused by reason', () => {
    const body = must(base(), 'add_sphere', { radius: 25 });
    for (const direction of [
      [1, 0, 0],
      [0, 1, 0],
    ]) {
      const refused = execute(body.document, 'split_at_silhouette', { id: body.affected[0], direction });
      expect(refused.error?.code).toBe('WRP_SILHOUETTE_UNSUPPORTED');
      expect(refused.summary).toContain('passes through the poles');
      expect(refused.document).toBe(body.document);
    }
  });

  it('a silhouette that already is an edge (the seam, seen along y) is reported and not split again: one curve, 3 -> 4 faces', () => {
    const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
    const done = split(body.document, body.affected[0] as string, [0, 1, 0]);
    const found = silhouette(done);
    expect(found.curves).toHaveLength(1);
    expect(found.onEdge).toHaveLength(1);
    expect((done.data as { facesAfter: number }).facesAfter).toBe(4);
  });

  it('refuses by code: a box seen along an axis (nothing inside a face), a zero direction, a torus and an unknown id', () => {
    const box = must(base(), 'add_box', { size: [10, 20, 30] });
    const none = execute(box.document, 'split_at_silhouette', { id: box.affected[0], direction: [0, 0, 1] });
    expect(none.error?.code).toBe('WRP_SILHOUETTE_NONE');
    expect((none.data as { silhouette: Silhouette }).silhouette.edgeOn).toHaveLength(4);
    expect(none.document).toBe(box.document);
    expect(execute(box.document, 'split_at_silhouette', { id: box.affected[0], direction: [0, 0, 0] }).error?.code).toBe(
      'WRP_PARAM_INVALID',
    );
    const torus = must(base(), 'add_torus', { ringRadius: 30, tubeRadius: 8 });
    expect(execute(torus.document, 'split_at_silhouette', { id: torus.affected[0], direction: [0, 0, 1] }).error?.code).toBe(
      'WRP_SILHOUETTE_UNSUPPORTED',
    );
    expect(execute(base(), 'split_at_silhouette', { id: 'missing', direction: [1, 0, 0] }).error?.code).toBe('WRP_ENTITY_NOT_FOUND');
  });

  it('replay_history rebuilds the split solid and its curves', () => {
    const body = must(base(), 'add_cylinder', { radius: 20, height: 40 });
    const done = split(body.document, body.affected[0] as string, [1, 0, 0]);
    const replayed = must(done.document, 'replay_history', {});
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(done.document.entities));
  });
});
