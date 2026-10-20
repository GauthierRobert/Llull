/** Refusal and edge branches of the M6 shell code: mesh geometry, laminates, BDF composite cards, face loops, box plates, bends. */
import { describe, expect, it } from 'vitest';
import type { AnalysisCase, FeMeshArtifact, Idealization } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext } from '@cae/decks/context';
import { compositeCards } from '@cae/decks/bdf/composite';
import { planarLoops } from '@cae/shell/faceLoops';
import { laminateOf } from '@cae/shell/laminate';
import { partMidsurfaceGeometry } from '@cae/shell/meshGeometry';
import { midsurfaceOf } from '@cae/shell/midsurface';
import { compositePlane, laminaProblem, projectedAxis } from '@cae/shell/shellDeck';
import { composites, plateDocument, plateKernel, sheetMetal } from './shellFixtures';

const SHELL: Idealization = { kind: 'shell', thickness: 2, offset: 'mid', midsurface: { maxThickness: 3, angularTolDeg: 1 } };

/** The plate document with `idealization` written straight into the case (no command: refusal paths of later stages). */
function withPart(idealization: Idealization, extra: Partial<CadDocument> = {}): { doc: CadDocument; plateId: string; analysisId: string } {
  const plate = plateDocument();
  const analysis = plate.doc.analysis?.cases[plate.analysisId] as AnalysisCase;
  const doc: CadDocument = {
    ...plate.doc,
    ...extra,
    analysis: { cases: { [plate.analysisId]: { ...analysis, parts: { [plate.plateId]: idealization } } }, caseOrder: [plate.analysisId] },
  };
  return { doc, plateId: plate.plateId, analysisId: plate.analysisId };
}

describe('partMidsurfaceGeometry refusals', () => {
  it('passes refusals of the midsurface, coverage, laminate and plane stress through', () => {
    const notThin = withPart({ ...SHELL, midsurface: { maxThickness: 1, angularTolDeg: 1 } });
    expect(partMidsurfaceGeometry(notThin.doc, notThin.analysisId, notThin.plateId, null)).toMatchObject({
      code: 'FEA_MIDSURFACE_NOT_THIN',
    });
    const auto = withPart({ ...SHELL, thickness: 'auto' });
    expect(partMidsurfaceGeometry(auto.doc, auto.analysisId, auto.plateId, null)).toMatchObject({ thickness: 2 });
    const lam = withPart({ ...SHELL, laminate: { compositePartId: 'nope' } });
    expect(partMidsurfaceGeometry(lam.doc, lam.analysisId, lam.plateId, null)).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    const plane = withPart({ kind: 'plane_stress', thickness: 2, sourceFacesNear: [[50, 25, 2]] });
    expect(partMidsurfaceGeometry(plane.doc, plane.analysisId, plane.plateId, null)).toMatchObject({ code: 'FEA_PLANE_STRESS_NOT_XY' });
    expect(partMidsurfaceGeometry(plane.doc, plane.analysisId, 'ghost', null)).toBeNull();
  });

  it('refuses a coverage below the stored minimum at mesh time', () => {
    const plate = plateDocument();
    const cylinder = {
      ...plate.doc.entities[plate.plateId],
      kind: 'cylinder',
      radius: 5,
      height: 2,
    } as unknown as CadDocument['entities'][string];
    const analysis = plate.doc.analysis?.cases[plate.analysisId] as AnalysisCase;
    const doc: CadDocument = {
      ...plate.doc,
      entities: { ...plate.doc.entities, [plate.plateId]: cylinder },
      analysis: { cases: { [plate.analysisId]: { ...analysis, parts: { [plate.plateId]: SHELL } } }, caseOrder: [plate.analysisId] },
    };
    expect(partMidsurfaceGeometry(doc, plate.analysisId, plate.plateId, plateKernel({ cylinder: true }))).toMatchObject({
      code: 'FEA_MIDSURFACE_COVERAGE',
    });
  });
});

