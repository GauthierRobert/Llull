/** 14 FLL-M2: set_free_body_support, export_flight_loads (explicit state), the inertial deck lines and the relief / stale checks. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { checkAnalysis } from '@cae/commands/check';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { X2_NODES, barDocument, barMesh, mustRun } from './deckFixtures';

/** The 2 x 1 x 1 mm steel bar: mass 1.57e-8 t (7.85e-9 t/mm^3 x 2 mm^3), centre of mass at the origin (the box is centred). */
const MASS_T = 2 * 7.85e-9;
const ACCEL_MM_S2 = 9810;

const FREE_POINTS = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 1, 0],
] as const;

const bar = barDocument({ supports: false });

function supported(): { doc: CadDocument; ids: string[] } {
  const result = execute(bar.doc, 'set_free_body_support', { analysisId: bar.analysisId, entityId: bar.boxId, points: FREE_POINTS });
  return { doc: result.document, ids: [...result.affected] };
}

const mountAtEnd = (force: readonly number[]): Record<string, unknown> => ({
  name: 'end mount',
  target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] },
  force,
});

/** Items of check_analysis with `code`. */
function itemsOf(doc: CadDocument, code: string): { code: string; severity: string; message: string; ids: string[] }[] {
  const result = execute(doc, 'check_analysis', { analysisId: bar.analysisId });
  const items = (result.data as { items: { code: string; severity: string; message: string; ids: string[] }[] }).items;
  return items.filter((entry) => entry.code === code);
}

/** The inertial export of a 1 g acceleration along x with a mount force `force` N on the end face. */
function exported(force: number, extra: Record<string, unknown> = {}): { doc: CadDocument; loadIds: string[] } {
  const result = execute(supported().doc, 'export_flight_loads', {
    analysisId: bar.analysisId,
    state: { linearAccel: [ACCEL_MM_S2 / 1000, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
    mounts: [mountAtEnd([force, 0, 0])],
    ...extra,
  });
  expect(result.rejected, result.summary).not.toBe(true);
  const instants = (result.data as { instants: { loadIds: string[] }[] }).instants;
  return { doc: result.document, loadIds: instants[0]?.loadIds ?? [] };
}

describe('set_free_body_support', () => {
  it('adds a 3-2-1 support: three freeBody displacement constraints holding 3 / 2 / 1 dofs, appended to the order', () => {
    const { doc, ids } = supported();
    expect(ids).toHaveLength(3);
    const constraints = ids.map((id) => doc.analysis?.cases[bar.analysisId]?.constraints[id]);
    expect(constraints.map((constraint) => constraint?.freeBody)).toEqual([true, true, true]);
    expect(constraints.map((constraint) => constraint?.kind)).toEqual(['displacement', 'displacement', 'displacement']);
    // points in the z = 0 plane, P1P2 along x, P3 off the x axis in y: P2 holds uy uz (no rotation about y, z), P3 holds uz (no rotation about x)
    expect(constraints.map((constraint) => Object.keys(constraint?.dofs ?? {}).sort())).toEqual([['ux', 'uy', 'uz'], ['uy', 'uz'], ['uz']]);
    expect(constraints.map((constraint) => Object.values(constraint?.dofs ?? {}).every((value) => value === 0))).toEqual([
      true,
      true,
      true,
    ]);
    expect(constraints[0]?.target.pointsNear).toEqual([[0, 0, 0]]);
    expect(doc.analysis?.cases[bar.analysisId]?.constraintOrder).toEqual(ids);
  });

  it('is pure and its summary names the constraint ids and dofs', () => {
    expectPure(bar.doc, () =>
      execute(bar.doc, 'set_free_body_support', { analysisId: bar.analysisId, entityId: bar.boxId, points: FREE_POINTS }),
    );
    const result = execute(bar.doc, 'set_free_body_support', { analysisId: bar.analysisId, entityId: bar.boxId, points: FREE_POINTS });
    for (const id of result.affected) expect(result.summary).toContain(id);
    expect(result.summary).toContain('ux uy uz');
  });

  it('picks the pattern from the geometry: points spread along z need uz held at two points only', () => {
    const along = execute(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [0, 0, 1],
        [2, 0, 0],
      ],
    });
    const dofs = along.affected.map((id) =>
      Object.keys(along.document.analysis?.cases[bar.analysisId]?.constraints[id]?.dofs ?? {}).sort(),
    );
    // P1P2 along z: P2 must hold ux uy (rotations about x and y), P3 along x holds uy (rotation about z)
    expect(dofs).toEqual([['ux', 'uy', 'uz'], ['ux', 'uy'], ['uy']]);
  });

  it.each([
    [
      'collinear points',
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    ],
    [
      'nearly collinear points',
      [
        [0, 0, 0],
        [2, 0, 0],
        [1, 0.002, 0],
      ],
    ],
  ])('refuses %s (FLL_SUPPORT_SINGULAR) and changes nothing', (_name, points) => {
    const result = execute(bar.doc, 'set_free_body_support', { analysisId: bar.analysisId, entityId: bar.boxId, points });
    expectNoOp(result, bar.doc, 'FLL_SUPPORT_SINGULAR');
    expect(result.error?.code).toBe('FLL_SUPPORT_SINGULAR');
  });

  it('refuses coincident points, other constraints, a non-static analysis, an unknown analysis and an entity outside the analysis', () => {
    const coincident = execute(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ],
    });
    expect(coincident.error?.code).toBe('FLL_SUPPORT_POINTS');
    const fixed = barDocument();
    expect(
      execute(fixed.doc, 'set_free_body_support', { analysisId: fixed.analysisId, entityId: fixed.boxId, points: FREE_POINTS }).error?.code,
    ).toBe('FLL_SUPPORT_CONFLICT');
    const modal = barDocument({ analysisType: 'modal', supports: false });
    expect(
      execute(modal.doc, 'set_free_body_support', { analysisId: modal.analysisId, entityId: modal.boxId, points: FREE_POINTS }).error?.code,
    ).toBe('FLL_ANALYSIS_TYPE');
    expect(execute(bar.doc, 'set_free_body_support', { analysisId: 'nope', entityId: bar.boxId, points: FREE_POINTS }).error?.code).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    const other = mustRun(bar.doc, 'add_box', { size: [1, 1, 1] });
    const otherId = other.order[other.order.length - 1] ?? '';
    expect(
      execute(other, 'set_free_body_support', { analysisId: bar.analysisId, entityId: otherId, points: FREE_POINTS }).error?.code,
    ).toBe('FEA_PART_NOT_IN_ANALYSIS');
  });
});

