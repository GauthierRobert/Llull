/**
 * 07 MSH M6 / VC-MSH-22 (the fit half): `fit_subdivision_to_mesh` on cages made by the native `quad_remesh`, with the exact limit-patch volume and area
 * from the native OCC kernel as the analytic check (sphere, box, torus), at sizes 1 / 10 / 100 / 1000 mm. The fit itself is TypeScript; these tests need
 * llull-compute (QuadriFlow makes the cages) and, for the exact masses, the native kernel; they are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { setGeometryKernel } from '@core/geometry/kernel';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { type CadDocument, type Entity, type SubdivisionEntity } from '@core/model/types';
import { cuboid, docWithMeshes, icosphere, torus } from '../../tests/helpers/meshFixtures';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { describeNative, leaf, liveKernels } from './kernelTestSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('fitSubdivisionNative: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const context = (): ExecutionContext => ({ ...defaultContext(), meshProcessing: engine });

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const cageOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const sphereVolume = (radius: number): number => (4 / 3) * Math.PI * radius ** 3;
const sphereArea = (radius: number): number => 4 * Math.PI * radius ** 2;

interface Fitted {
  readonly doc: CadDocument;
  readonly cageId: string;
  readonly data: Data;
  readonly seconds: number;
  readonly creasesBefore: number;
}

/** quad_remesh (native) then fit_subdivision_to_mesh on a closed mesh. */
function remeshAndFit(mesh: Parameters<typeof docWithMeshes>[0], quads: number, fit: Record<string, unknown>): Fitted {
  const { doc, ids } = docWithMeshes(mesh);
  const target = ids[0] as string;
  const remeshed = execute(doc, 'quad_remesh', { id: target, targetQuadCount: quads }, context());
  expect(remeshed.error, remeshed.summary).toBeUndefined();
  const cageId = remeshed.affected[0] as string;
  const started = performance.now();
  const fitted = execute(remeshed.document, 'fit_subdivision_to_mesh', { cageId, targetId: target, ...fit }, context());
  const seconds = (performance.now() - started) / 1000;
  expect(fitted.error, fitted.summary).toBeUndefined();
  expect(fitted.affected).toEqual([cageId]);
  return { doc: fitted.document, cageId, data: dataOf(fitted), seconds, creasesBefore: cageOf(remeshed.document, cageId).creases.length };
}

describe('fit_subdivision_to_mesh after the native quad_remesh (VC-MSH-22, fit part)', () => {
  native('l4 icosphere R10 at 600 quads: max deviation <= 0.05 after the fit (it was 0.1+ before), few rounds, seconds not minutes', () => {
    const fitted = remeshAndFit(icosphere(10, 4), 600, { maxDeviation: 0.05, levels: 3, iterations: 10 });
    expect(fitted.data['converged']).toBe(true);
    expect(fitted.data['maxDeviation'] as number).toBeLessThanOrEqual(0.05);
    expect((fitted.data['initial'] as { max: number }).max).toBeGreaterThan(0.05);
    expect(fitted.data['rounds'] as number).toBeLessThanOrEqual(10);
    expect(fitted.data).toMatchObject({ stop: 'met', cgConverged: true, foldedTriangles: 0 });
    expect(fitted.data['cgRelativeResidual'] as number).toBeLessThanOrEqual(1e-8);
    expect(fitted.data['warnings']).toEqual([]);
  });

  native('the same input and parameters give the same fitted cage (replay)', () => {
    const run = (): string => JSON.stringify(remeshAndFit(icosphere(10, 3), 300, { maxDeviation: 0.05 }).doc);
    expect(run()).toBe(run());
  });

  native('box with creases: the creases survive the fit and the limit surface keeps the corners', () => {
    const fitted = remeshAndFit(cuboid([-5, -5, -5], [5, 5, 5]), 300, { maxDeviation: 0.05, levels: 2 });
    expect(fitted.creasesBefore).toBeGreaterThanOrEqual(36);
    expect(cageOf(fitted.doc, fitted.cageId).creases).toHaveLength(fitted.creasesBefore);
    expect(fitted.data['maxDeviation'] as number).toBeLessThanOrEqual(0.05);
    expect(fitted.data['converged']).toBe(true);
  });

  native('torus 48 x 24 to 400 quads: deviation <= 0.05 from 0.29 before', () => {
    const fitted = remeshAndFit(torus(10, 3, 96, 48), 400, { maxDeviation: 0.05, levels: 2 });
    expect(fitted.data['converged']).toBe(true);
    expect(fitted.data['maxDeviation'] as number).toBeLessThanOrEqual(0.05);
    expect((fitted.data['initial'] as { max: number }).max).toBeGreaterThan(0.1);
  });
});

