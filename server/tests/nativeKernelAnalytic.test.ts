/**
 * 01 DEF §17.11 on the native kernel: `output.preserveAnalytic` (VC-DEF-23) rebuilds the faces that stayed a plane / cylinder / cone as analytic faces, reports what it
 * recognised, and is refused by name where it cannot be done. Skipped without the binary / the capability `deform-analytic`.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

const FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;

describeNativeWhen({ capabilities: ['deform', 'deform-analytic'], label: 'nativeKernelAnalytic' })(
  'preserveAnalytic on the native kernel',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      kernel.dispose();
      setGeometryKernel(null);
    });

    const cylinder = (): { doc: CadDocument; id: string } => {
      const made = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: 40, anchor: 'base-center' });
      return { doc: made.document, id: made.affected[0] as string };
    };
    const surfaces = (doc: CadDocument, id: string): string[] => {
      const shape = kernel.evaluate((doc.entities[id] as unknown as { brep: ShapeRecipe }).brep);
      return (shape === null ? [] : (kernel.topology(shape)?.faces ?? [])).map((face) => face.surface);
    };

    it('a taper of the cylinder is one cone face and two planes, with the half angle atan((r1 - r2) / h) (VC-DEF-23 / VC-DEF-06)', () => {
      const { doc, id } = cylinder();
      const result = execute(doc, 'taper_body', {
        id,
        scaleEnd: 0.4,
        frame: FRAME,
        region: { start: 0, end: 40, falloff: 'linear' },
        output: { mode: 'exact', tolerance: 1e-4, preserveAnalytic: true },
      });
      expect(result.error, result.summary).toBeUndefined();
      const next = result.affected[0] as string;
      expect(surfaces(result.document, next).sort()).toEqual(['cone', 'plane', 'plane']);
      const data = result.data as { analyticFaces: { cone: number; plane: number; tried: number } };
      expect([data.analyticFaces.cone, data.analyticFaces.plane, data.analyticFaces.tried]).toEqual([1, 2, 3]);
      const shape = kernel.evaluate((result.document.entities[next] as unknown as { brep: ShapeRecipe }).brep);
      const index = shape === null ? -1 : (kernel.topology(shape)?.faces.findIndex((face) => face.surface === 'cone') ?? -1);
      const geometry = shape === null ? null : (kernel.faceQuery?.faceGeometry(shape, index) ?? null);
      const semi = geometry?.surface.type === 'cone' ? geometry.surface.semiAngle : 0;
      expect(Math.abs((semi * 180) / Math.PI - Math.atan(3 / 40) * (180 / Math.PI))).toBeLessThan(1e-6);
    });

    it('a twist about the axis keeps the cylinder a cylinder (VC-DEF-23 / VC-DEF-03)', () => {
      const { doc, id } = cylinder();
      const result = execute(doc, 'twist_body', {
        id,
        angleDeg: 60,
        frame: FRAME,
        region: { start: 0, end: 40, falloff: 'linear' },
        output: { mode: 'exact', tolerance: 1e-4, preserveAnalytic: true },
      });
      expect(result.error, result.summary).toBeUndefined();
      expect(surfaces(result.document, result.affected[0] as string).sort()).toEqual(['cylinder', 'plane', 'plane']);
      expect((result.data as { analyticFaces: { fromSource: number } }).analyticFaces.fromSource).toBe(1);
    });

    it('without the flag every face stays a B-spline, and it is refused by name where there is no exact result to rebuild', () => {
      const { doc, id } = cylinder();
      const plain = execute(doc, 'taper_body', {
        id,
        scaleEnd: 0.4,
        frame: FRAME,
        region: { start: 0, end: 40, falloff: 'linear' },
        output: { mode: 'exact', tolerance: 1e-4 },
      });
      expect(surfaces(plain.document, plain.affected[0] as string)).not.toContain('cone');
      const meshed = execute(doc, 'taper_body', { id, scaleEnd: 0.4, frame: FRAME, output: { mode: 'mesh', preserveAnalytic: true } });
      expect(meshed.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
      const scaled = execute(doc, 'scale_nonuniform', { id, factors: [1, 1, 2], output: { mode: 'exact', preserveAnalytic: true } });
      expect(scaled.error?.code).toBe('DEF_EXACT_UNAVAILABLE');
    });
  },
);