describe('export_flight_loads (explicit state)', () => {
  it('writes an inertial load (acceleration in analysis units, reference point at the centre of mass), the mount force and records the source', () => {
    const { doc, loadIds } = exported(MASS_T * ACCEL_MM_S2);
    const analysis = doc.analysis?.cases[bar.analysisId];
    expect(loadIds).toHaveLength(2);
    const [inertial, mount] = loadIds.map((id) => analysis?.loads[id]);
    expect(inertial?.kind).toBe('inertial');
    expect(inertial?.vector).toEqual([ACCEL_MM_S2, 0, 0]);
    expect(inertial?.angularVelocity).toEqual([0, 0, 0]);
    expect(inertial?.loadCase).toBe('FLT_state');
    expect(inertial?.referencePoint?.map((value) => Number(value.toFixed(9)))).toEqual([0, 0, 0]);
    expect(inertial?.flightSource).toEqual({ scenario: null, timeS: null, designHash: null });
    expect(mount?.kind).toBe('force');
    expect(mount?.vector?.[0]).toBeCloseTo(MASS_T * ACCEL_MM_S2, 15);
    expect(analysis?.loadOrder).toEqual(loadIds);
  });

  it('adds the gravity field of the state as a gravity load and a moment mount as a moment load', () => {
    const result = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0], gravity: [0, 0, -9.80665] },
      mounts: [{ name: 'end', target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] }, moment: [0, 5, 0] }],
      loadCase: 'hover',
    });
    const loads = result.affected.map((id) => result.document.analysis?.cases[bar.analysisId]?.loads[id]);
    expect(loads.map((load) => load?.kind)).toEqual(['inertial', 'gravity', 'moment']);
    expect(loads[1]?.vector?.[2]).toBeCloseTo(-9806.65, 9);
    expect(loads.every((load) => load?.loadCase === 'hover')).toBe(true);
  });

  it('is pure and re-exporting into the same load case replaces the earlier flight loads', () => {
    const base = supported().doc;
    const params = {
      analysisId: bar.analysisId,
      state: { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
      mounts: [mountAtEnd([1, 0, 0])],
    };
    expectPure(base, () => execute(base, 'export_flight_loads', params));
    const first = execute(base, 'export_flight_loads', params);
    const second = execute(first.document, 'export_flight_loads', { ...params, state: { ...params.state, linearAccel: [2, 0, 0] } });
    const analysis = second.document.analysis?.cases[bar.analysisId];
    expect(analysis?.loadOrder).toHaveLength(2);
    expect(analysis?.loadOrder).toEqual(second.affected);
    expect(analysis?.loads[second.affected[0] ?? '']?.vector).toEqual([2000, 0, 0]);
  });

  it.each([
    ['neither scenario nor state', { state: undefined }, 'FLL_SOURCE_AMBIGUOUS'],
    ['an unknown analysis', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
    ['an invalid load case name', { loadCase: 'bad name' }, 'FEA_LOAD_INVALID'],
    ['a mount without a force', { mounts: [{ name: 'm', target: { entityId: 'BOX', facesNear: [[1, 0, 0]] } }] }, 'FLL_MOUNT_INVALID'],
    [
      'a rotor mount without a run',
      { mounts: [{ name: 'm', rotorId: 'r1', direction: [0, 0, 1], target: { entityId: 'BOX', facesNear: [[1, 0, 0]] } }] },
      'FLL_MOUNT_INVALID',
    ],
    [
      'a moment on a single point',
      { mounts: [{ name: 'm', moment: [0, 1, 0], target: { entityId: 'BOX', pointsNear: [[1, 0, 0]] } }] },
      'FLL_MOUNT_INVALID',
    ],
    [
      'a mount on an unknown entity',
      { mounts: [{ name: 'm', force: [1, 0, 0], target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }] },
      'FEA_TARGET_UNRESOLVED',
    ],
  ])('refuses %s without touching the document', (_name, overrides, code) => {
    const base = supported().doc;
    const state = { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] };
    const params = JSON.parse(JSON.stringify({ analysisId: bar.analysisId, state, ...overrides }).replaceAll('BOX', bar.boxId));
    const result = execute(base, 'export_flight_loads', params);
    expectNoOp(result, base);
    expect(result.error?.code).toBe(code);
  });

  it('refuses a scenario when the dynamics plugin has no such scenario (the run refusal is carried) and a non-static analysis', () => {
    const base = supported().doc;
    const unknown = execute(base, 'export_flight_loads', { analysisId: bar.analysisId, scenario: 'ghost' });
    expectNoOp(unknown, base);
    expect(unknown.error?.code).toBe('FLL_RUN_FAILED');
    const modal = barDocument({ analysisType: 'modal', supports: false });
    expect(
      execute(modal.doc, 'export_flight_loads', {
        analysisId: modal.analysisId,
        state: { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
      }).error?.code,
    ).toBe('FLL_ANALYSIS_TYPE');
  });

  it('refuses a load case that already has hand-made loads, and update_fea_load refuses an inertial load', () => {
    const hand = mustRun(supported().doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'g',
      kind: 'gravity',
      vector: [0, 0, -1],
      loadCase: 'FLT_state',
    });
    const result = execute(hand, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
    });
    expectNoOp(result, hand, 'hand-made');
    const { doc, loadIds } = exported(1e-4);
    const update = execute(doc, 'update_fea_load', { analysisId: bar.analysisId, loadId: loadIds[0], name: 'x' });
    expectNoOp(update, doc, 'inertial flight load');
  });
});

