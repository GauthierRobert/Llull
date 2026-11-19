/** 14 FLL-M2b: the deck refuses inertial loads outside a static analysis, and the post-solve 3-2-1 reaction check on synthetic results. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { AnalysisCase, FeaLoad, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { writeInp } from '@cae/decks/inpWriter';
import { flightLoadItems } from '@cae/flightLoads/checkItems';
import { inertialUnsupported } from '@cae/flightLoads/inertialSupport';
import { solvedRelief, SOLVED_RELIEF_TOLERANCE } from '@cae/flightLoads/solvedReactions';
import { barDocument, barMesh } from './deckFixtures';

const MASS_T = 2 * 7.85e-9;
const ACCEL_MM_S2 = 9810;
const DENSITY_T_MM3 = 7.85e-9;
const bar = barDocument({ supports: false });

/** The bar under 1 g along x, balanced by an end mount (the pre-solve balance passes), on a 3-2-1 support. */
function balancedCase(mountForce = MASS_T * ACCEL_MM_S2): CadDocument {
  const supported = execute(bar.doc, 'set_free_body_support', {
    analysisId: bar.analysisId,
    entityId: bar.boxId,
    points: [
      [0, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
    ],
  }).document;
  const result = execute(supported, 'export_flight_loads', {
    analysisId: bar.analysisId,
    state: { linearAccel: [ACCEL_MM_S2 / 1000, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
    mounts: [{ name: 'end', target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] }, force: [mountForce, 0, 0] }],
  });
  expect(result.rejected, result.summary).not.toBe(true);
  return result.document;
}

const caseOf = (doc: CadDocument): AnalysisCase => {
  const analysis = doc.analysis?.cases[bar.analysisId];
  if (analysis === undefined) throw new Error('no case');
  return analysis;
};

/** Mesh with the supports on nodes 1, 2, 3 and the mount split equally over nodes 2, 4, 6, 8 (no face set: node 2 carries a quarter of it). */
function meshOf(doc: CadDocument): FeMeshArtifact {
  const analysis = caseOf(doc);
  const sets: Record<string, readonly number[]> = {};
  analysis.constraintOrder.forEach((id, index) => (sets[`C_${id}`] = [[1], [2], [3]][index] ?? [1]));
  for (const id of analysis.loadOrder) if (analysis.loads[id]?.kind === 'force') sets[`L_${id}`] = [2, 4, 6, 8];
  return barMesh(doc, bar.analysisId, bar.boxId, sets);
}

/** Body-force field of the case (sum of the gravity loads minus the inertial acceleration), mm/s^2. */
function fieldOf(analysis: AnalysisCase): Vec3 {
  const field = [0, 0, 0];
  for (const load of Object.values(analysis.loads)) {
    const sign = load.kind === 'gravity' ? 1 : load.kind === 'inertial' ? -1 : 0;
    load.vector?.forEach((component, axis) => (field[axis] = (field[axis] ?? 0) + sign * component));
  }
  return [field[0] ?? 0, field[1] ?? 0, field[2] ?? 0];
}

/**
 * RF CalculiX would print with the reactions `reactions` (per support, by order): the reaction plus the node's external load. By hand on the
 * 6-tet bar (each tet 1/3 mm^3, a C3D4 share V/4): node 1 is in all six tets (0.5 mm^3), nodes 2 and 3 in two each (1/6 mm^3); node 2 also
 * carries a quarter of the mount force.
 */
function resultsOf(
  doc: CadDocument,
  reactions: readonly Vec3[],
  extra: { readonly skipSet?: number; readonly steps?: number } = {},
): FeResultsArtifact {
  const analysis = caseOf(doc);
  const field = fieldOf(analysis);
  const mount = Object.values(analysis.loads).find((load) => load.kind === 'force')?.vector ?? [0, 0, 0];
  const share = [0.5, 1 / 6, 1 / 6];
  const tables = analysis.constraintOrder.flatMap((id, index) => {
    if (index === extra.skipSet) return [];
    const external = field.map(
      (component, axis) => DENSITY_T_MM3 * (share[index] ?? 0) * component + (index === 1 ? (mount[axis] ?? 0) / 4 : 0),
    );
    const reaction = reactions[index] ?? [0, 0, 0];
    return [
      {
        title: `total force (fx,fy,fz) for set ${`C_${id}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')} and time 0.1000000E+01`,
        time: 1,
        rows: [external.map((value, axis) => value + (reaction[axis] ?? 0))],
      },
    ];
  });
  return {
    kind: 'fe_results',
    meshHash: 'm',
    inputHash: 'i',
    solver: 'synthetic',
    solverVersion: '0',
    steps: Array.from({ length: extra.steps ?? 1 }, (_, index) => ({ step: index + 1, time: index + 1, fields: {} })),
    dat: { tables },
  };
}

const solvedItems = (doc: CadDocument, results: FeResultsArtifact): { code: string; severity: string; message: string }[] =>
  flightLoadItems(doc, caseOf(doc), undefined, { meshArtifact: meshOf(doc), resultsArtifact: results }).filter((entry) =>
    entry.code.startsWith('FLL_RELIEF_REACTION'),
  );

describe('deck refusal of inertial loads outside a static analysis (FLL_INERTIAL_UNSUPPORTED)', () => {
  it('a non-static analysis without an inertial load is not refused, a static one never is', () => {
    const doc = balancedCase();
    const base = caseOf(doc);
    const noInertial = { ...base, type: 'modal' as const, loadOrder: base.loadOrder.filter((id) => base.loads[id]?.kind !== 'inertial') };
    expect(inertialUnsupported(noInertial)).toBeNull();
    expect(inertialUnsupported({ ...base, loadOrder: [...base.loadOrder, 'gone'] })).toBeNull();
    expect(inertialUnsupported({ ...base, type: 'modal', loadOrder: [...base.loadOrder, 'gone'] })?.ids).toHaveLength(1);
  });

  const retyped = (type: AnalysisCase['type']): CadDocument => {
    const doc = balancedCase();
    const base = caseOf(doc);
    return { ...doc, analysis: { ...doc.analysis, cases: { ...doc.analysis?.cases, [bar.analysisId]: { ...base, type } } } } as CadDocument;
  };
  const inertialIds = (doc: CadDocument): string[] =>
    Object.values(caseOf(doc).loads)
      .filter((load) => load.kind === 'inertial')
      .map((load) => load.id);

  for (const type of ['modal', 'nonlinear_static', 'buckling'] as const)
    it(`a ${type} deck is refused with the check_analysis code and names the inertial load`, () => {
      const doc = retyped(type);
      const written = writeInp(doc, bar.analysisId, meshOf(doc));
      expect('code' in written && written.code).toBe('FLL_INERTIAL_UNSUPPORTED');
      expect('ids' in written && written.ids).toEqual(inertialIds(doc));
      expect('message' in written && written.message).toMatch(new RegExp(`in a ${type} analysis`));
      const check = execute(doc, 'check_analysis', { analysisId: bar.analysisId }).data as { items: { code: string; message: string }[] };
      const item = check.items.find((entry) => entry.code === 'FLL_INERTIAL_UNSUPPORTED');
      expect(item?.message).toBe('message' in written ? written.message : '');
    });

  it('the static deck of the same case is written, with the RF totals of the three supports printed', () => {
    const doc = balancedCase();
    const written = writeInp(doc, bar.analysisId, meshOf(doc));
    if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
    const prints = written.text.split('\n').filter((line) => line.includes('TOTALS=ONLY'));
    expect(prints).toEqual(
      caseOf(doc).constraintOrder.map((id) => `*NODE PRINT, NSET=C_${id.replace(/[^A-Za-z0-9_]/g, '_')}, TOTALS=ONLY`),
    );
    expect(written.text).toMatch(/TOTALS=ONLY\nRF\n/);
  });
});

describe('post-solve reaction check (FLL_RELIEF_REACTION)', () => {
  it('passes when the printed RF is only the external load of the support nodes (a body force share and a mount share at node 2)', () => {
    const doc = balancedCase();
    expect(solvedItems(doc, resultsOf(doc, []))).toEqual([]);
    const check = solvedRelief(
      doc,
      caseOf(doc),
      meshOf(doc),
      resultsOf(doc, []),
      new Map([['FLT_state', { appliedForce: 1, appliedMoment: 1 }]]),
      [0, 0, 0],
    );
    expect(check?.cases).toHaveLength(1);
    expect(check?.cases[0]?.reactionForce).toBeLessThan(1e-12);
    expect(check?.cases[0]?.balanced).toBe(true);
  });

  it('flags a held-dof reaction of 1 % of the applied force and states the share; 0.05 % passes (tolerance 1e-3)', () => {
    const doc = balancedCase();
    const applied = MASS_T * ACCEL_MM_S2;
    const flagged = solvedItems(
      doc,
      resultsOf(doc, [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0.01 * applied],
      ]),
    );
    expect(flagged.map((entry) => [entry.code, entry.severity])).toEqual([['FLL_RELIEF_REACTION', 'error']]);
    expect(flagged[0]?.message).toMatch(/net force 0\.00000154 \(1 % of the applied 0\.000154\)/);
    expect(solvedItems(doc, resultsOf(doc, [[0.0005 * applied, 0, 0]]))).toEqual([]);
    expect(SOLVED_RELIEF_TOLERANCE).toBe(1e-3);
  });

  it('a pair of opposite reactions (zero net force) is still flagged by its moment about the centre of mass', () => {
    const doc = balancedCase();
    const r = 0.05 * MASS_T * ACCEL_MM_S2;
    // P1 (node 1, at x 0) and P2 (node 2, at x 2) both hold uz: +r and -r is a couple of 2 r about y
    const flagged = solvedItems(
      doc,
      resultsOf(doc, [
        [0, 0, r],
        [0, 0, -r],
        [0, 0, 0],
      ]),
    );
    expect(flagged.map((entry) => entry.code)).toEqual(['FLL_RELIEF_REACTION']);
    const check = solvedRelief(
      doc,
      caseOf(doc),
      meshOf(doc),
      resultsOf(doc, [
        [0, 0, r],
        [0, 0, -r],
        [0, 0, 0],
      ]),
      new Map([['FLT_state', { appliedForce: 20 * r, appliedMoment: 0 }]]),
      [1, 0.5, 0.5],
    );
    expect(check?.cases[0]?.reactionForce).toBeLessThan(1e-18);
    // couple 2 r about y; gate 1e-3 x 20 r x spread sqrt(5)
    expect(check?.cases[0]?.reactionMoment).toBeCloseTo(2 * r, 15);
    expect(check?.cases[0]?.momentScale).toBeCloseTo(20 * r * Math.sqrt(5), 15);
    expect(check?.cases[0]?.balanced).toBe(false);
  });

  it('ignores RF on a free dof of a support (there RF is K u, the external load, not a reaction)', () => {
    const doc = balancedCase();
    // P3 holds uz only (P1P2 along x, P3 off it in y): an x or y RF there is not a reaction
    expect(Object.keys(caseOf(doc).constraints[caseOf(doc).constraintOrder[2] ?? '']?.dofs ?? {})).toEqual(['uz']);
    expect(
      solvedItems(
        doc,
        resultsOf(doc, [
          [0, 0, 0],
          [0, 0, 0],
          [1, 1, 0],
        ]),
      ),
    ).toEqual([]);
  });

  it('a real imbalance (mount at 60 % of m a) is flagged before the solve and after it', () => {
    const doc = balancedCase(0.6 * MASS_T * ACCEL_MM_S2);
    // the supports take the 40 % the mount does not carry: P1 holds ux
    const items = flightLoadItems(doc, caseOf(doc), undefined, {
      meshArtifact: meshOf(doc),
      resultsArtifact: resultsOf(doc, [[0.4 * MASS_T * ACCEL_MM_S2, 0, 0]]),
    });
    expect(items.map((entry) => entry.code)).toEqual(['FLL_RELIEF_RESIDUAL', 'FLL_RELIEF_REACTION']);
  });

  it('reports a support set without its RF table and a load case without a solved step as unread (warning), not as balanced', () => {
    const doc = balancedCase();
    const missing = solvedItems(doc, resultsOf(doc, [], { skipSet: 1 }));
    expect(missing.map((entry) => [entry.code, entry.severity])).toEqual([['FLL_RELIEF_REACTION_UNREAD', 'warning']]);
    expect(missing[0]?.message).toMatch(/no RF total of set C_.* at time 1 .*re-solve/);
    const noStep = solvedItems(doc, resultsOf(doc, [], { steps: 0 }));
    expect(noStep[0]?.message).toMatch(/the results have no step 1/);
  });

  it('is silent without solved artifacts or a free-body support, and outside a static analysis', () => {
    const doc = balancedCase();
    const analysis = caseOf(doc);
    expect(flightLoadItems(doc, analysis, undefined, { meshArtifact: null, resultsArtifact: resultsOf(doc, []) })).toEqual(
      flightLoadItems(doc, analysis),
    );
    expect(solvedRelief(doc, { ...analysis, type: 'modal' }, meshOf(doc), resultsOf(doc, []), new Map(), [0, 0, 0])).toBeNull();
    const unsupported = { ...analysis, constraints: {}, constraintOrder: [] };
    expect(solvedRelief(doc, unsupported, meshOf(doc), resultsOf(doc, []), new Map(), [0, 0, 0])).toBeNull();
  });

  it('subtracts the rotation part of the body force at the support nodes (alpha x r and omega^2 r_perp at each element centroid)', () => {
    const supported = execute(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    }).document;
    const omega = 30;
    const alpha = 400;
    const doc = execute(supported, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, omega], angularAccel: [0, 0, alpha] },
      referencePoint: [1, 0.5, 0.5],
    }).document;
    const mesh = meshOf(doc);
    const nodes = new Map(mesh.nodes.map((node): [number, Vec3] => [node[0], [node[1], node[2], node[3]]]));
    // independent of the code under test: field(c) = -alpha x (c - O) + omega^2 (c - O)_perp, axis z through O
    const field = (c: Vec3): Vec3 => {
      const r: Vec3 = [c[0] - 1, c[1] - 0.5, c[2] - 0.5];
      return [alpha * r[1] + omega * omega * r[0], -alpha * r[0] + omega * omega * r[1], 0];
    };
    const external = (node: number, withRotation: boolean): Vec3 => {
      const total = [0, 0, 0];
      for (const element of mesh.blocks[0]?.elements ?? []) {
        if (!element.slice(1).includes(node)) continue;
        const [a, b, c, d] = element.slice(1).map((id) => nodes.get(id) ?? [0, 0, 0]) as [Vec3, Vec3, Vec3, Vec3];
        const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const e3: Vec3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const volume =
          Math.abs(
            e1[0] * (e2[1] * e3[2] - e2[2] * e3[1]) - e1[1] * (e2[0] * e3[2] - e2[2] * e3[0]) + e1[2] * (e2[0] * e3[1] - e2[1] * e3[0]),
          ) / 6;
        const f = withRotation
          ? field([(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4])
          : [0, 0, 0];
        for (let k = 0; k < 3; k++) total[k] = (total[k] ?? 0) + (DENSITY_T_MM3 * volume * (f[k] ?? 0)) / 4;
      }
      return [total[0] ?? 0, total[1] ?? 0, total[2] ?? 0];
    };
    const results = (withRotation: boolean): FeResultsArtifact => ({
      ...resultsOf(doc, []),
      dat: {
        tables: caseOf(doc).constraintOrder.map((id, index) => ({
          title: `total force (fx,fy,fz) for set ${`C_${id}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')} and time 0.1000000E+01`,
          time: 1,
          rows: [external(index + 1, withRotation)],
        })),
      },
    });
    const scale = 1e-6;
    const applied = new Map([['FLT_state', { appliedForce: scale, appliedMoment: scale }]]);
    const exact = solvedRelief(doc, caseOf(doc), mesh, results(true), applied, [1, 0.5, 0.5]);
    expect(exact?.cases[0]?.reactionForce).toBeLessThan(1e-20);
    expect(exact?.cases[0]?.balanced).toBe(true);
    const missed = solvedRelief(doc, caseOf(doc), mesh, results(false), applied, [1, 0.5, 0.5]);
    expect(missed?.cases[0]?.reactionForce).toBeGreaterThan(1e-9);
  });

  it('skips a support without nodes in the mesh and a constraint that is not free-body; an empty RF table is unread; a case without an applied scale or an analysis not in the document gives nothing', () => {
    const doc = balancedCase();
    const analysis = caseOf(doc);
    const applied = new Map([['FLT_state', { appliedForce: 1, appliedMoment: 1 }]]);
    const mesh = meshOf(doc);
    const [first = '', second = ''] = analysis.constraintOrder;
    const { [`C_${first}`]: _dropped, ...rest } = mesh.nodeSets;
    const partial = solvedRelief(doc, analysis, { ...mesh, nodeSets: rest }, resultsOf(doc, []), applied, [0, 0, 0]);
    expect(partial?.cases[0]?.reactionForce).toBeLessThan(1e-15);
    const notFree = {
      ...analysis,
      constraints: { ...analysis.constraints, [second]: { ...analysis.constraints[second], freeBody: false } },
    } as AnalysisCase;
    expect(solvedRelief(doc, notFree, mesh, resultsOf(doc, []), applied, [0, 0, 0])?.cases).toHaveLength(1);
    const empty = resultsOf(doc, []);
    const blank: FeResultsArtifact = { ...empty, dat: { tables: (empty.dat?.tables ?? []).map((table) => ({ ...table, rows: [] })) } };
    expect(solvedRelief(doc, analysis, mesh, blank, applied, [0, 0, 0])?.unassessed[0]).toMatch(/no RF total/);
    expect(solvedRelief(doc, analysis, mesh, resultsOf(doc, []), new Map(), [0, 0, 0])).toEqual({ cases: [], unassessed: [] });
    expect(solvedRelief(doc, { ...analysis, id: 'other' }, mesh, resultsOf(doc, []), applied, [0, 0, 0])).toBeNull();
    const { [Object.keys(mesh.nodeSets).find((key) => key.startsWith('L_')) ?? '']: _mount, ...noMount } = mesh.nodeSets;
    expect(solvedRelief(doc, analysis, { ...mesh, nodeSets: noMount }, resultsOf(doc, []), applied, [0, 0, 0])?.unassessed[0]).toMatch(
      /has no nodes in the mesh/,
    );
  });

  it('names a pressure, a quadratic-free element type and a part without material instead of guessing their nodal share', () => {
    const doc = balancedCase();
    const analysis = caseOf(doc);
    const mesh = meshOf(doc);
    const applied = new Map([['FLT_state', { appliedForce: 1, appliedMoment: 1 }]]);
    const pressure: FeaLoad = {
      id: 'pz',
      name: 'p',
      kind: 'pressure',
      magnitude: 1,
      loadCase: 'FLT_state',
      category: 'limit',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    };
    const withPressure: AnalysisCase = {
      ...analysis,
      loads: { ...analysis.loads, pz: pressure },
      loadOrder: [...analysis.loadOrder, 'pz'],
    };
    const pressureMesh = { ...mesh, faceSets: { L_pz: [[1, 1]] as [number, number][] } };
    expect(solvedRelief(doc, withPressure, pressureMesh, resultsOf(doc, []), applied, [0, 0, 0])?.unassessed[0]).toMatch(/pressure/);
    const shellMesh: FeMeshArtifact = { ...mesh, blocks: mesh.blocks.map((block) => ({ ...block, type: 'S3' as const })) };
    expect(solvedRelief(doc, analysis, shellMesh, resultsOf(doc, []), applied, [0, 0, 0])?.unassessed[0]).toMatch(/element type S3/);
    const bare = {
      ...doc,
      entities: { ...doc.entities, [bar.boxId]: { ...doc.entities[bar.boxId], materialId: undefined } },
    } as CadDocument;
    expect(solvedRelief(bare, analysis, mesh, resultsOf(doc, []), applied, [0, 0, 0])?.unassessed[0]).toMatch(/has no material/);
  });
});
