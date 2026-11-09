/**
 * PHY-06 M4 pin-in-hole template (FR-CNT-11, VC-CNT-64): pin_in_hole sets the contact pair up, pin_bearing_report reads the bearing distribution.
 * Oracle (derived, committed): a rigid pin in a close-fit hole bears with p(theta) = p0 cos(theta) on |theta| < 90 deg; the resultant along the load is
 * P = p0 (d / 2) t integral of cos^2 over (-90, 90) deg = p0 d t pi / 4, so p0 = 4 P / (pi d t) and the nominal bearing stress is P / (d t).
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { pairTargetKey } from '@cae/hash/targets';
import { axisFrame, bearingOf, type WallNode } from '@cae/contact/pinBearingMath';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { caseOf } from '@cae/shared/access';
import { hashOf, portOf } from '../deckFixtures';
import { blocks, must, type Blocks } from './support';
import { frdBlock, frdSet } from './boltSupport';

const D_PIN = 0.4;
const D_HOLE = 0.6;
const P = 1000;
const COSINE_PEAK = (4 * P) / (Math.PI * D_PIN * 1);
/** The same oracle for a wall at the hole radius (the distribution is computed on the hole wall, whose diameter is the d of the derivation). */
const WALL_PEAK = (4 * P) / (Math.PI * D_HOLE * 1);

const holeParams = (b: Blocks, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  analysisId: b.analysisId,
  name: 'lug_pin',
  plateEntityId: b.lower,
  pinEntityId: b.upper,
  axisPoint: [0.5, 0.5, 0],
  axisDirection: [0, 0, 1],
  pinDiameter: D_PIN,
  holeDiameter: D_HOLE,
  ...extra,
});