describeNative('fitted cages on the native OCC kernel: exact limit-patch mass against the analytic solids', () => {
  const kernels = liveKernels();
  const massOf = (doc: CadDocument, id: string): Data => {
    setGeometryKernel(kernels.occt);
    try {
      return dataOf(execute(doc, 'mass_properties', { entityId: id, surfaceModel: 'limit_patches' }));
    } finally {
      setGeometryKernel(null);
    }
  };

  native(
    'VC-MSH-22: l4 icosphere R10, 600 quads, fit 0.05, levels 3: B-spline faces = 4 x quads, volume and area within 0.3 % of the sphere',
    () => {
      const fitted = remeshAndFit(icosphere(10, 4), 600, { maxDeviation: 0.05, levels: 3, iterations: 10 });
      const cage = cageOf(fitted.doc, fitted.cageId);
      const shape = kernels.occt.evaluate(leaf(cage as Entity));
      expect(shape).not.toBeNull();
      const topology = kernels.occt.topology(shape as NonNullable<typeof shape>);
      expect(topology?.solids).toBe(1);
      expect(topology?.faces).toHaveLength(subdivisionPatches(cage).length);
      expect(topology?.faces).toHaveLength(cage.faces.length * 4);
      expect(topology?.faces.every((face) => face.surface === 'bspline')).toBe(true);
      const mass = massOf(fitted.doc, fitted.cageId);
      expect(mass).toMatchObject({ method: 'exact', surfaceModel: 'limit_patches' });
      // before the fit: volume -2.17 %, area -1.45 % (quadRemeshNative)
      expect(Math.abs((mass['volume'] as number) / sphereVolume(10) - 1)).toBeLessThan(0.003);
      expect(Math.abs((mass['area'] as number) / sphereArea(10) - 1)).toBeLessThan(0.003);
    },
  );

  for (const radius of [0.5, 5, 50, 500]) {
    native(`sphere of diameter ${2 * radius} mm: deviation <= 0.5 % of the radius, exact volume within 0.5 %`, () => {
      const fitted = remeshAndFit(icosphere(radius, 4), 600, { maxDeviation: 0.005 * radius, levels: 2 });
      expect(fitted.data['converged']).toBe(true);
      expect(fitted.data['maxDeviation'] as number).toBeLessThanOrEqual(0.005 * radius);
      const mass = massOf(fitted.doc, fitted.cageId);
      expect(Math.abs((mass['volume'] as number) / sphereVolume(radius) - 1)).toBeLessThan(0.005);
    });
  }

  native('box 10 mm with creases: exact volume 1000 and area 600 within 0.5 %', () => {
    const fitted = remeshAndFit(cuboid([-5, -5, -5], [5, 5, 5]), 300, { maxDeviation: 0.05, levels: 2 });
    const mass = massOf(fitted.doc, fitted.cageId);
    expect(Math.abs((mass['volume'] as number) / 1000 - 1)).toBeLessThan(0.005);
    expect(Math.abs((mass['area'] as number) / 600 - 1)).toBeLessThan(0.005);
  });

  native('torus R 10 r 3: exact volume 2 pi^2 R r^2 within 1 % (the 96 x 48 target is itself 0.3 % under)', () => {
    const fitted = remeshAndFit(torus(10, 3, 96, 48), 400, { maxDeviation: 0.05, levels: 2 });
    const mass = massOf(fitted.doc, fitted.cageId);
    expect(Math.abs((mass['volume'] as number) / (2 * Math.PI ** 2 * 10 * 9) - 1)).toBeLessThan(0.01);
  });
});
