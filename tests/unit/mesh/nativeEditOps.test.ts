/**
 * The engine-side rules that the native `remesh`, `analyze`, `repair`, `fill_holes` and `sculpt` (DES-7c step 7, TECHNICAL_SPEC 13.12 to 13.14) share with the TypeScript
 * engine: the triangle limit of a remesh and of a sculpt refinement refuses alike in both, and a native report is checked field by field before a command uses it.
 */

import { describe, expect, it } from 'vitest';
import { analyzeIndexedMesh, isMeshAnalysis, type MeshAnalysis } from '@core/geometry/mesh/analysis';
import { isEngineFailure, type MeshOp } from '@core/geometry/mesh/engineTypes';
import { isFillReport, isPairSearchOf, isRepairReport, isSculptReport, isShrinkwrapReport } from '@core/geometry/mesh/reportChecks';
import { SCULPT_MAX_TRIANGLES, sculptMesh } from '@core/geometry/mesh/sculpt';
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

describe('the sculpt refinement triangle limit', () => {
  const sphere = icosphere(10, 2);
  const op: Extract<MeshOp, { op: 'sculpt' }> = {
    op: 'sculpt',
    brush: 'draw',
    stamps: [[0, 0, 10]],
    radius: 5,
    strength: 0.2,
    falloff: 'smooth',
    direction: 'area_normal',
    taubin: false,
    refineEdge: 0.05,
  };

  it('stops the splitting and refuses with MESH_SCULPT_RESULT_TOO_LARGE, naming the size reached and the limit', () => {
    const result = tsMeshEngine.run({ mesh: sphere }, { ...op, maxTriangles: 3000 });
    expect(result).toMatchObject({ code: 'MESH_SCULPT_RESULT_TOO_LARGE', message: expect.stringContaining('(limit 3000)') });
    const reached = Number(/passed (\d+) triangles/.exec((result as { message: string }).message)?.[1]);
    expect(reached).toBeGreaterThan(3000);
    expect(reached).toBeLessThan(40_000);
  });

  it('is part of the result of the library function; a refinement within the limit reports none, and the default is 4,000,000', () => {
    expect(sculptMesh(sphere, { ...op, maxTriangles: 3000 })).toEqual({ tooLarge: expect.any(Number) });
    expect(sculptMesh(sphere, { ...op, refineEdge: 1, maxTriangles: 3000 })).not.toHaveProperty('tooLarge');
    expect(SCULPT_MAX_TRIANGLES).toBe(4_000_000);
    expect(tsMeshEngine.run({ mesh: sphere }, { ...op, refineEdge: 1 })).not.toHaveProperty('code');
  });
});