describe('relief balance (FLL_RELIEF_RESIDUAL) and staleness', () => {
  it('a mount force equal to m a balances the load case: no residual item', () => {
    const { doc } = exported(MASS_T * ACCEL_MM_S2);
    expect(itemsOf(doc, 'FLL_RELIEF_RESIDUAL')).toEqual([]);
    expect(itemsOf(doc, 'FLL_RELIEF_UNASSESSED')).toEqual([]);
  });

  it('flags the case when the mount force is 0.1 % off (error naming the case, force residual and percentage); 1e-5 off passes', () => {
    const off = exported(MASS_T * ACCEL_MM_S2 * 1.001).doc;
    const flagged = itemsOf(off, 'FLL_RELIEF_RESIDUAL');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.severity).toBe('error');
    expect(flagged[0]?.message).toContain("'FLT_state'");
    expect(flagged[0]?.message).toMatch(/net force 1\.5\d*e-7/);
    expect(itemsOf(exported(MASS_T * ACCEL_MM_S2 * (1 + 1e-5)).doc, 'FLL_RELIEF_RESIDUAL')).toEqual([]);
  });

  it('flags unbalanced loads with no mount at all, and a mount off the centre of mass line gives a moment residual', () => {
    const none = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [ACCEL_MM_S2 / 1000, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
    });
    expect(itemsOf(none.document, 'FLL_RELIEF_RESIDUAL')).toHaveLength(1);
    // force balanced but applied 0.5 mm above the centre of mass line: a moment of F x 0.5 remains
    const skew = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [ACCEL_MM_S2 / 1000, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] },
      mounts: [{ name: 'skew', target: { entityId: bar.boxId, pointsNear: [[1, 0, 0.5]] }, force: [MASS_T * ACCEL_MM_S2, 0, 0] }],
    });
    const moment = itemsOf(skew.document, 'FLL_RELIEF_RESIDUAL');
    expect(moment).toHaveLength(1);
    expect(moment[0]?.message).toMatch(/moment 0.0000770/);
  });

  it('balances an angular acceleration about the centre of mass with a moment mount: I alpha, with the inertia of the box', () => {
    const inertiaX = (MASS_T / 12) * (1 + 1); // (b^2 + c^2) / 12 for 1 x 1 mm sides
    const alpha = 100;
    const balanced = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [alpha, 0, 0] },
      mounts: [{ name: 'torque', target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] }, moment: [inertiaX * alpha, 0, 0] }],
    });
    expect(itemsOf(balanced.document, 'FLL_RELIEF_RESIDUAL')).toEqual([]);
    const wrong = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [alpha, 0, 0] },
      mounts: [{ name: 'torque', target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] }, moment: [-inertiaX * alpha, 0, 0] }],
    });
    expect(itemsOf(wrong.document, 'FLL_RELIEF_RESIDUAL')).toHaveLength(1);
  });

  it('an inertial load in a non-static analysis is FLL_INERTIAL_UNSUPPORTED; a relief case without a material is not assessed', () => {
    const { doc } = exported(1);
    const base = doc.analysis?.cases[bar.analysisId];
    if (base === undefined) throw new Error('no case');
    const moved = {
      ...doc,
      analysis: { ...doc.analysis, cases: { ...doc.analysis?.cases, [bar.analysisId]: { ...base, type: 'modal' as const } } },
    } as CadDocument;
    expect(itemsOf(moved, 'FLL_INERTIAL_UNSUPPORTED')).toHaveLength(1);
    const noMaterial = barDocument({ supports: false, material: 'none' });
    const withSupport = mustRun(noMaterial.doc, 'set_free_body_support', {
      analysisId: noMaterial.analysisId,
      entityId: noMaterial.boxId,
      points: FREE_POINTS,
    });
    const checked = execute(withSupport, 'check_analysis', { analysisId: noMaterial.analysisId });
    const codes = (checked.data as { items: { code: string }[] }).items.map((entry) => entry.code);
    expect(codes).toContain('FLL_RELIEF_UNASSESSED');
  });

  it('check_analysis lists no flight item for an ordinary supported analysis', () => {
    const plain = barDocument();
    const codes = (execute(plain.doc, 'check_analysis', { analysisId: plain.analysisId }).data as { items: { code: string }[] }).items.map(
      (entry) => entry.code,
    );
    expect(codes.filter((code) => code.startsWith('FLL_'))).toEqual([]);
    expect(checkAnalysis.name).toBe('check_analysis');
  });
});