describe('laminate sections', () => {
  it('refuses unknown sections, sections of another part, missing rosettes, materials and core plies', () => {
    const plate = plateDocument();
    const base = composites(plate.plateId);
    const section = {
      id: 's',
      partId: 'cp-1',
      name: 'S',
      plies: [{ material: 'tape', thickness: 0.1, angleDeg: 0 }],
      thickness: 0.1,
      laminateSide: 'positive_normal' as const,
    };
    const doc = (model: typeof base): CadDocument => ({ ...plate.doc, composites: model });
    expect(laminateOf(doc({ ...base, sections: { s: section } }), 'cp-1', plate.plateId, 's')).toMatchObject({ thickness: 0.1 });
    expect(laminateOf(doc(base), 'cp-1', plate.plateId, 's')).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    expect(laminateOf(doc({ ...base, sections: { s: { ...section, partId: 'x' } } }), 'cp-1', plate.plateId, 's')).toMatchObject({
      code: 'FEA_COMPOSITE_INVALID',
    });
    expect(laminateOf(doc({ ...base, rosettes: {}, sections: { s: section } }), 'cp-1', plate.plateId, 's')).toMatchObject({
      code: 'FEA_COMPOSITE_INVALID',
    });
    expect(laminateOf(doc({ ...base, sections: { s: { ...section, plies: [] } } }), 'cp-1', plate.plateId, 's')).toMatchObject({
      code: 'FEA_COMPOSITE_INVALID',
    });
    expect(
      laminateOf(
        doc({ ...base, sections: { s: { ...section, plies: [{ material: 'none', thickness: 1, angleDeg: 0 }] } } }),
        'cp-1',
        plate.plateId,
        's',
      ),
    ).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    const core = composites(plate.plateId, false, true);
    expect(laminateOf(doc({ ...core, sections: { s: section } }), 'cp-1', plate.plateId, 's')).toMatchObject({
      code: 'FEA_COMPOSITE_CORE_UNSUPPORTED',
    });
  });
});

describe('composite deck helpers', () => {
  const mesh = (doc: CadDocument, plateId: string, nodes: FeMeshArtifact['nodes']): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 't',
    mesherVersion: '1',
    inputHash: '',
    nodes,
    blocks: [{ type: 'S4', entityId: plateId, elements: [[1, 1, 2, 3, 4]] }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  });
  const square: FeMeshArtifact['nodes'] = [
    [1, 0, 0, 1],
    [2, 1, 0, 1],
    [3, 1, 1, 1],
    [4, 0, 1, 1],
  ];

  it('refuses non-composite parts, missing laminates, rosettes normal to the shell and parts without elements', () => {
    const solid = withPart({ kind: 'solid' });
    const ctx = buildDeckContext(solid.doc, solid.analysisId, mesh(solid.doc, solid.plateId, square));
    if (ctx === null) throw new Error('fixture');
    expect(compositeCards(ctx, solid.plateId, 1, 2, { worst: 0 })).toMatchObject({ code: 'FEA_PART_INVALID' });
    const missing = withPart({ ...SHELL, laminate: { compositePartId: 'cp-1' } });
    const missingCtx = buildDeckContext(missing.doc, missing.analysisId, mesh(missing.doc, missing.plateId, square));
    if (missingCtx === null) throw new Error('fixture');
    expect(compositeCards(missingCtx, missing.plateId, 1, 2, { worst: 0 })).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    const upright = withPart({ ...SHELL, laminate: { compositePartId: 'cp-1' } });
    const model = composites(upright.plateId);
    const vertical: CadDocument = {
      ...upright.doc,
      composites: { ...model, rosettes: { 'ro-1': { ...model.rosettes['ro-1']!, axis0: [0, 0, 1] } } },
    };
    const verticalCtx = buildDeckContext(vertical, upright.analysisId, mesh(vertical, upright.plateId, square));
    if (verticalCtx === null) throw new Error('fixture');
    expect(compositeCards(verticalCtx, upright.plateId, 1, 2, { worst: 0 })).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    expect(compositePlane(verticalCtx, 'ghost')).toContain('has no shell element');
    expect(projectedAxis([0, 0, 1], [0, 0, 1])).toBeNull();
    expect(laminaProblem(vertical, 'tape', { ...model.materials['tape']!, density: undefined })).toBeNull();
  });
});

describe('geometry edge branches', () => {
  it('refuses an open face triangulation, flat bends and zero-length bend lines', () => {
    expect(planarLoops({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 1] }, [0, 0, 1])).toBeNull();
    const plate = plateDocument();
    const model = sheetMetal(plate.plateId);
    const part = model.parts['sm-1']!;
    const straight = {
      ...part,
      nodes: { ...part.nodes, f2: { ...part.nodes['f2']!, frame: { origin: [0, 3, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } } },
    } as typeof part;
    const flat = midsurfaceOf({ ...plate.doc, sheetMetal: { ...model, parts: { 'sm-1': straight } } }, plate.plateId, {}, null);
    expect('faces' in flat ? flat.faces.some((face) => face.source === 'bend b1 (flat)') : false).toBe(true);
    const zero = {
      ...part,
      nodes: {
        ...part.nodes,
        b1: {
          ...part.nodes['b1']!,
          lineInFrom: [
            [0, 0],
            [0, 0],
          ],
        },
      },
    } as typeof part;
    expect(midsurfaceOf({ ...plate.doc, sheetMetal: { ...model, parts: { 'sm-1': zero } } }, plate.plateId, {}, null)).toMatchObject({
      code: 'FEA_MIDSURFACE_FAILED',
    });
    const rotated = plateDocument('static', [100, 2, 50]);
    const mid = midsurfaceOf(rotated.doc, rotated.plateId, {}, null);
    expect('faces' in mid ? mid.faces[0]?.normal : null).toEqual([0, 1, 0]);
  });
});
