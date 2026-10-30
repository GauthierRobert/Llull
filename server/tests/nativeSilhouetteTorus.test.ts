/**
 * 03 WRP silhouette of a torus on the native OCCT kernel (spec §14.12): the contour generator n . d = 0 solved per meridian angle (v = atan2(-d_p cos u, d_a) + k pi) gives two closed
 * curves; split_at_silhouette fits them (reported deviation), cuts the torus along them, and the pieces add up to the torus (area 4 pi^2 R r, volume 2 pi^2 R r^2). Skipped without the
 * llull-kernel binary (with the `emboss` capability).
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });
type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const R = 10;
const r = 3;

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP torus silhouette' })('WRP torus silhouette on the native OCCT kernel', () => {
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
  const torus = (): { doc: CadDocument; id: string } => {
    const made = execute(base(), 'add_torus', { ringRadius: R, tubeRadius: r });
    expect(made.rejected, made.summary).toBeUndefined();
    return { doc: made.document, id: made.affected[0] as string };
  };
  const solidOf = (done: Run): string => done.affected.find((id) => done.document.entities[id]?.kind !== 'nurbs_curve') as string;
  /** Normal of the torus (axis z, centre origin) at a surface point. */
  const normalAt = (p: number[]): number[] => {
    const rho = Math.hypot(p[0] as number, p[1] as number);
    const ring = [(p[0] as number) / rho, (p[1] as number) / rho];
    const h = p[2] as number;
    const n = [(rho - R) * (ring[0] as number), (rho - R) * (ring[1] as number), h];
    const length = Math.hypot(...n);
    return n.map((x) => x / length);
  };

  it('seen from below, along (0.3, 0.2, -1) and (0, 0, -1), the torus splits the same way (d_a < 0)', () => {
    for (const direction of [
      [0.3, 0.2, -1],
      [0, 0, -1],
    ]) {
      const body = torus();
      const done = execute(body.doc, 'split_at_silhouette', { id: body.id, direction, tolerance: 1e-5 });
      expect(done.rejected, done.summary).toBeUndefined();
      const found = (done.data as { silhouette: { curves: Array<{ deviation: number }> } }).silhouette;
      expect(found.curves.length).toBeGreaterThanOrEqual(1);
      for (const piece of found.curves) expect(piece.deviation).toBeLessThan(1e-6);
      expect((done.data as { facesAfter: number; facesBefore: number }).facesAfter).toBeGreaterThan(
        (done.data as { facesBefore: number }).facesBefore,
      );
    }
  });

  it('seen along (0.3, 0.2, 1) the torus splits along two fitted contour curves: n . d = 0 at the fit nodes to 1e-9, the deviation is reported, the pieces keep the area and the volume', () => {
    const body = torus();
    const direction = [0.3, 0.2, 1];
    const done = execute(body.doc, 'split_at_silhouette', { id: body.id, direction, tolerance: 1e-5 });
    expect(done.rejected, done.summary).toBeUndefined();
    const info = (done.data as { silhouette: { curves: Array<{ id: string; kind: string; length: number; deviation: number }> } })
      .silhouette;
    expect(info.curves).toHaveLength(2);
    const length = Math.hypot(...direction);
    for (const piece of info.curves) {
      expect(piece.kind).toBe('fitted');
      expect(piece.deviation).toBeLessThan(1e-6);
      const entity = done.document.entities[piece.id] as unknown as { curve: NurbsCurveData; onFace: { fitTolerance: number } };
      expect(entity.onFace.fitTolerance).toBe(piece.deviation);
      const nodes = entity.curve.poles.length - 3;
      let worst = 0;
      let between = 0;
      for (let k = 0; k < nodes; k++) {
        const mid = normalAt([...evaluateCurve(entity.curve, (k + 0.5) / nodes)]);
        between = Math.max(between, Math.abs((mid[0]! * direction[0]! + mid[1]! * direction[1]! + mid[2]! * direction[2]!) / length));
        const p = evaluateCurve(entity.curve, k / nodes);
        const n = normalAt([...p]);
        worst = Math.max(
          worst,
          Math.abs(((n[0] as number) * direction[0]! + (n[1] as number) * direction[1]! + (n[2] as number) * direction[2]!) / length),
        );
      }
      expect(worst).toBeLessThan(1e-9);
      expect(between).toBeLessThanOrEqual(piece.deviation);
    }
    const data = done.data as { facesBefore: number; facesAfter: number; volumeBefore: number; volumeAfter: number };
    expect(data.facesAfter).toBeGreaterThan(data.facesBefore);
    expect(relative(data.volumeAfter, 2 * Math.PI ** 2 * R * r * r)).toBeLessThan(1e-4);
    const faces = (execute(done.document, 'inspect_faces', { entityId: solidOf(done) }).data as { faces: Array<{ area: number }> }).faces;
    expect(
      relative(
        faces.reduce((sum, f) => sum + f.area, 0),
        4 * Math.PI ** 2 * R * r,
      ),
    ).toBeLessThan(1e-4);
  });

  it('seen along the axis the outer equator is the seam (already an edge) and the inner equator circle has length 2 pi (R - r); seen in the equatorial plane it is refused by name', () => {
    const body = torus();
    const done = execute(body.doc, 'split_at_silhouette', { id: body.id, direction: [0, 0, 1] });
    expect(done.rejected, done.summary).toBeUndefined();
    const info = (done.data as { silhouette: { curves: Array<{ length: number }>; onEdge: number[] } }).silhouette;
    expect(info.curves).toHaveLength(1);
    expect(info.onEdge).toEqual([0]);
    expect(relative(info.curves[0]?.length as number, 2 * Math.PI * (R - r))).toBeLessThan(1e-6);
    const flat = execute(body.doc, 'split_at_silhouette', { id: body.id, direction: [1, 0, 0] });
    expect(flat.rejected).toBe(true);
    expect(flat.error?.code).toBe('WRP_SILHOUETTE_UNSUPPORTED');
    expect(flat.summary).toContain('equatorial plane');
  });
});
