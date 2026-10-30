/**
 * Native `faceQuery.bspline` (01 DEF §17.12): the surface of a face as one B-spline over its parameter box, checked against the kernel's own face queries.
 * A fitted B-spline face (the result of an exact warp) comes back parameter for parameter (same (u, v), same point); an elementary face (plane, cylinder, sphere,
 * cone, torus) comes back as its exact rational B-spline, so its points lie ON the face. Skipped without the binary / the capability.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { SurfaceParams } from '@core/geometry/kernelPorts';
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

    const shapeOf = (doc: CadDocument, id: string): ReturnType<IsolatedKernel['evaluate']> =>
      kernel.evaluate(recipeOf(doc.entities[id] as never));
    const made = (name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
      const result = execute(createEmptyDocument(), name, params);
      return { doc: result.document, id: result.affected[0] as string };
    };

    /** Distance of `point` from the UNTRIMMED analytic surface that `faceGeometry` reports (not from the trimmed face: a sample off the face still has to be on the surface). */
    const offSurface = (surface: SurfaceParams, point: Vec3): number => {
      const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
      const radial = (from: Vec3, axis: Vec3): [number, number] => {
        const along = dot(minus(point, from), axis);
        const d = minus(minus(point, from), [axis[0] * along, axis[1] * along, axis[2] * along]);
        return [along, norm(d)];
      };
      switch (surface.type) {
        case 'plane':
          return Math.abs(dot(minus(point, surface.origin), surface.normal));
        case 'cylinder':
          return Math.abs(radial(surface.origin, surface.axis)[1] - surface.radius);
        case 'sphere':
          return Math.abs(norm(minus(point, surface.center)) - surface.radius);
        case 'cone': {
          const [along, rho] = radial(surface.apex, surface.axis);
          return Math.abs(rho * Math.cos(surface.semiAngle) - along * Math.sin(surface.semiAngle));
        }
        case 'torus': {
          const [along, rho] = radial(surface.center, surface.axis);
          return Math.abs(Math.hypot(rho - surface.major, along) - surface.minor);
        }
        default:
          return Infinity;
      }
    };

    it('every face of the elementary solids comes back as a B-spline that lies on its analytic surface, over the whole parameter box', () => {
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
          const analytic = query.faceGeometry(shape, face)?.surface;
          expect(surface, `face ${face} of ${id}`).not.toBeNull();
          expect(analytic, `face ${face} of ${id}`).toBeDefined();
          if (surface === null || analytic === undefined) continue;
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
          let onFace = 0;
          for (let i = 0; i <= 4; i++)
            for (let j = 0; j <= 4; j++) {
              const point = evaluateSurface(lib as never, u0 + (i / 4) * (u1 - u0), v0 + (j / 4) * (v1 - v0)) as Vec3;
              expect(offSurface(analytic, point), `face ${face} of ${id} at (${i}, ${j})`).toBeLessThan(1e-9);
              if (query.faceContains(shape, face, point, 1e-6) === true) onFace++;
            }
          expect(onFace, `face ${face} of ${id}: no sample on the face itself`).toBeGreaterThanOrEqual(1);
          faces++;
        }
      }
      expect(faces).toBeGreaterThanOrEqual(10);
    });

    it('reversed says whether the face normal is the opposite of S_u x S_v: on all six faces of a box it matches evaluateFace', () => {
      const { doc, id } = made('add_box', { size: [4, 3, 2], anchor: 'base-center' });
      const shape = shapeOf(doc, id);
      const query = kernel.faceQuery;
      if (shape === null || query === undefined) throw new Error('no exact shape');
      const senses = new Set<boolean>();
      for (let face = 0; face < 6; face++) {
        const surface = query.bspline(shape, face);
        if (surface === null) throw new Error('no surface');
        const lib = {
          degreeU: surface.degreeU,
          degreeV: surface.degreeV,
          poles: surface.poles,
          knotsU: surface.knotsU,
          multiplicitiesU: surface.multsU,
          knotsV: surface.knotsV,
          multiplicitiesV: surface.multsV,
        };
        const [[u0, u1], [v0, v1]] = surfaceDomain(lib as never);
        const [u, v] = [0.5 * (u0 + u1), 0.5 * (v0 + v1)];
        const at = (a: number, b: number): Vec3 => evaluateSurface(lib as never, a, b) as Vec3;
        const [pu, pv, p0] = [at(u + 1e-3 * (u1 - u0), v), at(u, v + 1e-3 * (v1 - v0)), at(u, v)];
        const a: Vec3 = [pu[0] - p0[0], pu[1] - p0[1], pu[2] - p0[2]];
        const b: Vec3 = [pv[0] - p0[0], pv[1] - p0[1], pv[2] - p0[2]];
        const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const outward = (query.evaluateFace(shape, face, [[u, v]]) ?? [])[0]?.normal;
        expect(outward, `face ${face}`).toBeDefined();
        if (outward === undefined) continue;
        const sign = (surface.reversed === true ? -1 : 1) * (cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2]);
        expect(sign, `face ${face}`).toBeGreaterThan(0);
        senses.add(surface.reversed === true);
      }
      expect(senses.size, 'a box has faces of both senses').toBe(2);
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
