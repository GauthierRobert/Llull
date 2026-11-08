/** 14 FLL-M1 on the command side: set_mesh_controls source implicit_field, the mesh request of a field-meshed case, job targets and assembly. */

import { describe, expect, it } from 'vitest';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { meshRequest, type MeshRequest } from '@cae/hash/meshRequest';
import { assembleFieldMesh, fieldJobTargets, fieldMeshQualityProblem, type FieldPartMesh } from '@cae/fieldMesh/fieldMesh';
import { analysisErrors } from '@cae/model/validate';
import { toStudyLevel } from '@cae/vnv/studySchemas';
import { staleReasons, type CaseStudy } from '@cae/vnv/studyState';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { caseIn, run } from './helpers';
import { implicitAnalysis } from './fieldMeshFixtures';

function withCase(doc: CadDocument, analysisCase: AnalysisCase): CadDocument {
  const analysis = doc.analysis ?? { cases: {}, caseOrder: [] };
  return { ...doc, analysis: { ...analysis, cases: { ...analysis.cases, [analysisCase.id]: analysisCase } } };
}

function requestOf(doc: CadDocument, analysisId: string): MeshRequest {
  const request = meshRequest(doc, analysisId);
  if ('code' in request) throw new Error(`${request.code}: ${request.message}`);
  return request;
}

describe('set_mesh_controls source', () => {
  it('stores implicit_field, says so, and source geometry removes it', () => {
    const { doc, analysisId } = implicitAnalysis();
    const mesh = caseIn(doc, analysisId).mesh;
    expect(mesh.source).toBe('implicit_field');
    expect(mesh.globalSize).toBe(2);
    const back = run(doc, 'set_mesh_controls', { analysisId, source: 'geometry' });
    expect(back.affected).toEqual([analysisId]);
    expect(caseIn(back.document, analysisId).mesh.source).toBeUndefined();
    expect('source' in caseIn(back.document, analysisId).mesh).toBe(false);
    const again = run(back.document, 'set_mesh_controls', { analysisId, source: 'implicit_field', order: 1 });
    expect(again.summary).toContain('meshed from the implicit field (llull-field)');
    expect(caseIn(again.document, analysisId).mesh).toMatchObject({ source: 'implicit_field', order: 1 });
    expectPure(doc, () => run(doc, 'set_mesh_controls', { analysisId, source: 'geometry' }));
  });

  it('refuses refinements and conformal bonding with implicit_field', () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const refined = run(doc, 'set_mesh_controls', {
      analysisId,
      refinements: [{ target: { entityId: bodyId, facesNear: [[0, 0, 10]] }, size: 1 }],
    });
    expectNoOp(refined, doc);
    expect(refined.error?.code).toBe('FLL_IMPLICIT_MESH_UNSUPPORTED');
    expect(refined.summary).toContain('uniform lattice');
    const bonded = run(doc, 'set_mesh_controls', { analysisId, bonding: 'conformal' });
    expect(bonded.error?.code).toBe('FLL_IMPLICIT_MESH_UNSUPPORTED');
    const geometry = run(doc, 'set_mesh_controls', { analysisId, source: 'geometry' }).document;
    const refinedGeometry = run(geometry, 'set_mesh_controls', {
      analysisId,
      refinements: [{ target: { entityId: bodyId, facesNear: [[0, 0, 10]] }, size: 1 }],
    });
    expect(refinedGeometry.rejected).not.toBe(true);
    const switched = run(refinedGeometry.document, 'set_mesh_controls', { analysisId, source: 'implicit_field' });
    expect(switched.error?.code).toBe('FLL_IMPLICIT_MESH_UNSUPPORTED');
  });

  it('is validated on load', () => {
    const { doc, analysisId } = implicitAnalysis();
    expect(analysisErrors(doc as unknown as Record<string, unknown>)).toEqual([]);
    const analysisCase = caseIn(doc, analysisId);
    const bad = withCase(doc, { ...analysisCase, mesh: { ...analysisCase.mesh, source: 'netgen' as unknown as 'implicit_field' } });
    expect(analysisErrors(bad as unknown as Record<string, unknown>).join(' ')).toContain("mesh.source must be 'implicit_field'");
  });
});

