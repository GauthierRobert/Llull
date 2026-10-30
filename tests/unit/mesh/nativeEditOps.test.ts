/**
 * The engine-side rules that the native `remesh` and `analyze` (DES-7c step 7, TECHNICAL_SPEC 13.12) share with the TypeScript engine: the triangle limit of a
 * remesh refuses alike in both, and a native analysis is checked field by field before a command uses it.
 */

import { describe, expect, it } from 'vitest';
import { analyzeIndexedMesh, isMeshAnalysis } from '@core/geometry/mesh/analysis';
import { isEngineFailure, type MeshOp } from '@core/geometry/mesh/engineTypes';
import { isFillReport, isRepairReport } from '@core/geometry/mesh/reportChecks';
import { REMESH_MAX_TRIANGLES, remeshMesh } from '@core/geometry/mesh/remesh';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { icosphere } from '../../helpers/meshFixtures';

const remesh = (extra: Partial<Extract<MeshOp, { op: 'remesh' }>>): MeshOp => ({
  op: 'remesh',
  iterations: 3,
  featureAngleRad: Math.PI / 4,
  preserveBoundary: true,
  project: true,
  ...extra,
});

describe('the remesh triangle limit', () => {
  const sphere = icosphere(10, 2);

  it('stops the splitting and refuses with MESH_REMESH_RESULT_TOO_LARGE, naming the size reached and the limit', () => {
    const result = tsMeshEngine.run({ mesh: sphere }, remesh({ targetEdge: 0.3, maxTriangles: 3000 }));
    expect(isEngineFailure(result)).toBe(true);
    expect(result).toMatchObject({ code: 'MESH_REMESH_RESULT_TOO_LARGE', message: expect.stringContaining('limit 3000') });
    const reached = Number(/passed (\d+) triangles/.exec((result as { message: string }).message)?.[1]);
    expect(reached).toBeGreaterThan(3000);
    expect(reached).toBeLessThan(40_000);
  });

  it('is part of the result of the library function, and a remesh within the limit reports none', () => {
    const params = { iterations: 3, featureAngleRad: Math.PI / 4, preserveBoundary: true, project: true, targetEdge: 0.3 };
    expect(remeshMesh(sphere, { ...params, maxTriangles: 3000 })).toEqual({ tooLarge: expect.any(Number) });
    const refused = remeshMesh(sphere, { ...params, maxTriangles: 3000 }) as { tooLarge: number };
    expect(refused.tooLarge).toBeGreaterThan(3000);
    expect(remeshMesh(sphere, { ...params, targetEdge: 3 })).not.toHaveProperty('tooLarge');
    expect(REMESH_MAX_TRIANGLES).toBe(4_000_000);
  });
});

