/**
 * 03 WRP on freeform (B-spline) faces, native OCCT kernel (spec §14.10, VC-WRP-27). A plate bent onto an arc has B-spline faces that are secretly cylinders (the fitted
 * face of an exact warp): the freeform geodesic chart must give the analytic cylinder results (length of a chart circle 2 pi a, volume of a pull-walled relief from the
 * closed form), a lattice-warped plate is genuinely freeform (measured strain, volume near area x depth), and the refusals are named. Skipped without the binary.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });
type Row = Record<string, unknown>;
type Run = ReturnType<typeof execute>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);

/** Volume of the pull-walled relief of a circle of developed radius `a` on a cylinder of radius `radius`: the layer between the radii `inner` and `outer` seen along a parallel pull. */
function closedFormVolume(radius: number, a: number, inner: number, outer: number): number {
  const steps = 4000;
  let total = 0;
  for (let k = 0; k < steps; k++) {
    const theta = ((k + 0.5) * Math.PI) / steps - Math.PI / 2;
    const s = a * Math.sin(theta);
    const x = radius * Math.sin(s / radius);
    const thickness = Math.sqrt(outer * outer - x * x) - Math.sqrt(inner * inner - x * x);
    total += 2 * Math.sqrt(Math.max(0, a * a - s * s)) * thickness * Math.cos(s / radius) * a * Math.cos(theta) * (Math.PI / steps);
  }
  return total;
}

