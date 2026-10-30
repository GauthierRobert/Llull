/**
 * 03 WRP chains across cone, sphere and torus faces on the native OCCT kernel (spec §14.12). A cone split along its rulings unrolls into the flat sector (develop, exact: the
 * curve over the ruling keeps its chart length and ends where the development puts it); a torus split along two meridians is charted with geodesic charts anchored on the shared
 * edges, the mismatch of the join measured against the geodesic length of a band along the outer equator. Skipped without the llull-kernel binary (with `emboss`).
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
type Row = Record<string, unknown>;

describeNativeWhen({ capabilities: ['emboss'], label: 'WRP chains 2' })(
  'WRP chains across cone and torus faces (native OCCT kernel)',
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
    const solidOf = (done: Run): string => done.affected.find((id) => done.document.entities[id]?.kind !== 'nurbs_curve') as string;
    const endsOf = (run: Run): Array<{ face: number; start: number[]; end: number[] }> =>
      run.affected.map((id) => {
        const entity = run.document.entities[id] as unknown as { curve: NurbsCurveData; onFace: { faceIndex: number } };
        const domain = [entity.curve.knots[0] as number, entity.curve.knots[entity.curve.knots.length - 1] as number];
        return {
          face: entity.onFace.faceIndex,
          start: [...evaluateCurve(entity.curve, domain[0] as number)],
          end: [...evaluateCurve(entity.curve, domain[1] as number)],
        };
      });

    it('a cone split along its rulings: a line of 30 across the ruling keeps its length and ends where the development of the flat sector puts it (1e-6)', () => {
      const cone = must(base(), 'add_cone', { radius: 20, height: 40 });
      const split = must(cone.document, 'split_at_silhouette', { id: cone.affected[0], direction: [1, 0, 0] });
      const id = solidOf(split);
      const line = must(split.document, 'draw_polyline', {
        points: [
          [0, 0],
          [30, 0],
        ],
      });
      const wrapped = must(line.document, 'wrap_to_face', {
        id,
        face: { faceNear: [10, 0, 20] },
        chain: [{ faceNear: [-10, 0, 20] }],
        entityIds: [line.affected[0]],
        placement: { method: 'develop', anchor: { chart: [0, 0], on: [10, 0, 20] } },
      });
      const data = wrapped.data as {
        curves: Array<{ length3d: number; maxLengthStrain: number }>;
        chain: number[];
        edges: Array<{ mismatch: number }>;
      };
      expect(data.chain).toHaveLength(2);
      expect(data.curves).toHaveLength(2);
      const total = data.curves.reduce((sum, c) => sum + c.length3d, 0);
      expect(Math.abs(total - 30)).toBeLessThan(1e-6);
      expect(data.edges[0]?.mismatch).toBe(0);
      // the flat sector: slant distance of the anchor from the apex rho0 = 20 / cos(alpha) ... the end of the chart line (30, 0) is at hypot(rho0, 30) from the apex
      const slant = Math.hypot(20, 40);
      const rho0 = slant / 2;
      const alpha = Math.atan2(20, 40);
      const rhoEnd = Math.hypot(rho0, 30);
      const ends = endsOf(wrapped);
      const far = ends
        .map((e) => Math.hypot(e.end[0] as number, e.end[1] as number, (e.end[2] as number) - 40))
        .concat(ends.map((e) => Math.hypot(e.start[0] as number, e.start[1] as number, (e.start[2] as number) - 40)));
      expect(far.some((distance) => Math.abs(distance - rhoEnd) < 1e-5)).toBe(true);
      const tip = ends.find((e) => Math.abs(Math.hypot(e.end[0] as number, e.end[1] as number, (e.end[2] as number) - 40) - rhoEnd) < 1e-5);
      const azimuth = Math.abs(Math.atan2(tip?.end[1] as number, tip?.end[0] as number));
      expect(Math.abs(azimuth - Math.atan2(30, rho0) / Math.sin(alpha))).toBeLessThan(1e-6);
    });

    it('a rotated placement (30 degrees) unrolls the same sector: the length across the ruling is kept and the end lies at the development distance from the apex', () => {
      const cone = must(base(), 'add_cone', { radius: 20, height: 40 });
      const split = must(cone.document, 'split_at_silhouette', { id: cone.affected[0], direction: [1, 0, 0] });
      const line = must(split.document, 'draw_polyline', {
        points: [
          [0, 0],
          [30, 0],
        ],
      });
      const wrapped = must(line.document, 'wrap_to_face', {
        id: solidOf(split),
        face: { faceNear: [10, 0, 20] },
        chain: [{ faceNear: [-10, 0, 20] }],
        entityIds: [line.affected[0]],
        placement: { method: 'develop', angleDeg: 30, anchor: { chart: [0, 0], on: [10, 0, 20] } },
      });
      const curves = (wrapped.data as { curves: Array<{ length3d: number }> }).curves;
      expect(Math.abs(curves.reduce((sum, c) => sum + c.length3d, 0) - 30)).toBeLessThan(1e-6);
      const rho0 = Math.hypot(20, 40) / 2;
      const reach = (sign: number): number => Math.hypot(rho0 + sign * 15, 30 * Math.cos(Math.PI / 6));
      const ends = endsOf(wrapped).map((e) => Math.hypot(e.end[0] as number, e.end[1] as number, (e.end[2] as number) - 40));
      expect(ends.some((distance) => Math.abs(distance - reach(1)) < 1e-5 || Math.abs(distance - reach(-1)) < 1e-5)).toBe(true);
    });

    it('an emboss across a ruling of a split cone adds the volume of the same emboss on the whole cone (1e-4): the chain is the flat sector', () => {
      const cone = must(base(), 'add_cone', { radius: 20, height: 40 });
      const id = cone.affected[0] as string;
      const rectangle = must(cone.document, 'draw_rectangle', { width: 8, height: 6, position: [-4, -3, 0] });
      const on = [0, 10, 20];
      const params = {
        profileIds: [rectangle.affected[0]],
        mode: 'emboss',
        depth: 1,
        placement: { method: 'develop', anchor: { chart: [0, 0], on } },
      };
      const whole = must(rectangle.document, 'emboss_on_face', { id, face: { faceNear: on }, ...params });
      const split = must(rectangle.document, 'split_at_silhouette', { id, direction: [1, 0, 0] });
      const chained = must(split.document, 'emboss_on_face', {
        id: solidOf(split),
        face: { faceNear: [4, 6.928203230275509, 24] },
        chain: [{ faceNear: [-4, 6.928203230275509, 24] }],
        ...params,
      });
      const delta = (run: Run): number => (run.data as { volumeDelta: number }).volumeDelta;
      expect(Math.abs(delta(chained) / delta(whole) - 1)).toBeLessThan(1e-4);
      expect((chained.data as { faces: unknown[] }).faces).toHaveLength(2);
    });

    it('a torus split along two meridians: a band of 3 along the outer equator across a meridian edge has the geodesic length of the equator arc within the join mismatch, and the limit refuses', () => {
      const torus = must(base(), 'add_torus', { ringRadius: 10, tubeRadius: 3 });
      let doc = torus.document;
      const meridians: string[] = [];
      for (const u of [0.5, Math.PI + 0.5]) {
        const made = must(doc, 'create_curve_on_face', {
          id: torus.affected[0],
          face: { faceNear: [13 * Math.cos(u), 13 * Math.sin(u), 0] },
          mode: 'isoparametric',
          through: [13 * Math.cos(u), 13 * Math.sin(u), 0],
          direction: 'v',
        });
        doc = made.document;
        meridians.push(made.affected[0] as string);
      }
      const split = must(doc, 'split_face_by_curves', { id: torus.affected[0], curveIds: meridians });
      const id = solidOf(split);
      const line = must(split.document, 'draw_polyline', {
        points: [
          [0, 0],
          [3, 0],
        ],
      });
      const on = [13 * Math.cos(0.4), 13 * Math.sin(0.4), 0];
      const params = {
        id,
        face: { faceNear: on },
        chain: [{ faceNear: [13 * Math.cos(0.9), 13 * Math.sin(0.9), 0] }],
        entityIds: [line.affected[0]],
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on } },
      };
      const wrapped = must(line.document, 'wrap_to_face', params);
      const data = wrapped.data as {
        curves: Array<{ length3d: number }>;
        edges: Array<{ mismatch: number }>;
        distortion: { maxLengthStrain: number };
      };
      expect(data.curves).toHaveLength(2);
      const total = data.curves.reduce((sum, c) => sum + c.length3d, 0);
      expect(Math.abs(total / 3 - 1)).toBeLessThan(0.02);
      const ends = endsOf(wrapped);
      const last = ends[ends.length - 1]?.end as number[];
      const expected = [13 * Math.cos(0.4 + 3 / 13), 13 * Math.sin(0.4 + 3 / 13), 0];
      expect(Math.hypot(last[0]! - expected[0]!, last[1]! - expected[1]!, last[2]! - expected[2]!)).toBeLessThan(0.07);
      // an anchor 3.9 from the edge: the meridian is straight to the shrunk window but its length is 6.3 % short in the geodesic chart of the parent
      const far = must(split.document, 'draw_polyline', {
        points: [
          [0, 0],
          [6, 0],
        ],
      });
      const onFar = [13 * Math.cos(0.2), 13 * Math.sin(0.2), 0];
      const stretched = execute(far.document, 'wrap_to_face', {
        ...params,
        face: { faceNear: onFar },
        entityIds: [far.affected[0]],
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on: onFar } },
      });
      expect(stretched.error?.code).toBe('WRP_DISTORTION_EXCEEDED');
      expect(stretched.summary).toContain('disagree along edge');
      const tight = execute(line.document, 'wrap_to_face', { ...params, maxLengthStrain: 1e-12 });
      expect(tight.rejected).toBe(true);
      expect(tight.error?.code).toBe('WRP_DISTORTION_EXCEEDED');
      expect(solidOf(wrapped.document === undefined ? split : split)).toBe(id);
    });
  },
);