describe('pin_in_hole', () => {
  it('adds the hole-wall / pin-wall pair at mid-thickness, names the defaults and returns the closed-form bearing', () => {
    const b = blocks();
    const before = structuredClone(b.doc);
    const result = execute(b.doc, 'pin_in_hole', holeParams(b, { pinLoad: P }));
    expect(result.error).toBeUndefined();
    expect(b.doc).toEqual(before);
    const pairId = result.affected[1] ?? '';
    expect(result.affected[0]).toBe(b.analysisId);
    expect(pairId).toMatch(/^cp-\d+\.1$/);
    const pair = caseOf(result.document, b.analysisId)?.contact?.pairs[pairId];
    expect(pair).toMatchObject({ name: 'lug_pin', behaviour: { kind: 'hard' } });
    expect(pair?.slave).toEqual({ entityId: b.lower, facesNear: [[0.5, 0.5 + D_HOLE / 2, 0.5]] });
    expect(pair?.master).toEqual({ entityId: b.upper, facesNear: [[0.5, 0.5 + D_PIN / 2, 0.5]] });
    expect(caseOf(result.document, b.analysisId)?.contact?.formulation).toBe('surface_to_surface');
    const data = result.data as { clearance: { radial: number }; thickness: number; bearing: { nominal: number; cosinePeak: number } };
    expect(data.clearance.radial).toBeCloseTo(0.1, 12);
    expect(data.thickness).toBeCloseTo(1, 12);
    expect(data.bearing.nominal).toBeCloseTo(P / (D_PIN * 1), 9);
    expect(data.bearing.cosinePeak).toBeCloseTo(COSINE_PEAK, 9);
    expect(result.summary).toContain('formulation surface_to_surface by default');
    expect(result.summary).toContain('frictionless by default');
    expect(result.summary).toContain('not approved');
    expect(execute(b.doc, 'pin_in_hole', holeParams(b, { pinLoad: P })).document).toEqual(result.document);
  });

  it('returns no bearing estimate without pinLoad, keeps the case formulation and passes behaviour and friction', () => {
    const b = blocks();
    const first = must(b.doc, 'add_contact_pair', {
      analysisId: b.analysisId,
      name: 'other',
      slave: { entityId: b.upper, facesNear: [[0.5, 0.5, 2]] },
      master: { entityId: b.lower, facesNear: [[0.5, 0.5, 0]] },
      formulation: 'mortar',
      behaviour: { kind: 'hard' },
    });
    const result = execute(first.doc, 'pin_in_hole', holeParams(b, { behaviour: { kind: 'linear', slope: 1e6 }, friction: { mu: 0.15 } }));
    expect(result.error).toBeUndefined();
    expect((result.data as { bearing: unknown }).bearing).toBeNull();
    const pair = Object.values(caseOf(result.document, b.analysisId)?.contact?.pairs ?? {}).find((entry) => entry.name === 'lug_pin');
    expect(pair).toMatchObject({ behaviour: { kind: 'linear', slope: 1e6 }, friction: { mu: 0.15 } });
    expect(result.summary).toContain('formulation mortar,');
    expect(result.summary).toContain('friction mu 0.15');
  });

  it.each([
    ['an interference (hole = pin)', { holeDiameter: D_PIN }, 'CNT_PIN_FIT_INVALID'],
    ['a hole smaller than the pin', { holeDiameter: 0.3 }, 'CNT_PIN_FIT_INVALID'],
    ['a negative pin diameter', { pinDiameter: -1 }, 'CNT_PIN_FIT_INVALID'],
    ['a zero axis', { axisDirection: [0, 0, 0] }, 'CNT_PIN_FIT_INVALID'],
    ['a zero pin load', { pinLoad: 0 }, 'CNT_PIN_FIT_INVALID'],
    ['an unknown plate', { plateEntityId: 'ghost' }, 'CNT_PIN_FIT_INVALID'],
    ['an unknown analysis', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
    ['a pin that is not a part of the case', { pinEntityId: 'ghost2' }, 'CNT_PIN_FIT_INVALID'],
  ])('refuses %s with %s and leaves the document unchanged', (_label, extra, code) => {
    const b = blocks();
    const result = execute(b.doc, 'pin_in_hole', holeParams(b, extra));
    expect(result.error?.code).toBe(code);
    expect(result.document).toEqual(b.doc);
    expect(result.affected).toEqual([]);
  });

  it('passes the refusal of add_contact_pair through (name taken)', () => {
    const b = blocks();
    const once = must(b.doc, 'pin_in_hole', holeParams(b));
    const again = execute(once.doc, 'pin_in_hole', holeParams(b));
    expect(again.error?.code).toBe('CNT_PAIR_NAME_TAKEN');
    expect(again.document).toEqual(once.doc);
  });
});

/** Wall nodes on a circle of radius `radius` every `stepDeg`, tributary `area`, pressure p0 cos(theta) on the loaded half (the cosine oracle). */
function cosineWall(radius: number, stepDeg: number, thickness: number, p0: number): WallNode[] {
  const count = 360 / stepDeg;
  return Array.from({ length: count }, (_, index) => {
    const theta = (index * stepDeg * Math.PI) / 180;
    const wrapped = theta > Math.PI ? theta - 2 * Math.PI : theta;
    return {
      node: index + 1,
      at: [radius * Math.cos(theta), radius * Math.sin(theta), 0] as const,
      area: (radius * 2 * Math.PI * thickness) / count,
      pressure: p0 * Math.max(0, Math.cos(wrapped)),
      stress: [0, 100, 0, 0, 0, 0],
    };
  });
}

describe('bearing distribution (pinBearingMath)', () => {
  const frame = axisFrame([0, 0, 0], [0, 0, 1], [1, 0, 0]);

  it('reproduces the cosine oracle: resultant along the load = P, none across, peak at 0 deg, half-angle 90 deg', () => {
    if (frame === null) throw new Error('no frame');
    const bearing = bearingOf(frame, cosineWall(D_HOLE / 2, 1, 1, WALL_PEAK));
    expect(bearing.resultant.along).toBeCloseTo(P, 6);
    expect(bearing.resultant.across).toBeCloseTo(0, 6);
    expect(bearing.peak).toMatchObject({ angleDeg: 0 });
    expect(bearing.peak?.pressure).toBeCloseTo(WALL_PEAK, 9);
    expect(bearing.halfAngleDeg).toBeCloseTo(90, 9);
    expect(bearing.rows[0]?.angleDeg).toBeCloseTo(-179, 9);
  });

  it('projects the stress on the hoop direction: sigma_yy = 100 gives 100 at 0 deg (hoop = y), 0 at 90 deg, cos^2 between', () => {
    if (frame === null) throw new Error('no frame');
    const rows = bearingOf(frame, cosineWall(0.3, 15, 1, 1)).rows;
    const at = (angle: number): number | null => rows.find((row) => Math.abs(row.angleDeg - angle) < 1e-9)?.hoopStress ?? null;
    expect(at(0)).toBeCloseTo(100, 9);
    expect(at(90)).toBeCloseTo(0, 9);
    expect(at(60)).toBeCloseTo(100 * Math.cos((60 * Math.PI) / 180) ** 2, 9);
  });

  it('a load direction of -x puts the same peak 180 deg from the reference; a direction parallel to the axis or a zero axis has no frame', () => {
    const flipped = axisFrame([0, 0, 0], [0, 0, 1], [-1, 0, 0]);
    if (flipped === null) throw new Error('no frame');
    expect(Math.abs(bearingOf(flipped, cosineWall(0.3, 10, 1, 1)).peak?.angleDeg ?? 0)).toBeCloseTo(180, 9);
    expect(axisFrame([0, 0, 0], [0, 0, 1], [0, 0, 5])).toBeNull();
    expect(axisFrame([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
  });

  it('skips a node on the axis and reports nothing for an open wall (no peak, no half-angle)', () => {
    if (frame === null) throw new Error('no frame');
    const open = bearingOf(frame, [
      { node: 1, at: [0, 0, 0], area: 1, pressure: 5, stress: null },
      { node: 2, at: [0.3, 0, 0], area: 1, pressure: 0, stress: null },
    ]);
    expect(open.rows).toHaveLength(1);
    expect(open.peak).toBeNull();
    expect(open.halfAngleDeg).toBeNull();
    expect(open.maxHoop).toBeNull();
  });
});

/** Ring mesh of the hole wall (72 segments, radius D_HOLE / 2, z 0..1) of `plate` and one tet for the pin; the wall triangles are face 1 of their tets. */
function ringMesh(b: Blocks, doc: CadDocument, pairId: string): FeMeshArtifact {
  const count = 72;
  const radius = D_HOLE / 2;
  const nodes: [number, number, number, number][] = [];
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < count; i++) {
      const theta = (2 * Math.PI * i) / count;
      nodes.push([1 + k * count + i, 0.5 + radius * Math.cos(theta), 0.5 + radius * Math.sin(theta), k]);
    }
  const apex = 2 * count + 1;
  nodes.push([apex, 0.5, 0.5, 0.5]);
  const bottom = (i: number): number => 1 + (i % count);
  const top = (i: number): number => 1 + count + (i % count);
  const plate: number[][] = [];
  const faces: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    plate.push([2 * i + 1, bottom(i), bottom(i + 1), top(i + 1), apex]);
    plate.push([2 * i + 2, bottom(i), top(i + 1), top(i), apex]);
    faces.push([2 * i + 1, 1], [2 * i + 2, 1]);
  }
  const pinBase = 2 * count + 2;
  nodes.push([pinBase, 5, 5, 5], [pinBase + 1, 6, 5, 5], [pinBase + 2, 5, 6, 5], [pinBase + 3, 5, 5, 6]);
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, b.analysisId, 'mesh'),
    nodes,
    blocks: [
      { type: 'C3D4', entityId: b.lower, elements: plate },
      { type: 'C3D4', entityId: b.upper, elements: [[2 * count + 1, pinBase, pinBase + 1, pinBase + 2, pinBase + 3]] },
    ],
    nodeSets: { [`C_${b.fixedId}`]: [1] },
    faceSets: { [`L_${b.loadId}`]: [[1, 1]], [`CP_${pairId}_S`]: faces },
    targets: {},
  };
}