describe('mesh request of a field-meshed case', () => {
  it('estimates the elements from the body volume, not its box', () => {
    expect(requestOf(implicitAnalysis().doc, implicitAnalysis().analysisId).controls.source).toBe('implicit_field');
    const { doc, analysisId } = implicitAnalysis('sphere', { globalSize: 0.18 });
    // the stored triangles enclose about 4/3 pi 10^3: / 0.18^3 x 15 = 1.07e7 > 2e6
    expect(meshRequest(doc, analysisId)).toMatchObject({ code: 'FEA_MESH_TOO_LARGE', message: expect.stringContaining('about 1.07e+7') });
  });

  it('accepts what the bounding-box estimate refuses when the body fills little of its box', () => {
    const { doc, analysisId, fieldId } = implicitAnalysis('sphere', { globalSize: 0.2 });
    const shell = run(doc, 'shell_field', { field: fieldId, thickness: 0.5 });
    const body = run(shell.document, 'create_implicit_body', { field: shell.affected[0], voxel: 0.25 });
    expect(body.rejected, body.summary).not.toBe(true);
    const bodyId = body.affected[0] ?? '';
    const analysisCase = caseIn(body.document, analysisId);
    const shelled = withCase(body.document, {
      ...analysisCase,
      parts: { [bodyId]: { kind: 'solid' } },
      constraints: {},
      constraintOrder: [],
      loads: {},
      loadOrder: [],
    });
    expect(meshRequest(shelled, analysisId)).not.toHaveProperty('code');
    const geometry = withCase(shelled, { ...caseIn(shelled, analysisId), mesh: { ...analysisCase.mesh, source: undefined } as never });
    expect(meshRequest(geometry, analysisId)).toMatchObject({ code: 'FEA_MESH_TOO_LARGE' });
  });

  it('refuses refinements, conformal bonding and non-solid parts with implicit_field', () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const analysisCase = caseIn(doc, analysisId);
    const refined = withCase(doc, {
      ...analysisCase,
      mesh: { ...analysisCase.mesh, refinements: [{ target: { entityId: bodyId, facesNear: [[0, 0, 10]] }, size: 1 }] },
    });
    expect(meshRequest(refined, analysisId)).toMatchObject({ code: 'FLL_IMPLICIT_MESH_UNSUPPORTED' });
    const bonded = withCase(doc, { ...analysisCase, mesh: { ...analysisCase.mesh, bonding: 'conformal' } });
    expect(meshRequest(bonded, analysisId)).toMatchObject({ code: 'FLL_IMPLICIT_MESH_UNSUPPORTED' });
    const plane = withCase(doc, {
      ...analysisCase,
      parts: { [bodyId]: { kind: 'plane_stress', thickness: 1, sourceFacesNear: [[0, 0, 0]] } },
    });
    expect(meshRequest(plane, analysisId)).toMatchObject({ code: 'FLL_IMPLICIT_MESH_UNSUPPORTED' });
  });
});

