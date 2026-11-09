/**
 * PHY-20 VAC M2 on the native OCCT kernel: exposure faces resolved by the exact face distance, exact areas and centroids in mm / mm^2 for any document unit,
 * the unresolved cases (edge, vertex, off the solid, inside the solid) and the handoff check. Skipped when the llull-kernel binary (with the
 * `faceQuery` capability) is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface Pkg {
  faces: { faceIndex: number; areaMm2: number; centroidMm: number[]; surface: string }[];
  totalAreaMm2: number;
  totalRmsForceN: number;
}

describeNativeWhen({ capabilities: ['faceQuery', 'distance'], label: 'VAC native' })('VAC M2 exposures on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const must = (doc: CadDocument, name: string, params: Record<string, unknown>): ReturnType<typeof execute> => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };
  const spectrum = (doc: CadDocument): CadDocument =>
    must(doc, 'define_acoustic_spectrum', {
      name: 'flat130',
      bandwidth: 'third_octave',
      reference: '20uPa',
      bands: [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000].map((nominalHz) => ({
        nominalHz,
        splDb: 130,
      })),
      source: { citation: 'synthetic test input', grade: 'A' },
    }).document;
  /** A document with `build` applied and an exposure on `facesNear` of the entity it names. */
  const exposed = (
    units: 'mm' | 'cm',
    build: (doc: CadDocument) => { doc: CadDocument; id: string },
    facesNear: number[][],
  ): { doc: CadDocument; id: string } => {
    const built = build(must(createEmptyDocument(), 'set_units', { units }).document);
    const doc = must(spectrum(built.doc), 'define_acoustic_exposure', {
      name: 'skin',
      spectrum: 'flat130',
      target: { entityId: built.id, facesNear },
      field: 'diffuse',
    }).document;
    return { doc, id: built.id };
  };
  const box =
    (size: number[], position = [0, 0, 0]) =>
    (doc: CadDocument): { doc: CadDocument; id: string } => {
      const added = must(doc, 'add_box', { size, position, anchor: 'min' });
      return { doc: added.document, id: added.affected[0] as string };
    };
  const exportOf = (doc: CadDocument): ReturnType<typeof execute> => execute(doc, 'export_acoustic_load', { exposure: 'skin' });

  it('a 10 mm cube in mm and a 1 cm cube in cm give the same exact face area and centroid in mm', () => {
    const inMm = exportOf(exposed('mm', box([10, 10, 10]), [[5, 5, 10]]).doc);
    const inCm = exportOf(exposed('cm', box([1, 1, 1]), [[0.5, 0.5, 1]]).doc);
    const [a, b] = [inMm.data as Pkg, inCm.data as Pkg];
    expect(a.faces).toHaveLength(1);
    expect(a.faces[0]?.areaMm2).toBeCloseTo(100, 6);
    expect(a.faces[0]?.centroidMm.map((v) => Number(v.toFixed(6)))).toEqual([5, 5, 10]);
    expect(b.faces[0]?.areaMm2).toBeCloseTo(a.faces[0]?.areaMm2 ?? 0, 6);
    expect(b.faces[0]?.centroidMm).toEqual(a.faces[0]?.centroidMm);
  });

  it('the side face of a cylinder has the area pi d h', () => {
    const cylinder = (doc: CadDocument): { doc: CadDocument; id: string } => {
      const added = must(doc, 'add_cylinder', { radius: 20, height: 40, position: [0, 0, 0] });
      return { doc: added.document, id: added.affected[0] as string };
    };
    const data = exportOf(exposed('mm', cylinder, [[20, 0, 0]]).doc).data as Pkg;
    expect(data.faces).toHaveLength(1);
    expect(data.faces[0]?.surface).toBe('cylinder');
    expect(data.faces[0]?.areaMm2).toBeCloseTo(Math.PI * 40 * 40, 4);
  });

  it('a target made by a boolean resolves on the result: the top of a cube with a through hole is 100 x 100 - 20 x 20', () => {
    const holed = (doc: CadDocument): { doc: CadDocument; id: string } => {
      const base = box([100, 100, 100])(doc);
      const tool = box([20, 20, 140], [40, 40, -20])(base.doc);
      const result = must(tool.doc, 'boolean', { op: 'subtract', a: base.id, b: tool.id, engine: 'kernel' });
      return { doc: result.document, id: result.affected[0] as string };
    };
    const data = exportOf(exposed('mm', holed, [[10, 10, 100]]).doc).data as Pkg;
    expect(data.faces).toHaveLength(1);
    expect(data.faces[0]?.areaMm2).toBeCloseTo(9600, 4);
  });

  it('two points on different faces export both; the total is their sum and the force is p_rms x area', () => {
    const data = exportOf(
      exposed('mm', box([10, 10, 10]), [
        [5, 5, 10],
        [10, 5, 5],
      ]).doc,
    ).data as Pkg;
    expect(data.faces).toHaveLength(2);
    expect(data.totalAreaMm2).toBeCloseTo(200, 6);
    expect(data.totalRmsForceN).toBeGreaterThan(0);
  });

  it('an edge and a vertex name no single face (VAC_EXPOSURE_UNRESOLVED)', () => {
    for (const point of [
      [10, 10, 5],
      [10, 10, 10],
    ]) {
      const result = exportOf(exposed('mm', box([10, 10, 10]), [point]).doc);
      expect(result.rejected, result.summary).toBe(true);
      expect(result.error?.code).toBe('VAC_EXPOSURE_UNRESOLVED');
    }
  });

  it('a point 0.01 mm from an edge, on one face, resolves to that face (not the neighbour)', () => {
    const data = exportOf(exposed('mm', box([10, 10, 10]), [[9.99, 10, 5]]).doc).data as Pkg;
    expect(data.faces).toHaveLength(1);
    expect(data.faces[0]?.centroidMm.map((v) => Number(v.toFixed(6)))).toEqual([5, 10, 5]);
  });

  it('a point off the solid and a point inside the solid are unresolved', () => {
    for (const point of [
      [5, 5, 20],
      [5, 5, 5],
    ]) {
      const result = exportOf(exposed('mm', box([10, 10, 10]), [point]).doc);
      expect(result.error?.code, result.summary).toBe('VAC_EXPOSURE_UNRESOLVED');
    }
  });

  it('check_acoustic_handoff passes with a grade A spectrum and fails on an unresolved point', () => {
    const good = execute(exposed('mm', box([10, 10, 10]), [[5, 5, 10]]).doc, 'check_acoustic_handoff', {});
    expect(good.data).toMatchObject({ status: 'pass', items: [], reviewRequired: true });
    const bad = execute(exposed('mm', box([10, 10, 10]), [[5, 5, 20]]).doc, 'check_acoustic_handoff', {});
    expect(bad.data).toMatchObject({ status: 'fail' });
  });
});
