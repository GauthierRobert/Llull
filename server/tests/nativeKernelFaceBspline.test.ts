/**
 * Native `faceQuery.bspline` (01 DEF §17.12): the surface of a face as one B-spline over its parameter box, checked against the kernel's own face queries.
 * A fitted B-spline face (the result of an exact warp) comes back parameter for parameter (same (u, v), same point); an elementary face (plane, cylinder, sphere,
 * cone, torus) comes back as its exact rational B-spline, so its points lie ON the face. Skipped without the binary / the capability.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { evaluateSurface, surfaceDomain } from '@core/lib/nurbs/surface';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

describeNativeWhen({ capabilities: ['deform', 'faceQuery'], label: 'nativeKernelFaceBspline' })(
  'faceQuery.bspline on the native kernel',
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

    const shapeOf = (doc: CadDocument, id: string) => kernel.evaluate(recipeOf(doc.entities[id] as never));
    const made = (name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
      const result = execute(createEmptyDocument(), name, params);
      return { doc: result.document, id: result.affected[0] as string };
    };

    it('every face of the elementary solids comes back as a B-spline whose points lie on the face', () => {
      const solids = [
        made('add_box', { size: [4, 3, 2], anchor: 'base-center' }),
        made('add_cylinder', { radius: 2, height: 5, anchor: 'base-center' }),
        made('add_sphere', { radius: 3 }),
        made('add_cone', { radius: 3, height: 4, anchor: 'base-center' }),
        made('add_torus', { ringRadius: 5, tubeRadius: 1 }),
      ];
      let faces = 0;
      for (const { doc, id } of solids) {
        const shape = shapeOf(doc, id);
        const query = kernel.faceQuery;
        expect(shape !== null && query !== undefined).toBe(true);
        if (shape === null || query === undefined) continue;
        const count = kernel.topology(shape)?.faces.length ?? 0;
        for (let face = 0; face < count; face++) {
          const surface = query.bspline(shape, face);
          expect(surface, `face ${face} of ${id}`).not.toBeNull();
          if (surface === null) continue;
          expect([surface.periodicU, surface.periodicV]).toEqual([false, false]);
          const lib = {
            degreeU: surface.degreeU,
            degreeV: surface.degreeV,
            poles: surface.poles,
            ...(surface.weights === undefined ? {} : { weights: surface.weights }),
            knotsU: surface.knotsU,
            multiplicitiesU: surface.multsU,
            knotsV: surface.knotsV,
            multiplicitiesV: surface.multsV,
          };
          const [[u0, u1], [v0, v1]] = surfaceDomain(lib as never);
          for (const [a, b] of [
            [0.5, 0.5],
            [0.3, 0.8],
            [0.8, 0.2],
          ] as const) {
            const point = evaluateSurface(lib as never, u0 + a * (u1 - u0), v0 + b * (v1 - v0)) as Vec3;
            if (query.faceContains(shape, face, point, 1e-6) !== true) continue;
            faces++;
            const hit = query.projectOnFace(shape, face, [point])?.[0];
            expect(hit?.distance ?? 1, `face ${face} of ${id}`).toBeLessThan(1e-9);
          }
        }
      }
      expect(faces).toBeGreaterThanOrEqual(10);
    });

    it('a fitted face of an exact warp comes back parameter for parameter', () => {
      const slab = made('add_box', { size: [20, 20, 6], anchor: 'base-center' });
      const result = execute(slab.doc, 'deform_by_point', {
        id: slab.id,
        point: [0, 0, 6],
        direction: [0, 0, 1],
        radius: 8,
        distance: 2,
        falloff: 'smooth_c2',
        output: { mode: 'exact', tolerance: 1e-4 },
      });
      expect(result.error, result.summary).toBeUndefined();
      const shape = shapeOf(result.document, result.affected[0] as string);
      const query = kernel.faceQuery;
      if (shape === null || query === undefined) throw new Error('no exact shape');
      const count = kernel.topology(shape)?.faces.length ?? 0;
      let compared = 0;
      for (let face = 0; face < count; face++) {
        const surface = query.bspline(shape, face);
        const geometry = query.faceGeometry(shape, face);
        if (surface === null || geometry === null || geometry.surface.type !== 'other') continue;
        const lib = {
          degreeU: surface.degreeU,
          degreeV: surface.degreeV,
          poles: surface.poles,
          knotsU: surface.knotsU,
          multiplicitiesU: surface.multsU,
          knotsV: surface.knotsV,
          multiplicitiesV: surface.multsV,
        };
        const [[u0, v0], [u1, v1]] = geometry.uvBounds;
        const uv = [0.2, 0.5, 0.8].flatMap((a) => [0.3, 0.7].map((b) => [u0 + a * (u1 - u0), v0 + b * (v1 - v0)] as const));
        const samples = query.evaluateFace(shape, face, uv) ?? [];
        uv.forEach(([u, v], k) => {
          const mine = evaluateSurface(lib as never, u, v) as Vec3;
          const theirs = (samples[k] as { point: Vec3 }).point;
          expect(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1], mine[2] - theirs[2])).toBeLessThan(1e-9);
          compared++;
        });
      }
      expect(compared).toBeGreaterThanOrEqual(6);
    });

    it('a face index out of range answers null', () => {
      const { doc, id } = made('add_box', { size: [1, 1, 1] });
      const shape = shapeOf(doc, id);
      if (shape === null) throw new Error('no shape');
      expect(kernel.faceQuery?.bspline(shape, 99)).toBeNull();
    });
  },
);