describe('field job targets', () => {
  it('sends a part its own targets and every probe as a nearest-node query', () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const request = requestOf(doc, analysisId);
    const targets = fieldJobTargets(request, bodyId);
    expect(Array.isArray(targets)).toBe(true);
    const keys = (targets as Record<string, unknown>[]).map((t) => t['key']);
    expect(keys).toHaveLength(3);
    expect((targets as Record<string, unknown>[]).find((t) => t['global'] === true)).toMatchObject({ pointsNear: [[0, 0, 0]] });
    expect((targets as Record<string, unknown>[]).filter((t) => t['facesNear'] !== undefined)).toHaveLength(2);
    expect(fieldJobTargets(request, 'other')).toHaveLength(1);
  });

  it('refuses a plane intersection and a target on an entity that is not a part', () => {
    const { doc, analysisId, bodyId } = implicitAnalysis();
    const request = requestOf(doc, analysisId);
    const plane = { ...request, targets: [{ key: 'X', entityId: bodyId, intersectPlane: { point: [0, 0, 0], normal: [0, 0, 1] } }] };
    expect(fieldJobTargets(plane as unknown as MeshRequest, bodyId)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
    const foreign = { ...request, targets: [{ key: 'Y', entityId: 'ghost', facesNear: [[0, 0, 0]] }] };
    expect(fieldJobTargets(foreign as unknown as MeshRequest, bodyId)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
  });
});

/** One unit tetrahedron per part (order 1), its report with a face set, and a global nearest node at `distance`. */
function part(entityId: string, distance: number, quality: Record<string, number> = {}): FieldPartMesh {
  return {
    entityId,
    nodes: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    elements: Uint32Array.from([0, 1, 2, 3]),
    report: {
      nodes: 4,
      elements: 1,
      volume: 1 / 6,
      quality: { minDihedralDeg: 54.7, maxDihedralDeg: 90, folded: 0, nonManifold: 0, inverted: 0, degenerate: 0, open: 0, ...quality },
      sets: { [`F_${entityId}`]: { nodes: [0, 1, 2], faces: [[0, 1]], residual: 0.25 } },
      nearest: { P_probe: { node: 3, distance } },
      curvedMidNodes: 0,
      warpedVertices: 1,
      steinerVertices: 0,
      clippedCorners: 0,
    },
  };
}

function twoPartRequest(): MeshRequest {
  const { doc, analysisId } = implicitAnalysis('sphere', { order: 1 });
  const request = requestOf(doc, analysisId);
  return {
    ...request,
    entityIds: ['a', 'b'],
    targets: [
      { key: 'F_a', entityId: 'a', facesNear: [[0, 0, 0]] },
      { key: 'F_b', entityId: 'b', facesNear: [[0, 0, 0]] },
      { key: 'P_probe', entityId: null, pointsNear: [[0, 0, 0]] },
    ],
  };
}

describe('assembleFieldMesh', () => {
  it('numbers nodes and elements over the parts and keeps the nearest probe node', () => {
    const assembled = assembleFieldMesh(twoPartRequest(), [part('a', 0.5), part('b', 0.1)], 'test');
    if ('code' in assembled) throw new Error(assembled.message);
    const { artifact, figures } = assembled;
    expect(artifact.mesher).toBe('llull-field');
    expect(artifact.nodes.map((n) => n[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(artifact.blocks.map((b) => [b.type, b.entityId, b.elements])).toEqual([
      ['C3D4', 'a', [[1, 1, 2, 3, 4]]],
      ['C3D4', 'b', [[2, 5, 6, 7, 8]]],
    ]);
    expect(artifact.nodeSets).toEqual({ F_a: [1, 2, 3], F_b: [5, 6, 7], P_probe: [8] });
    expect(artifact.faceSets).toEqual({ F_a: [[1, 1]], F_b: [[2, 1]] });
    expect(artifact.targets).toEqual({ F_a: { residual: 0.25 }, F_b: { residual: 0.25 }, P_probe: { residual: 0.1 } });
    expect(figures.map((f) => [f.entityId, f.elements, f.minDihedralDeg])).toEqual([
      ['a', 1, 54.7],
      ['b', 1, 54.7],
    ]);
  });

  it('refuses a part below the dihedral bounds or with folded elements', () => {
    const request = twoPartRequest();
    const sliver = assembleFieldMesh(request, [part('a', 0.5, { minDihedralDeg: 4 }), part('b', 0.1)], 'test');
    expect(sliver).toMatchObject({ code: 'FLL_IMPLICIT_MESH_QUALITY' });
    expect((sliver as { message: string }).message).toContain('min dihedral 4.00 deg below 10.7832');
    expect(fieldMeshQualityProblem(part('a', 0, { maxDihedralDeg: 170 }), 2)?.message).toContain('above 164.817');
    expect(fieldMeshQualityProblem(part('a', 0, { folded: 2 }), 2)?.message).toContain('2 folded');
    expect(fieldMeshQualityProblem(part('a', 0, { inverted: 1 }), 2)?.message).toContain('1 folded / non-manifold / inverted');
    expect(fieldMeshQualityProblem(part('a', 0, { open: 4 }), 2)).toMatchObject({
      code: 'FLL_IMPLICIT_MESH_QUALITY',
      message: expect.stringContaining('4 open boundary face(s)'),
    });
    const clipped = { ...part('a', 0), report: { ...part('a', 0).report, clippedCorners: 3 } };
    expect(fieldMeshQualityProblem(clipped, 2)).toMatchObject({ code: 'FLL_IMPLICIT_MESH_CLIPPED' });
    expect(assembleFieldMesh(request, [clipped, part('b', 0.1)], 't')).toMatchObject({ code: 'FLL_IMPLICIT_MESH_CLIPPED' });
    expect(fieldMeshQualityProblem(part('a', 0), 2)).toBeNull();
  });

  it('refuses malformed outputs and unresolved targets', () => {
    const request = twoPartRequest();
    const bad = { ...part('a', 0.5), elements: Uint32Array.from([0, 1, 2, 9]) };
    expect(assembleFieldMesh(request, [bad, part('b', 0.1)], 't')).toMatchObject({ code: 'FEA_MESH_FAILED' });
    const empty = { ...part('a', 0.5), report: { ...part('a', 0.5).report, sets: { F_a: { nodes: [], faces: [], residual: 0 } } } };
    expect(assembleFieldMesh(request, [empty, part('b', 0.1)], 't')).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
    const noProbe = { ...part('a', 0.5), report: { ...part('a', 0.5).report, nearest: {} } };
    expect(assembleFieldMesh(request, [noProbe], 't')).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
    const onlyA = assembleFieldMesh(request, [part('a', 0.5)], 't');
    expect(onlyA).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', message: 'target F_b resolved to no mesh node' });
  });
});

describe('convergence studies of a field-meshed case', () => {
  it('keep the mesh source of a level and go stale when it changes', () => {
    const { doc, analysisId } = implicitAnalysis();
    const analysisCase = caseIn(doc, analysisId);
    const level = toStudyLevel(
      {
        controls: { ...analysisCase.mesh, refinements: [] },
        elements: 1000,
        h: 1,
        value: 1,
        meshHash: 'm',
        resultsHash: 'r',
        inputHash: 'i',
        solver: 'calculix',
        solverVersion: '2.21',
        mesher: 'llull-field',
        mesherVersion: '0.1.0',
      },
      0,
    );
    expect(level.controls.source).toBe('implicit_field');
    const study = { id: 'cs', analysisId, refinement: 'h', levels: [level] } as unknown as CaseStudy;
    const geometry = withCase(doc, { ...analysisCase, mesh: { ...analysisCase.mesh, source: undefined } as never });
    expect(staleReasons(geometry, caseIn(geometry, analysisId), study).join(' ')).toContain(
      'the study with tet order 2 from the implicit_field',
    );
  });
});
