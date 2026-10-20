/** M6 shell idealization set-up: midsurface fast paths, face pairing, plane stress, composite laminate, extract_midsurface, defeature_for_analysis. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { analysisInputHash } from '@cae/hash/inputHash';
import { planarLoops } from '@cae/shell/faceLoops';
import { laminateOf } from '@cae/shell/laminate';
import { partMidsurfaceGeometry } from '@cae/shell/meshGeometry';
import { midsurfaceOf } from '@cae/shell/midsurface';
import { distinctThicknesses, extentOf } from '@cae/shell/types';
import { caseIn } from './helpers';
import { composites, ctxWith, must, plateDocument, plateKernel, sheetMetal } from './shellFixtures';

const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const near = (a: Vec3, b: Vec3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;

describe('set_part_idealization shell (box plate fast path)', () => {
  it('finds the mid rectangle, stores the wall thickness and leaves the input untouched', () => {
    const { doc, plateId, analysisId } = plateDocument();
    const before = structuredClone(doc);
    const result = execute(doc, 'set_part_idealization', { analysisId, entityId: plateId, idealization: 'shell' });
    expect(result.rejected).not.toBe(true);
    expect(doc).toEqual(before);
    expect(result.summary).toContain('box_plate midsurface, t = 2, offset mid, 1 mid face');
    expect(caseIn(result.document, analysisId).parts[plateId]).toEqual({
      kind: 'shell',
      thickness: 2,
      offset: 'mid',
      midsurface: { maxThickness: 2, angularTolDeg: 1 },
    });
    const geometry = partMidsurfaceGeometry(result.document, analysisId, plateId, null);
    expect(geometry !== null && 'faces' in geometry ? geometry.faces[0]?.outer.every((point) => point[2] === 1) : false).toBe(true);
  });

  it('meshes the top surface with offset top and keeps given thickness, coverage and composite settings', () => {
    const { doc, plateId, analysisId } = plateDocument();
    const top = must(doc, 'set_part_idealization', {
      analysisId,
      entityId: plateId,
      idealization: 'shell',
      offset: 'top',
      thickness: 2.5,
      maxThickness: 3,
      angularTolDeg: 2,
      midsurfaceMinCoverage: 0.9,
    });
    expect(caseIn(top, analysisId).parts[plateId]).toMatchObject({ thickness: 2.5, offset: 'top', midsurface: { minCoverage: 0.9 } });
    const geometry = partMidsurfaceGeometry(top, analysisId, plateId, null);
    expect(geometry !== null && 'faces' in geometry ? geometry.faces[0]?.outer[0]?.[2] : null).toBeCloseTo(2.25);
    expect(partMidsurfaceGeometry(top, analysisId, 'ghost', null)).toBeNull();
  });

  it('warns about a thick shell and refuses non-plates, other case types and missing faces', () => {
    const thick = plateDocument('static', [12, 8, 2]);
    const result = execute(thick.doc, 'set_part_idealization', {
      analysisId: thick.analysisId,
      entityId: thick.plateId,
      idealization: 'shell',
    });
    expect(result.summary).toContain('WARNING thick shell');
    const cube = plateDocument('static', [10, 10, 10]);
    expect(
      code(execute(cube.doc, 'set_part_idealization', { analysisId: cube.analysisId, entityId: cube.plateId, idealization: 'shell' })),
    ).toBe('FEA_MIDSURFACE_NOT_A_PLATE');
    const plate = plateDocument();
    expect(
      code(
        execute(plate.doc, 'set_part_idealization', {
          analysisId: plate.analysisId,
          entityId: plate.plateId,
          idealization: 'shell',
          maxThickness: 1,
        }),
      ),
    ).toBe('FEA_MIDSURFACE_NOT_THIN');
    const heat = plateDocument('heat_steady');
    expect(
      code(execute(heat.doc, 'set_part_idealization', { analysisId: heat.analysisId, entityId: heat.plateId, idealization: 'shell' })),
    ).toBe('FEA_PART_INVALID');
  });
});

describe('sheet-metal fast path', () => {
  const withSheet = (form = false): { doc: CadDocument; plateId: string; analysisId: string } => {
    const plate = plateDocument();
    return { ...plate, doc: { ...plate.doc, sheetMetal: sheetMetal(plate.plateId, form) } };
  };

  it('puts the flats on the mid plane and joins them with mid-radius strips', () => {
    const { doc, plateId } = withSheet();
    const mid = midsurfaceOf(doc, plateId, {}, null);
    if ('code' in mid) throw new Error(mid.message);
    expect(mid.method).toBe('sheet_metal');
    expect(mid.thicknesses).toEqual([1]);
    const flat = mid.faces.find((face) => face.source === 'flat f1');
    expect(flat?.outer.every((point) => point[2] === 0.5)).toBe(true);
    expect(flat?.holes).toHaveLength(1);
    const strips = mid.faces.filter((face) => face.source.startsWith('bend b1'));
    expect(strips).toHaveLength(6);
    const coarse = midsurfaceOf(doc, plateId, { stripLength: 10 }, null);
    expect('faces' in coarse ? coarse.faces.filter((face) => face.source.startsWith('bend b1')) : []).toHaveLength(1);
    const fine = midsurfaceOf(doc, plateId, { stripLength: 1 }, null);
    expect('faces' in fine ? fine.faces.filter((face) => face.source.startsWith('bend b1')) : []).toHaveLength(4);
    expect(strips[0]?.outer.some((point) => near(point, [0, 0, 0.5]))).toBe(true);
    expect(strips.at(-1)?.outer.some((point) => near(point, [0, 2.5, 3]))).toBe(true);
    for (const strip of strips) for (const point of strip.outer) expect(Math.hypot(point[1], point[2] - 3)).toBeCloseTo(2.5, 9);
  });

  it('warns about forms and refuses a part without rule or with a broken bend', () => {
    const { doc, plateId, analysisId } = withSheet(true);
    const result = execute(doc, 'set_part_idealization', { analysisId, entityId: plateId, idealization: 'shell' });
    expect(result.summary).toContain('form fm (bead) is not on the midsurface');
    expect(analysisInputHash(result.document, analysisId, 'mesh')).not.toBe(
      analysisInputHash({ ...result.document, sheetMetal: sheetMetal(plateId) }, analysisId, 'mesh'),
    );
    const model = sheetMetal(plateId);
    const noRule: CadDocument = { ...doc, sheetMetal: { ...model, rules: {} } };
    expect(midsurfaceOf(noRule, plateId, {}, null)).toMatchObject({ code: 'FEA_MIDSURFACE_FAILED' });
    const part = model.parts['sm-1'];
    if (part === undefined) throw new Error('fixture');
    const moved = {
      ...part,
      nodes: { ...part.nodes, f2: { ...part.nodes['f2'], frame: { origin: [0, 3, 6], xDir: [1, 0, 0], normal: [0, -1, 0] } } },
    };
    const broken = { ...doc, sheetMetal: { ...model, parts: { 'sm-1': moved } } } as CadDocument;
    expect(midsurfaceOf(broken, plateId, {}, null)).toMatchObject({ code: 'FEA_MIDSURFACE_FAILED' });
    const orphan = { ...part, nodes: { ...part.nodes, b1: { ...part.nodes['b1'], to: 'nope' } } };
    expect(midsurfaceOf({ ...doc, sheetMetal: { ...model, parts: { 'sm-1': orphan } } } as CadDocument, plateId, {}, null)).toMatchObject({
      code: 'FEA_MIDSURFACE_FAILED',
    });
  });
});

describe('face pairing over the exact kernel', () => {
  const cylinderPart = (): { doc: CadDocument; id: string; analysisId: string } => {
    const plate = plateDocument();
    const added = execute(plate.doc, 'add_cylinder', { radius: 5, height: 2 });
    return { doc: added.document, id: added.affected[0] ?? '', analysisId: plate.analysisId };
  };

  it('pairs top and bottom, skips the side strips and meshes the mid face', () => {
    const { doc, id, analysisId } = cylinderPart();
    const kernel = plateKernel();
    const mid = midsurfaceOf(doc, id, { maxThickness: 3 }, kernel);
    if ('code' in mid) throw new Error(mid.message);
    expect(mid).toMatchObject({ method: 'face_pairing', coverage: 1, unpairedFaces: [], thicknesses: [2] });
    expect(mid.faces[0]?.outer.map((point) => point[2])).toEqual([1, 1, 1, 1]);
    const result = execute(
      doc,
      'set_part_idealization',
      { analysisId, entityId: id, idealization: 'shell', maxThickness: 3 },
      ctxWith(kernel),
    );
    expect(result.summary).toContain('face_pairing midsurface, t = 2');
    const preview = execute(doc, 'extract_midsurface', { entityId: id, maxThickness: 3, angularTolDeg: 1 }, ctxWith(kernel));
    expect(preview.summary).toContain('area 5000');
    expect(preview.data).toMatchObject({ method: 'face_pairing', coverage: 1 });
  });

  it('refuses low coverage, missing parameters and missing kernels', () => {
    const { doc, id, analysisId } = cylinderPart();
    const low = execute(
      doc,
      'set_part_idealization',
      { analysisId, entityId: id, idealization: 'shell', maxThickness: 3 },
      ctxWith(plateKernel({ cylinder: true })),
    );
    expect(code(low)).toBe('FEA_MIDSURFACE_COVERAGE');
    const partial = midsurfaceOf(doc, id, { maxThickness: 3 }, plateKernel({ cylinder: true }));
    expect(partial).toMatchObject({ unpairedFaces: [6] });
    expect('warnings' in partial ? partial.warnings.join(' ') : '').toContain('cylindrical wall pairs are not built');
    expect(code(execute(doc, 'set_part_idealization', { analysisId, entityId: id, idealization: 'shell' }, ctxWith(plateKernel())))).toBe(
      'FEA_PARAM_INVALID',
    );
    expect(
      code(execute(doc, 'set_part_idealization', { analysisId, entityId: id, idealization: 'shell', thickness: 2 }, ctxWith(null))),
    ).toBe('FEA_KERNEL_OCC_REQUIRED');
    expect(midsurfaceOf(doc, id, { maxThickness: 3 }, plateKernel({ noQuery: true }))).toMatchObject({ code: 'FEA_KERNEL_OCC_REQUIRED' });
    expect(midsurfaceOf(doc, id, { maxThickness: 1 }, plateKernel())).toMatchObject({ code: 'FEA_MIDSURFACE_NO_PAIRS' });
    expect(midsurfaceOf(doc, 'ghost', {}, null)).toMatchObject({ code: 'FEA_PART_INVALID' });
    expect(code(execute(doc, 'extract_midsurface', { entityId: id }))).toBe('FEA_PARAM_INVALID');
  });
});

describe('plane_stress', () => {
  it('takes the box face in z = 0 and refuses faces elsewhere', () => {
    const { doc, plateId, analysisId } = plateDocument();
    const ok = execute(doc, 'set_part_idealization', {
      analysisId,
      entityId: plateId,
      idealization: 'plane_stress',
      thickness: 2,
      sourceFacesNear: [[50, 25, 0]],
    });
    expect(ok.summary).toContain('plane stress on box face');
    expect(caseIn(ok.document, analysisId).parts[plateId]).toEqual({ kind: 'plane_stress', thickness: 2, sourceFacesNear: [[50, 25, 0]] });
    const geometry = partMidsurfaceGeometry(ok.document, analysisId, plateId, null);
    expect(geometry).toMatchObject({ element: 'plane_stress', thickness: 2, faces: [{ normal: [0, 0, 1] }] });
    const top = execute(doc, 'set_part_idealization', {
      analysisId,
      entityId: plateId,
      idealization: 'plane_stress',
      thickness: 2,
      sourceFacesNear: [[50, 25, 2]],
    });
    expect(code(top)).toBe('FEA_PLANE_STRESS_NOT_XY');
    const side = execute(doc, 'set_part_idealization', {
      analysisId,
      entityId: plateId,
      idealization: 'plane_stress',
      thickness: 2,
      sourceFacesNear: [[0, 25, 1]],
    });
    expect(code(side)).toBe('FEA_PLANE_STRESS_NOT_XY');
    expect(code(execute(doc, 'set_part_idealization', { analysisId, entityId: plateId, idealization: 'plane_stress' }))).toBe(
      'FEA_PARAM_INVALID',
    );
  });

  it('reads other solids through the kernel face query', () => {
    const plate = plateDocument();
    const added = execute(plate.doc, 'add_cylinder', { radius: 5, height: 2 });
    const id = added.affected[0] ?? '';
    const params = { analysisId: plate.analysisId, entityId: id, idealization: 'plane_stress', thickness: 1, sourceFacesNear: [[5, 5, 0]] };
    expect(execute(added.document, 'set_part_idealization', params, ctxWith(plateKernel())).summary).toContain('plane stress on face 0');
    expect(code(execute(added.document, 'set_part_idealization', params, ctxWith(null)))).toBe('FEA_KERNEL_OCC_REQUIRED');
  });
});

describe('composite shell laminate', () => {
  it('stores the laminate, uses its thickness and refuses zoned, core and foreign laminates', () => {
    const plate = plateDocument();
    const doc: CadDocument = { ...plate.doc, composites: composites(plate.plateId) };
    const result = execute(doc, 'set_part_idealization', {
      analysisId: plate.analysisId,
      entityId: plate.plateId,
      idealization: 'shell',
      compositePartId: 'cp-1',
      maxThickness: 3,
    });
    expect(result.summary).toContain("laminate 'cp-1' 2 plies");
    expect(result.summary).toContain('WARNING laminate thickness 0.25 differs from the wall 2');
    expect(caseIn(result.document, plate.analysisId).parts[plate.plateId]).toMatchObject({
      thickness: 0.25,
      laminate: { compositePartId: 'cp-1' },
    });
    expect(laminateOf(doc, 'cp-1', plate.plateId)).toMatchObject({ thickness: 0.25, stackNormal: [0, 0, 1] });
    expect(laminateOf({ ...doc, composites: composites(plate.plateId, true) }, 'cp-1', plate.plateId)).toMatchObject({
      code: 'FEA_COMPOSITE_ZONES_UNSUPPORTED',
    });
    expect(laminateOf({ ...doc, composites: composites(plate.plateId, false, true) }, 'cp-1', plate.plateId)).toMatchObject({
      code: 'FEA_COMPOSITE_CORE_UNSUPPORTED',
    });
    expect(laminateOf(doc, 'cp-1', 'other')).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    expect(laminateOf(plate.doc, 'cp-1', plate.plateId)).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    const empty = composites(plate.plateId);
    expect(laminateOf({ ...doc, composites: { ...empty, plyOrder: [] } }, 'cp-1', plate.plateId)).toMatchObject({
      code: 'FEA_COMPOSITE_INVALID',
    });
    expect(laminateOf({ ...doc, composites: { ...empty, materials: {} } }, 'cp-1', plate.plateId)).toMatchObject({
      code: 'FEA_COMPOSITE_INVALID',
    });
    expect(
      code(
        execute(doc, 'set_part_idealization', {
          analysisId: plate.analysisId,
          entityId: plate.plateId,
          idealization: 'shell',
          compositePartId: 'x',
        }),
      ),
    ).toBe('FEA_COMPOSITE_INVALID');
  });
});

describe('defeature_for_analysis', () => {
  it('sets, replaces and clears the defeaturing of a solid part and makes the mesh stale', () => {
    const { doc, plateId, analysisId } = plateDocument();
    const part = must(doc, 'set_part_idealization', { analysisId, entityId: plateId });
    const before = analysisInputHash(part, analysisId, 'mesh');
    const set = execute(part, 'defeature_for_analysis', { analysisId, entityId: plateId, maxFeatureSize: 1.5, facesNear: [[0, 0, 1]] });
    expect(set.summary).toContain('blends / holes of radius <= 1.5 mm and 1 picked face(s)');
    expect(caseIn(set.document, analysisId).defeature).toEqual({ [plateId]: { maxFeatureSize: 1.5, facesNear: [[0, 0, 1]] } });
    expect(analysisInputHash(set.document, analysisId, 'mesh')).not.toBe(before);
    const cleared = execute(set.document, 'defeature_for_analysis', { analysisId, entityId: plateId, clear: true });
    expect(caseIn(cleared.document, analysisId).defeature).toBeUndefined();
    expect(analysisInputHash(cleared.document, analysisId, 'mesh')).toBe(before);
    expect(code(execute(part, 'defeature_for_analysis', { analysisId, entityId: plateId }))).toBe('FEA_PARAM_INVALID');
    expect(code(execute(part, 'defeature_for_analysis', { analysisId: 'x', entityId: plateId, maxFeatureSize: 1 }))).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expect(code(execute(doc, 'defeature_for_analysis', { analysisId, entityId: plateId, maxFeatureSize: 1 }))).toBe(
      'FEA_PART_NOT_IN_ANALYSIS',
    );
  });
});

describe('geometry helpers', () => {
  it('reads outline and holes of a face triangulation and merges thicknesses', () => {
    // 4 x 4 square with a 2 x 2 hole, as 8 triangles.
    const positions = [0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 1, 1, 0, 3, 1, 0, 3, 3, 0, 1, 3, 0];
    const indices = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const loops = planarLoops({ positions, indices }, [0, 0, 1]);
    expect(loops?.outer).toHaveLength(4);
    expect(loops?.holes).toHaveLength(1);
    expect(planarLoops({ positions: [], indices: [] }, [0, 0, 1])).toBeNull();
    expect(distinctThicknesses([2, 1, 2 + 1e-9, 1])).toEqual([1, 2]);
    expect(extentOf([])).toBe(0);
    expect(
      extentOf([
        [0, 0, 0],
        [3, 4, 0],
      ]),
    ).toBe(5);
  });
});