describe('pin_bearing_report', () => {
  const count = 72;
  const solved = (
    pressureOf: (angleDeg: number) => number,
    withStress = true,
  ): { doc: CadDocument; ctx: ExecutionContext; b: Blocks; pairId: string } => {
    const b = blocks();
    const added = must(b.doc, 'pin_in_hole', holeParams(b));
    const pairId = added.affected[1] ?? '';
    const mesh = ringMesh(b, added.doc, pairId);
    const wall = Array.from({ length: 2 * count }, (_, index) => index + 1);
    const angleOf = (node: number): number => {
      const i = (node - 1) % count;
      const deg = (360 * i) / count;
      return deg > 180 ? deg - 360 : deg;
    };
    const contact = frdBlock(
      'CONTACT',
      ['COPEN', 'CSLIP1', 'CSLIP2', 'CPRESS', 'CSHEAR1', 'CSHEAR2'],
      Object.fromEntries(wall.map((node) => [node, [0, 0, 0, pressureOf(angleOf(node)), 0, 0]])),
    );
    const stress = frdBlock(
      'STRESS',
      ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
      Object.fromEntries(wall.map((node) => [node, [0, 100, 0, 0, 0, 0]])),
    );
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: hashOf(mesh),
      inputHash: analysisInputHash(added.doc, b.analysisId, 'full'),
      solver: 'CalculiX',
      solverVersion: '2.21',
      steps: parseFrd(frdSet(1, 1, withStress ? [contact, stress] : [contact])),
    };
    const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
    const meshed = must(added.doc, 'record_fe_mesh', { analysisId: b.analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
    const summary = resultsSummary(meshed.doc, b.analysisId, mesh, results, hashOf(results));
    return { doc: must(meshed.doc, 'record_fea_results', { analysisId: b.analysisId, summary }, ctx).doc, ctx, b, pairId };
  };
  const report = (s: ReturnType<typeof solved>, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(
      s.doc,
      'pin_bearing_report',
      {
        analysisId: s.b.analysisId,
        pair: s.pairId,
        axisPoint: [0.5, 0.5, 0],
        axisDirection: [0, 0, 1],
        loadDirection: [1, 0, 0],
        ...extra,
      },
      s.ctx,
    );

  it('reads the cosine bearing off the frd of the hole wall: resultant = the integral of p, peak at 0 deg, hoop stress from the STRESS field', () => {
    const s = solved((angle) => WALL_PEAK * Math.max(0, Math.cos((angle * Math.PI) / 180)));
    const before = structuredClone(s.doc);
    const result = report(s);
    expect(result.error).toBeUndefined();
    expect(s.doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const data = result.data as {
      peak: { pressure: number; angleDeg: number };
      halfAngleDeg: number;
      resultant: { along: number; across: number; normalForce: number };
      maxHoop: { stress: number };
      rows: { angleDeg: number }[];
      truncated: boolean;
      reviewRequired: boolean;
    };
    expect(data.peak.angleDeg).toBeCloseTo(0, 9);
    expect(data.peak.pressure).toBeCloseTo(WALL_PEAK, 2);
    expect(data.halfAngleDeg).toBeCloseTo(90, 9);
    // the chords of the 72-gon: along = P within the polygon error (< 0.5 %)
    expect(Math.abs(data.resultant.along / P - 1)).toBeLessThan(0.005);
    expect(Math.abs(data.resultant.across / P)).toBeLessThan(1e-9);
    expect(data.maxHoop.stress).toBeCloseTo(100, 9);
    expect(data.rows).toHaveLength(2 * count);
    expect(data.truncated).toBe(false);
    expect(data.reviewRequired).toBe(true);
    expect(result.summary).toContain('not approved');
  });

  it('an open pin (no pressure) reports no peak; no STRESS field gives no hoop stress; a load direction of -x puts the peak 180 deg from the reference', () => {
    const open = report(solved(() => 0));
    expect((open.data as { peak: unknown }).peak).toBeNull();
    expect(open.summary).toContain('none (open)');
    const bare = solved((angle) => Math.max(0, Math.cos((angle * Math.PI) / 180)), false);
    expect((report(bare).data as { maxHoop: unknown }).maxHoop).toBeNull();
    const back = report(
      solved((angle) => Math.max(0, -Math.cos((angle * Math.PI) / 180))),
      { loadDirection: [-1, 0, 0] },
    );
    expect(Math.abs((back.data as { peak: { angleDeg: number } }).peak.angleDeg)).toBeCloseTo(0, 9);
  });

  it.each([
    ['unknown pair', { pair: 'nope' }, 'CNT_PAIR_NOT_FOUND'],
    ['unknown step', { step: 'nope' }, 'NLS_STEP_NOT_FOUND'],
    ['a load direction parallel to the axis', { loadDirection: [0, 0, 1] }, 'CNT_INPUT_INVALID'],
    ['unknown analysis', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
  ])('refuses %s with %s', (_label, extra, code) => {
    expect(
      report(
        solved(() => 1),
        extra,
      ).error?.code,
    ).toBe(code);
  });

  it('refuses an analysis without results (FEA_RESULTS_MISSING) and a stale one', () => {
    const s = solved(() => 1);
    const unsolved = must(blocks().doc, 'create_analysis', { name: 'x', analysisType: 'nonlinear_static' });
    expect(
      execute(unsolved.doc, 'pin_bearing_report', {
        analysisId: unsolved.affected[0],
        pair: 'x',
        axisPoint: [0, 0, 0],
        axisDirection: [0, 0, 1],
        loadDirection: [1, 0, 0],
      }).error?.code,
    ).toBe('CNT_PAIR_NOT_FOUND');
    const changed = must(s.doc, 'set_nonlinear_controls', { analysisId: s.b.analysisId, nlgeom: true, outputIncrements: 'all' });
    expect(
      execute(
        changed.doc,
        'pin_bearing_report',
        { analysisId: s.b.analysisId, pair: s.pairId, axisPoint: [0.5, 0.5, 0], axisDirection: [0, 0, 1], loadDirection: [1, 0, 0] },
        s.ctx,
      ).error?.code,
    ).toBe('FEA_RESULTS_STALE');
  });
});