describe('isMeshAnalysis', () => {
  const sphere = icosphere(10, 1);
  const analysis = analyzeIndexedMesh(sphere.positions, sphere.indices, { selfIntersections: false, maxListed: 20 });
  const broken = (change: (copy: Record<string, unknown>) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(analysis)) as Record<string, unknown>;
    change(copy);
    return copy;
  };

  it('accepts what the TypeScript analysis gives, also after a round trip through JSON', () => {
    expect(isMeshAnalysis(analysis)).toBe(true);
    expect(isMeshAnalysis(JSON.parse(JSON.stringify(analysis)))).toBe(true);
    const open = analyzeIndexedMesh(sphere.positions, sphere.indices.slice(3), { selfIntersections: false, maxListed: 20 });
    expect(isMeshAnalysis(JSON.parse(JSON.stringify(open)))).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['a missing count', broken((a) => delete a['faces'])],
    ['a negative count', broken((a) => (a['edges'] = -1))],
    ['a fractional count', broken((a) => (a['shellCount'] = 1.5))],
    ['a null where a number is required', broken((a) => (a['area'] = null))],
    ['a string flag', broken((a) => (a['closed'] = 'yes'))],
    ['a volume that is not a number or null', broken((a) => (a['volume'] = 'big'))],
    ['a centroid of two numbers', broken((a) => (a['centroid'] = [0, 0]))],
    [
      'a shell without its area',
      broken((a) => (((a['shells'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['area'] = undefined)),
    ],
    ['a boundary loop that is not an object', broken((a) => (a['boundaryLoops'] = [1]))],
    ['a non-manifold edge without its uses', broken((a) => (a['nonManifoldEdges'] = [{ a: 0, b: 1 }]))],
    ['edge-length statistics missing', broken((a) => delete a['edgeLength'])],
    ['bounds without a max', broken((a) => (a['bounds'] = { min: [0, 0, 0] }))],
    ['a self-intersection list that is not a list', broken((a) => (a['selfIntersections'] = 0))],
    ['a self-intersection entry that is not a pair of face numbers', broken((a) => (a['selfIntersections'] = [[0, 1.5], [2]]))],
    ['a fractional genus', broken((a) => (a['genus'] = 0.5))],
    [
      'a fractional shell genus',
      broken((a) => (((a['shells'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['genus'] = 1.5)),
    ],
  ])('refuses %s', (_name, value) => {
    expect(isMeshAnalysis(value)).toBe(false);
  });
});

describe('isRepairReport and isFillReport', () => {
  const sphere = icosphere(10, 2);
  const open = { positions: sphere.positions, indices: sphere.indices.slice(18) };
  const repaired = tsMeshEngine.run(
    { mesh: open },
    { op: 'repair', mode: 'close_holes', weldTolerance: 1e-6, maxGap: 1e-4, maxBoundaryEdges: 100 },
  );
  const fillOp = { op: 'fill_holes', select: 'all', maxBoundaryEdges: 100, fairing: 'curvature', refine: true } as const;
  const filled = tsMeshEngine.run({ mesh: open }, fillOp);
  const skipped = tsMeshEngine.run({ mesh: open }, { ...fillOp, maxBoundaryEdges: 3 });
  if (isEngineFailure(repaired) || isEngineFailure(filled) || isEngineFailure(skipped)) throw new Error('the oracle failed');
  type Json = Record<string, unknown>;
  /** A copy of `report` after a round trip through JSON, damaged by `change`. */
  const broken = (report: unknown, change: (copy: Json) => void = () => undefined): Json => {
    const copy = JSON.parse(JSON.stringify(report)) as Json;
    change(copy);
    return copy;
  };
  const changes = (r: Json): Json => r['changes'] as Json;
  const hole = (r: Json, key: string): Json => (r[key] as Json[])[0] as Json;

  it('accept what the TypeScript engine reports, also after a round trip through JSON', () => {
    expect((repaired.report as { changes: { holesFilled: number } }).changes.holesFilled).toBeGreaterThan(0);
    expect(isRepairReport(broken(repaired.report), 'close_holes')).toBe(true);
    expect((filled.report as { filled: unknown[] }).filled.length).toBeGreaterThan(0);
    expect(isFillReport(broken(filled.report), 'curvature')).toBe(true);
    expect((skipped.report as { skipped: unknown[] }).skipped.length).toBeGreaterThan(0);
    expect(isFillReport(broken(skipped.report), 'curvature')).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a mode that is not one', broken(repaired.report, (r) => (r['mode'] = 'wrap'))],
    ['a mode that is not a string', broken(repaired.report, (r) => (r['mode'] = 3))],
    ['the report of another mode than the one asked', broken(repaired.report, (r) => (r['mode'] = 'weld'))],
    ['no changes', broken(repaired.report, (r) => delete r['changes'])],
    ['a change count missing', broken(repaired.report, (r) => delete changes(r)['stitched'])],
    ['a fractional change count', broken(repaired.report, (r) => (changes(r)['welded'] = 1.5))],
    ['a negative change count', broken(repaired.report, (r) => (changes(r)['flipped'] = -1))],
    ['notes that are not text', broken(repaired.report, (r) => (r['notes'] = [1]))],
    ['no notes', broken(repaired.report, (r) => delete r['notes'])],
    ['a skipped count that is null', broken(repaired.report, (r) => (r['skippedHoles'] = null))],
  ])('isRepairReport refuses %s', (_name, value) => {
    expect(isRepairReport(value, 'close_holes')).toBe(false);
  });

  it.each([
    ['null', null],
    ['no loop count', broken(filled.report, (r) => delete r['totalLoops'])],
    ['a negative loop count', broken(filled.report, (r) => (r['totalLoops'] = -1))],
    ['filled that is not a list', broken(filled.report, (r) => (r['filled'] = {}))],
    ['a filled hole that is not an object', broken(filled.report, (r) => (r['filled'] = [1]))],
    ['a filled hole without its triangles', broken(filled.report, (r) => delete hole(r, 'filled')['triangles'])],
    ['an area that is null (a NaN through JSON)', broken(filled.report, (r) => (hole(r, 'filled')['area'] = null))],
    ['a triangulation that is not one', broken(filled.report, (r) => (hole(r, 'filled')['triangulation'] = 'ear'))],
    ['a fairing that is not one', broken(filled.report, (r) => (hole(r, 'filled')['fairing'] = 'smooth'))],
    ['a fairing other than the one asked', broken(filled.report, (r) => (hole(r, 'filled')['fairing'] = 'tangent'))],
    ['a filled loop number past totalLoops', broken(filled.report, (r) => (hole(r, 'filled')['loop'] = r['totalLoops']))],
    ['a skipped loop number past totalLoops', broken(skipped.report, (r) => (hole(r, 'skipped')['loop'] = 1e9))],
    ['skipped that is not a list', broken(filled.report, (r) => (r['skipped'] = 0))],
    [
      'a skipped loop with a code that is not a hole refusal',
      broken(skipped.report, (r) => (hole(r, 'skipped')['code'] = 'MESH_NOT_A_MESH')),
    ],
    ['a skipped loop without its edges', broken(skipped.report, (r) => delete hole(r, 'skipped')['edges'])],
  ])('isFillReport refuses %s', (_name, value) => {
    expect(isFillReport(value, 'curvature')).toBe(false);
  });
});