describe('isSculptReport', () => {
  const sphere = icosphere(10, 3);
  const op: Extract<MeshOp, { op: 'sculpt' }> = {
    op: 'sculpt',
    brush: 'inflate',
    stamps: [
      [0, 0, 10],
      [2, 1, 9.7],
    ],
    radius: 3,
    strength: 0.3,
    falloff: 'smooth',
    direction: 'area_normal',
    taubin: false,
    symmetry: 'yz',
    refineEdge: 0.5,
  };
  const omit = (source: typeof op, ...keys: Array<'symmetry' | 'refineEdge'>): typeof op => {
    const copy = { ...source };
    for (const key of keys) delete copy[key];
    return copy;
  };
  const answer = tsMeshEngine.run({ mesh: sphere }, op);
  if (isEngineFailure(answer)) throw new Error('the oracle failed');
  type Json = Record<string, unknown>;
  const broken = (change: (copy: Json) => void = () => undefined): Json => {
    const copy = JSON.parse(JSON.stringify(answer.report)) as Json;
    change(copy);
    return copy;
  };

  it('accepts what the TypeScript engine reports, also after a round trip through JSON', () => {
    expect(answer.report).toMatchObject({ stampsApplied: 3 });
    expect((answer.report as { refinedEdges: number }).refinedEdges).toBeGreaterThan(0);
    expect(isSculptReport(broken(), op)).toBe(true);
    // no symmetry plane: the symmetry error is null and one stamp is one application
    const bare = omit(op, 'symmetry', 'refineEdge');
    const plain = tsMeshEngine.run({ mesh: sphere }, bare);
    expect(isSculptReport(JSON.parse(JSON.stringify((plain as { report: unknown }).report)), bare)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no moved count', broken((r) => delete r['movedVertices'])],
    ['a fractional moved count', broken((r) => (r['movedVertices'] = 1.5))],
    ['a negative moved count', broken((r) => (r['movedVertices'] = -1))],
    ['a maximum displacement that is null (a NaN through JSON)', broken((r) => (r['maxDisplacement'] = null))],
    ['a negative maximum displacement', broken((r) => (r['maxDisplacement'] = -0.1))],
    ['a volume that is a string', broken((r) => (r['displacedVolume'] = '1'))],
    ['a volume basis that is not one', broken((r) => (r['volumeBasis'] = 'mesh-difference'))],
    ['a symmetry error that is a string', broken((r) => (r['symmetryError'] = '0'))],
    ['a negative symmetry error', broken((r) => (r['symmetryError'] = -1))],
    ['a refined count that is fractional', broken((r) => (r['refinedEdges'] = 0.5))],
    ['no stamps applied', broken((r) => delete r['stampsApplied'])],
    ['fewer stamps applied than stamps', broken((r) => (r['stampsApplied'] = 1))],
    ['more than two applications per stamp', broken((r) => (r['stampsApplied'] = 5))],
  ])('refuses %s', (_name, value) => {
    expect(isSculptReport(value, op)).toBe(false);
  });

  it('takes the op: a symmetry error without a plane, applications beyond the stamps without one, and refined edges without refineEdge are refused', () => {
    const withoutPlane = omit(op, 'symmetry');
    expect(typeof (answer.report as { symmetryError: unknown }).symmetryError).toBe('number');
    expect(
      isSculptReport(
        broken((r) => (r['stampsApplied'] = 2)),
        withoutPlane,
      ),
    ).toBe(false);
    expect(
      isSculptReport(
        broken((r) => ((r['symmetryError'] = null), (r['stampsApplied'] = 2))),
        withoutPlane,
      ),
    ).toBe(true);
    expect(
      isSculptReport(
        broken((r) => ((r['symmetryError'] = null), (r['stampsApplied'] = 3))),
        withoutPlane,
      ),
    ).toBe(false);
    expect(isSculptReport(broken(), omit(op, 'refineEdge'))).toBe(false);
    expect(
      isSculptReport(
        broken((r) => (r['refinedEdges'] = 0)),
        omit(op, 'refineEdge'),
      ),
    ).toBe(true);
  });
});

describe('isPairSearchOf', () => {
  const two = {
    positions: [...icosphere(10, 2).positions, ...icosphere(10, 2).positions.map((v, i) => (i % 3 === 0 ? v + 7 : v))],
    indices: [...icosphere(10, 2).indices, ...icosphere(10, 2).indices.map((v) => v + icosphere(10, 2).positions.length / 3)],
  };
  const analysisFor = (selfIntersections: boolean, maxListed: number): MeshAnalysis => {
    const answer = tsMeshEngine.run({ mesh: two }, { op: 'analyze', weldTolerance: 0, selfIntersections, maxListed });
    if (isEngineFailure(answer) || answer.analysis === undefined) throw new Error('the oracle failed');
    return JSON.parse(JSON.stringify(answer.analysis)) as MeshAnalysis;
  };
  const asked = { selfIntersections: true, maxListed: 5 };

  it('accepts what the TypeScript engine reports for the op asked, with and without the search', () => {
    expect(analysisFor(true, 5).selfIntersectionPairs).toBeGreaterThan(5);
    expect(isPairSearchOf(analysisFor(true, 5), asked)).toBe(true);
    expect(isPairSearchOf(analysisFor(true, 0), { selfIntersections: true, maxListed: 0 })).toBe(true);
    expect(isPairSearchOf(analysisFor(false, 5), { selfIntersections: false, maxListed: 5 })).toBe(true);
  });

  it.each([
    ['pair fields although the search was not asked', analysisFor(true, 5), { selfIntersections: false, maxListed: 5 }],
    ['no count although the search was asked', analysisFor(false, 5), asked],
    ['a list longer than maxListed', analysisFor(true, 5), { selfIntersections: true, maxListed: 3 }],
    ['a list shorter than min(count, maxListed)', analysisFor(true, 5), { selfIntersections: true, maxListed: 9 }],
    ['a list longer than the count', { ...analysisFor(true, 5), selfIntersectionPairs: 2 }, asked],
    ['a count above the number of face pairs', { ...analysisFor(true, 5), faces: 3 }, asked],
    [
      'a pair whose faces are not ascending',
      { ...analysisFor(true, 5), selfIntersections: [[3, 3], ...analysisFor(true, 5).selfIntersections.slice(1)] },
      asked,
    ],
    ['pairs out of order', { ...analysisFor(true, 5), selfIntersections: [...analysisFor(true, 5).selfIntersections].reverse() }, asked],
    [
      'a pair naming a face the mesh does not have',
      { ...analysisFor(true, 5), selfIntersections: [[0, 1e9], ...analysisFor(true, 5).selfIntersections.slice(1)] },
      asked,
    ],
  ])('refuses %s', (_name, analysis, op) => {
    expect(isPairSearchOf(analysis as MeshAnalysis, op)).toBe(false);
  });
});

describe('isShrinkwrapReport', () => {
  const op = { mode: 'nearest', maxDistance: undefined as number | undefined };
  const good = { moved: 90, missed: 0, maxMove: 2, meanMove: 1.5, residual: 1e-15 };
  const wrapped = tsMeshEngine.run(
    { mesh: icosphere(12, 2) },
    { op: 'shrinkwrap', target: { mesh: icosphere(10, 3) }, mode: 'nearest', offset: 0, side: 'keep' },
  );

  it('accepts what the TypeScript engine reports, also after a round trip through JSON', () => {
    if (isEngineFailure(wrapped)) throw new Error('the oracle failed');
    expect(isShrinkwrapReport(JSON.parse(JSON.stringify(wrapped.report)), op, 162)).toBe(true);
    expect(isShrinkwrapReport(good, op, 90)).toBe(true);
  });

  it('refuses a report that cannot be the one of the op asked', () => {
    const refused: Array<[string, unknown, typeof op]> = [
      ['not a record', 'moved', op],
      ['a count that is not whole', { ...good, moved: 1.5 }, op],
      ['more moved and missed than vertices', { ...good, moved: 80, missed: 20 }, op],
      ['a non-finite measure', { ...good, residual: Number.NaN }, op],
      ['a negative measure', { ...good, maxMove: -1 }, op],
      ['a mean above the maximum', { ...good, meanMove: 3 }, op],
      ['vertices moved by a move of 0', { ...good, maxMove: 0, meanMove: 0 }, op],
      ['a move without a vertex moved', { ...good, moved: 0 }, op],
      ['a vertex missed by a nearest wrap without a reach', { ...good, moved: 80, missed: 10 }, op],
    ];
    for (const [label, report, asked] of refused) expect(isShrinkwrapReport(report, asked, 90), label).toBe(false);
    // with a reach (or by rays) a vertex may be missed
    expect(isShrinkwrapReport({ ...good, moved: 80, missed: 10 }, { mode: 'nearest', maxDistance: 1 }, 90)).toBe(true);
    expect(isShrinkwrapReport({ ...good, moved: 80, missed: 10 }, { mode: 'normal', maxDistance: undefined }, 90)).toBe(true);
  });
});

describe('the shrinkwrap triangle cap of the TypeScript engine', () => {
  it('refuses a target over the cap by name', () => {
    const big = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(3 * 200_001).fill(0) };
    const result = tsMeshEngine.run(
      { mesh: icosphere(10, 1) },
      { op: 'shrinkwrap', target: { mesh: big }, mode: 'nearest', offset: 0, side: 'keep' },
    );
    expect(result).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
  });
});