describeNativeWhen({ capabilities: ['emboss', 'deform'], label: 'WRP freeform' })(
  'WRP charts and relief on freeform faces (native OCCT kernel)',
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
    const refused = (doc: CadDocument, name: string, params: Row): Run => {
      const result = execute(doc, name, params);
      expect(result.rejected, result.summary).toBe(true);
      expect(result.document).toBe(doc);
      return result;
    };
    const codeOf = (run: Run): string => run.error?.code ?? '';

    /** A 78.54 x 30 x 6 plate bent 90 degrees on the radius 50 of its bottom face: faces 4 (convex, R 50) and 5 (concave, R 44) are B-splines. */
    const bent = (): { doc: CadDocument; id: string } => {
      const plate = must(base(), 'add_box', { size: [78.5398163397, 30, 6], anchor: 'base-center' });
      const done = must(plate.document, 'bend_body', {
        id: plate.affected[0],
        radius: 50,
        angleDeg: 90,
        frame: { origin: [-39.2699081699, 0, 0], axis: [1, 0, 0], reference: [0, 0, 1] },
      });
      return { doc: done.document, id: done.affected[0] as string };
    };
    const at45 = (radius: number): [number, number, number] => [-39.2699081699 + radius * Math.SQRT1_2, 0, 50 - radius * Math.SQRT1_2];
    const circle = (doc: CadDocument, radius: number): { doc: CadDocument; id: string } => {
      const drawn = must(doc, 'draw_arc', { center: [0, 0], radius });
      return { doc: drawn.document, id: drawn.affected[0] as string };
    };

    it('the bent plate faces are freeform and the geodesic chart of a circle is the development: length 2 pi a, strain 0, on the convex and the concave face', () => {
      const plate = bent();
      for (const [radius, a] of [
        [50, 6],
        [44, 5],
      ] as const) {
        const disk = circle(plate.doc, a);
        const wrapped = must(disk.doc, 'wrap_to_face', {
          id: plate.id,
          face: { faceNear: at45(radius) },
          entityIds: [disk.id],
          placement: { method: 'geodesic', anchor: { chart: [0, 0], on: at45(radius) } },
        });
        const data = wrapped.data as Row;
        expect(data['faceKind']).toBe('other');
        const length = ((data['curves'] as Row[])[0] as Row)['length3d'] as number;
        expect(relative(length, 2 * Math.PI * a), `R ${radius}`).toBeLessThan(2e-5);
        expect(Math.abs((data['distortion'] as Row)['maxLengthStrain'] as number)).toBeLessThan(2e-5);
        expect(relative((data['distortion'] as Row)['areaRatio'] as number, 1)).toBeLessThan(2e-5);
      }
    });

    it('parametric chart: the stretch of the (u, v) rates of the bent plate is measured and reported (not hidden)', () => {
      const plate = bent();
      const disk = circle(plate.doc, 6);
      const wrapped = must(disk.doc, 'wrap_to_face', {
        id: plate.id,
        face: { faceNear: at45(50) },
        entityIds: [disk.id],
        placement: { method: 'parametric', anchor: { chart: [0, 0], on: at45(50) } },
        maxLengthStrain: 0.5,
      });
      const info = (wrapped.data as Row)['distortion'] as Row;
      expect(info['method']).toBe('parametric');
      expect(info['samples'] as number).toBeGreaterThan(100);
      expect(Number.isFinite(info['maxAbsLengthStrain'])).toBe(true);
      expect(info['maxAbsLengthStrain'] as number).toBeLessThan(0.3);
    });

    it('emboss and deboss of a circle on the bent plate equal the closed form of the pull-walled relief on the cylinder (1e-4): convex and concave', () => {
      const plate = bent();
      const cases = [
        { radius: 50, a: 6, mode: 'emboss', depth: 1.5, inner: 50, outer: 51.5 },
        { radius: 50, a: 6, mode: 'deboss', depth: 1.5, inner: 48.5, outer: 50 },
        { radius: 44, a: 5, mode: 'emboss', depth: 1.5, inner: 42.5, outer: 44 },
        { radius: 44, a: 5, mode: 'deboss', depth: 1.5, inner: 44, outer: 45.5 },
      ] as const;
      for (const item of cases) {
        const disk = circle(plate.doc, item.a);
        const done = must(disk.doc, 'emboss_on_face', {
          id: plate.id,
          face: { faceNear: at45(item.radius) },
          profileIds: [disk.id],
          mode: item.mode,
          depth: item.depth,
          placement: { method: 'geodesic', anchor: { chart: [0, 0], on: at45(item.radius) } },
        });
        const data = done.data as Row;
        const expected = closedFormVolume(item.radius, item.a, item.inner, item.outer) * (item.mode === 'emboss' ? 1 : -1);
        expect(relative(data['volumeDelta'] as number, expected), `${item.mode} R ${item.radius}`).toBeLessThan(1e-4);
        expect(data['exact']).toBe(false);
        const freeform = data['freeform'] as Row;
        expect(freeform['walls']).toBe('pull');
        expect(freeform['footprintDeviation'] as number).toBeLessThan(2e-4);
      }
    });

    it('a lattice-warped plate is genuinely freeform: the saddle strain is measured and the relief volume is area x depth (1e-3)', () => {
      const plate = must(base(), 'add_box', { size: [60, 60, 10] });
      const moves = [
        [1, 1, 10],
        [3, 3, 10],
        [1, 3, -10],
        [3, 1, -10],
      ].map(([i, j, dz]) => ({ index: [i, j, 1], delta: [0, 0, dz] }));
      const warped = must(plate.document, 'deform_lattice', {
        id: plate.affected[0],
        degrees: [4, 4, 2],
        box: { min: [-40, -40, -20], max: [40, 40, 20] },
        moves,
      });
      const id = warped.affected[0] as string;
      const disk = circle(warped.document, 14);
      const where = { faceNear: [0, 0, 5] };
      const wrapped = must(disk.doc, 'wrap_to_face', {
        id,
        face: where,
        entityIds: [disk.id],
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 5] } },
      });
      const info = (wrapped.data as Row)['distortion'] as Row;
      expect(info['maxAbsLengthStrain'] as number).toBeGreaterThan(1e-4);
      expect(info['maxAbsLengthStrain'] as number).toBeLessThan(0.05);
      const done = must(disk.doc, 'emboss_on_face', {
        id,
        face: where,
        profileIds: [disk.id],
        mode: 'emboss',
        depth: 0.4,
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 5] } },
      });
      const data = done.data as Row;
      expect(relative(data['volumeDelta'] as number, (data['regionArea'] as number) * 0.4)).toBeLessThan(1e-3);
      expect(data['faceKind']).toBe('other');
    });

    it('a deboss deeper than the plate (6 along the normal) refuses with the depth it reaches, a shallower one cuts', () => {
      const plate = bent();
      const disk = circle(plate.doc, 3);
      const params = {
        id: plate.id,
        face: { faceNear: at45(50) },
        profileIds: [disk.id],
        mode: 'deboss',
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on: at45(50) } },
      };
      const through = refused(disk.doc, 'emboss_on_face', { ...params, depth: 7 });
      expect(codeOf(through)).toBe('WRP_DEPTH_EXCEEDS_SOLID');
      expect(Math.abs(((through.data as Row)['maxDepth'] as number) - 6)).toBeLessThan(1e-3);
      must(disk.doc, 'emboss_on_face', { ...params, depth: 2 });
    });

    it('refusals by name: a circle beyond the face edge, develop and scribe on a freeform face', () => {
      const plate = bent();
      const huge = circle(plate.doc, 30);
      const outside = refused(huge.doc, 'emboss_on_face', {
        id: plate.id,
        face: { faceNear: at45(50) },
        profileIds: [huge.id],
        mode: 'emboss',
        depth: 1,
        placement: { method: 'geodesic', anchor: { chart: [0, 0], on: at45(50) } },
      });
      expect(codeOf(outside)).toBe('WRP_OUTSIDE_FACE');
      const disk = circle(plate.doc, 3);
      const develop = refused(disk.doc, 'wrap_to_face', { id: plate.id, face: { faceNear: at45(50) }, entityIds: [disk.id] });
      expect(codeOf(develop)).toBe('WRP_FACE_NOT_DEVELOPABLE');
      const scribe = refused(disk.doc, 'emboss_on_face', {
        id: plate.id,
        face: { faceNear: at45(50) },
        profileIds: [disk.id],
        mode: 'scribe',
        placement: { method: 'geodesic' },
      });
      expect(codeOf(scribe)).toBe('WRP_METHOD_UNAVAILABLE');
    });
  },
);
