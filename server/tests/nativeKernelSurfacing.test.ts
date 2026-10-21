/**
 * 02 SRF on the native OCC kernel (spec §13.4 / §13.7 first actions): the NACA 0012 trapezoidal wing of `plans/target_naca0012_trap_wing.json`
 * (cr 2 m, ct 1 m, b/2 5 m, linear loft, open trailing edge) built from the exact sections.
 * - VC-SRF-11: volume of the half wing 0.959117 m^3: OCC mass properties of the exact B-rep within 1e-5 (measured 3e-7), mass_properties (mesh) 1e-4;
 * - VC-SRF-22: section fidelity, the root and tip airfoil curves lie on the lofted skin within 1e-5 chord (exact projection on the skin faces).
 * The sidecar reports `bsplineSections`, so the loft is built from one B-spline curve per section. Skipped without the llull-kernel binary.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel, type ShapeHandle } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { sampleCurve } from '@lib/nurbs/evaluate';
import type { Entity, Vec3 } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import { dataOf, Workspace } from './feaThermomechSupport';

const PLAN = path.resolve(__dirname, '../../docs/aerospace/02-advanced-surfacing/validation/plans/target_naca0012_trap_wing.json');

let workspace: Workspace;
let kernel: IsolatedKernel;
beforeAll(() => {
  workspace = new Workspace();
}, 120_000);
afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

describeNative('NACA 0012 trapezoidal wing on the native kernel (VC-SRF-11, VC-SRF-22)', () => {
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);

  it('builds the half wing from B-spline sections with the exact volume and the airfoils on its skin', async () => {
    expect(kernel.info?.().capabilities ?? []).toContain('bsplineSections');
    const session = workspace.open('naca-wing');
    const wingId = (await session.run(PLAN))['wing']?.[0] ?? '';
    const mass = await session.cli('mass_properties', `entityId=${wingId}`);
    expect(Number(dataOf(mass.json)['volume']) / 0.959117 - 1).toBeLessThan(1e-4);
    expect(Number(dataOf(mass.json)['volume']) / 0.959117 - 1).toBeGreaterThan(-1e-4);

    const doc = deserializeDocument(readFileSync(session.docPath, 'utf8'));
    const wing = doc.entities[wingId] as (Entity & { kind: 'loft' }) | undefined;
    expect(wing?.sections).toHaveLength(2);
    const handle = kernel.evaluate({ op: 'solid', entity: wing as Entity }) as ShapeHandle;
    // the command takes the exact B-rep mass of a loft from OCC (LIM-1 #7; measured 0.9591167, 3e-7 from the closed form)
    expect(dataOf(mass.json)['method']).toBe('exact');
    expect(Math.abs(Number(dataOf(mass.json)['volume']) / 0.959117 - 1)).toBeLessThan(1e-5);
    expect(Math.abs((kernel.massProperties?.(handle)?.volume ?? 0) / 0.959117 - 1)).toBeLessThan(1e-5);
    const query = kernel.faceQuery as FaceQueryPort;
    const skin = (query.faceDetails(handle) ?? []).filter((face) => face.surface !== 'plane').map((face) => face.index);
    expect(skin.length).toBeGreaterThan(0);
    const origin = wing?.position ?? [0, 0, 0];
    expect(wing?.rotation).toEqual([0, 0, 0]);
    for (const [index, chord] of [
      [0, 2],
      [1, 1],
    ] as const) {
      const section = wing?.sections?.[index];
      if (section === undefined) throw new Error('no section');
      const points = sampleCurve(section, 400).map((point): Vec3 => [point[0] + origin[0], point[1] + origin[1], point[2] + origin[2]]);
      const nearest = points.map(() => Number.POSITIVE_INFINITY);
      for (const face of skin)
        (query.projectOnFace(handle, face, points) ?? []).forEach((projection, k) => {
          if (projection !== null) nearest[k] = Math.min(nearest[k] ?? Number.POSITIVE_INFINITY, projection.distance);
        });
      expect(Math.max(...nearest) / chord, `section ${index}`).toBeLessThan(1e-5);
    }
  }, 300_000);
});
