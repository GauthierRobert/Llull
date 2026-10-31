/**
 * 03 WRP silhouette of freeform (B-spline) faces on the native OCCT kernel (spec §14.16). A plate 78.54 x 30 x 6 bent 90 degrees on the radius 50 of its bottom face has two B-spline faces that are secretly
 * cylinders (R 50 convex, R 44 concave) about the axis through C = (-39.27, y, 50) along y: seen along d = (cos 30, 0, sin 30) the contour n . d = 0 of each is the ruling at the angle 30 degrees from the
 * downward vertical, a line of 30 along y at C + R (sin 30, 0, -cos 30), so the traced and fitted contour must reproduce that line to the fit tolerance and split_at_silhouette must divide both faces along it

 * without changing the volume (the B-spline of the bent face is the cylinder to its own fit, about 3e-4 mm: the points are compared to 1e-3). Skipped without the llull-kernel binary (with `deform`).
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { evaluateCurve, curveDomain } from '@core/lib/nurbs/evaluate';
import { createEmptyDocument, type CadDocument, type NurbsCurveEntity } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });
type Row = Record<string, unknown>;
type Run = ReturnType<typeof execute>;
const CENTRE_X = -39.2699081699;

describeNativeWhen({ capabilities: ['deform'], label: 'WRP freeform silhouette' })(
  'WRP silhouette of freeform faces (native OCCT kernel)',
  () => {
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
    const must = (doc: CadDocument, name: string, params: Row): Run => {
      const result = execute(doc, name, params);
      expect(result.rejected, result.summary).toBeUndefined();
      return result;
    };
    const bent = (): { doc: CadDocument; id: string } => {
      const plate = must(base(), 'add_box', { size: [78.5398163397, 30, 6], anchor: 'base-center' });
      const done = must(plate.document, 'bend_body', {
        id: plate.affected[0],
        radius: 50,
        angleDeg: 90,
        frame: { origin: [CENTRE_X, 0, 0], axis: [1, 0, 0], reference: [0, 0, 1] },
      });
      return { doc: done.document, id: done.affected[0] as string };
    };

    it('seen at 30 degrees the contour of each bent face is its ruling at 30 degrees: a line of 30 along y at C + R (sin 30, 0, -cos 30), fitted within the tolerance', () => {
      const plate = bent();
      const view = [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)];
      const done = must(plate.doc, 'split_at_silhouette', { id: plate.id, direction: view, tolerance: 1e-4 });
      const info = (done.data as Row)['silhouette'] as {
        curves: Array<{ id: string; face: number; kind: string; length: number }>;
        unsupported: unknown[];
      };
      expect(info.unsupported).toEqual([]);
      expect(info.curves.map((c) => c.face).sort()).toEqual([4, 5]);
      const volumes = done.data as { volumeBefore: number; volumeAfter: number; facesBefore: number; facesAfter: number };
      expect(Math.abs(volumes.volumeAfter / volumes.volumeBefore - 1)).toBeLessThan(1e-5);
      // the command reports its face counts as the kernel gives them (see the note on sequential splits in the spec): the concave face, divided last, is at least divided
      expect(volumes.facesAfter).toBeGreaterThan(volumes.facesBefore);
      for (const piece of info.curves) {
        const radius = piece.face === 4 ? 50 : 44;
        expect(piece.kind).toBe('fitted');
        expect(Math.abs(piece.length / 30 - 1)).toBeLessThan(1e-5);
        const curve = (done.document.entities[piece.id] as NurbsCurveEntity).curve;
        const [first, last] = curveDomain(curve);
        for (let k = 0; k <= 10; k++) {
          const point = evaluateCurve(curve, first + ((last - first) * k) / 10);
          expect(Math.abs(point[0] - (CENTRE_X + radius * 0.5))).toBeLessThan(1e-3);
          expect(Math.abs(point[2] - (50 - radius * Math.cos(Math.PI / 6)))).toBeLessThan(1e-3);
          expect(Math.abs(point[1])).toBeLessThanOrEqual(15 + 1e-4);
        }
      }
    });

    it('each silhouette curve alone divides its face at the ruling: the pieces are the arcs of 30 and 60 degrees times the width 30 (closed form)', () => {
      const plate = bent();
      const view = [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)];
      const done = must(plate.doc, 'split_at_silhouette', { id: plate.id, direction: view, tolerance: 1e-4 });
      const info = (done.data as Row)['silhouette'] as { curves: Array<{ id: string; face: number }> };
      for (const piece of info.curves) {
        const radius = piece.face === 4 ? 50 : 44;
        const withCurve = { ...plate.doc, entities: { ...plate.doc.entities, [piece.id]: done.document.entities[piece.id] as never } };
        const split = must(withCurve, 'split_face_by_curves', { id: plate.id, curveIds: [piece.id] });
        const faces = (split.data as { faces: Array<{ area: number }> }).faces.map((face) => face.area).sort((a, b) => a - b);
        expect(faces).toHaveLength(2);
        expect(Math.abs((faces[0] as number) / (radius * (Math.PI / 6) * 30) - 1)).toBeLessThan(1e-3);
        expect(Math.abs((faces[1] as number) / (radius * (Math.PI / 3) * 30) - 1)).toBeLessThan(1e-3);
      }
    });

    it('a view whose ruling falls outside the 90 degree arc has no silhouette on the freeform faces (named, nothing split)', () => {
      const plate = bent();
      const view = [Math.cos((120 * Math.PI) / 180), 0, Math.sin((120 * Math.PI) / 180)];
      const refused = execute(plate.doc, 'split_at_silhouette', { id: plate.id, direction: view });
      expect(refused.rejected).toBe(true);
      expect(refused.error?.code).toMatch(/WRP_SILHOUETTE_NONE|WRP_SILHOUETTE_UNSUPPORTED/);
      expect(refused.document).toBe(plate.doc);
    });
  },
);