describe('inertial deck lines (CalculiX)', () => {
  const deckOf = (doc: CadDocument, loadIds: readonly string[]): string => {
    const analysis = doc.analysis?.cases[bar.analysisId];
    const sets: Record<string, readonly number[]> = {};
    (analysis?.constraintOrder ?? []).forEach((id, index) => (sets[`C_${id}`] = [[1], [2], [3]][index] ?? [1]));
    for (const id of loadIds) if (analysis?.loads[id]?.kind === 'force') sets[`L_${id}`] = X2_NODES;
    const mesh: FeMeshArtifact = barMesh(doc, bar.analysisId, bar.boxId, sets);
    const written = writeInp(doc, bar.analysisId, mesh);
    if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
    return written.text;
  };
  /** Data lines of the *DLOAD block (up to the next keyword). */
  const dload = (text: string): string[] => {
    const lines = text.slice(text.indexOf('*DLOAD')).split('\n').slice(1);
    const end = lines.findIndex((line) => line.startsWith('*'));
    return lines.slice(0, end < 0 ? undefined : end).filter((line) => line !== '');
  };

  it('a linear acceleration is the uniform GRAV body force -rho a: magnitude |a|, direction -a; the 3-2-1 supports are the *BOUNDARY lines', () => {
    const { doc, loadIds } = exported(MASS_T * ACCEL_MM_S2);
    const text = deckOf(doc, loadIds);
    expect(dload(text)[0]).toBe('EALL, GRAV, 9810, -1, 0, 0');
    const boundary = text.slice(text.indexOf('*BOUNDARY'), text.indexOf('*CLOAD')).split('\n').slice(1, 7);
    const names = (doc.analysis?.cases[bar.analysisId]?.constraintOrder ?? []).map((id) => `C_${id.replace(/[^A-Za-z0-9_]/g, '_')}`);
    const [n1, n2, n3] = names;
    expect(boundary.filter((line) => line !== '')).toEqual([
      `${n1}, 1, 1`,
      `${n1}, 2, 2`,
      `${n1}, 3, 3`,
      `${n2}, 2, 2`,
      `${n2}, 3, 3`,
      `${n3}, 3, 3`,
    ]);
    expect(text).toContain('*CLOAD, OP=NEW');
  });

  it('gravity and the inertial acceleration add into one GRAV line (field g - a)', () => {
    const result = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 4.905], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0], gravity: [0, 0, -9.81] },
    });
    // field = g - a = -9810 - 4905 = -14715 mm/s^2 along z
    expect(dload(deckOf(result.document, result.affected))).toEqual(['EALL, GRAV, 14715, 0, 0, -1']);
  });

  it('an angular velocity adds CENTRIF about O along omega (omega^2, point, unit axis) next to the uniform GRAV', () => {
    const result = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 20], angularAccel: [0, 0, 0] },
      referencePoint: [1, 0.5, 0.5],
    });
    expect(dload(deckOf(result.document, result.affected))).toEqual(['EALL, CENTRIF, 400, 1, 0.5, 0.5, 0, 0, 1']);
  });

  it('an angular acceleration is one GRAV line per element with -alpha x (centroid - O), written instead of the uniform line', () => {
    const result = execute(supported().doc, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 10] },
      referencePoint: [0, 0, 0],
    });
    const lines = dload(deckOf(result.document, result.affected));
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => /^\d+, GRAV, /.test(line))).toBe(true);
    // every centroid has x in {0.5, 1, 1.5}; field = -alpha z-hat x r = alpha (y, -x, 0): direction (y, -x, 0) / |.|, magnitude 10 |(x, y)|
    const first = lines[0]?.split(', ').map(Number) ?? [];
    const [magnitude, dx, dy, dz] = first.slice(2);
    expect(dz).toBeCloseTo(0, 12);
    expect(Math.hypot(dx ?? 0, dy ?? 0)).toBeCloseTo(1, 9);
    expect(magnitude ?? 0).toBeGreaterThan(0);
    expect((dx ?? 0) * (magnitude ?? 0)).toBeCloseTo(10 * 0.5, 0);
  });

  it('refuses two rotating inertial loads in one load case (CENTRIF takes one axis)', () => {
    const rotating = (axis: number[]): Record<string, unknown> => ({
      analysisId: bar.analysisId,
      state: { linearAccel: [0, 0, 0], angularVelocity: axis, angularAccel: [0, 0, 0] },
    });
    const first = execute(supported().doc, 'export_flight_loads', rotating([0, 0, 5]));
    const analysis = first.document.analysis?.cases[bar.analysisId];
    if (analysis === undefined) throw new Error('no case');
    const inertial = analysis.loads[first.affected[0] ?? ''];
    if (inertial === undefined) throw new Error('no load');
    const twin = { ...inertial, id: 'twin', angularVelocity: [5, 0, 0] as const };
    const doc = {
      ...first.document,
      analysis: {
        ...first.document.analysis,
        cases: {
          ...first.document.analysis?.cases,
          [bar.analysisId]: { ...analysis, loads: { ...analysis.loads, twin }, loadOrder: [...analysis.loadOrder, 'twin'] },
        },
      },
    } as CadDocument;
    const sets: Record<string, readonly number[]> = {};
    analysis.constraintOrder.forEach((id, index) => (sets[`C_${id}`] = [[1], [2], [3]][index] ?? [1]));
    const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
    expect('code' in written && written.code).toBe('FEA_LOAD_INVALID');
  });
});
