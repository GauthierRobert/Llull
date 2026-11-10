/** 14 FLL-M2 pure parts: the series -> instants conversion, instant choice, the rigid-body balance branches, the 3-2-1 pattern and the design hash. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute, getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { flightDesignHash } from '@cae/flightLoads/designHash';
import { chooseInstants, flightInstants } from '@cae/flightLoads/flightInstants';
import { analysisErrors } from '@cae/model/validate';
import { buildDeckContext } from '@cae/decks/context';
import { inertialContribution, inertialDloadLines } from '@cae/decks/inertialBodyForce';
import { writeInp } from '@cae/decks/inpWriter';
import { reliefAssessment } from '@cae/flightLoads/rigidBalance';
import { bestSupportPattern } from '@cae/flightLoads/supportPattern';
import { expectNoOp } from '../../helpers/expectNoOp';
import { barDocument, barMesh, mustRun } from './deckFixtures';

const GRAVITY: [number, number, number] = [0, 0, -9.80665];

/** A 5-sample series 0.1 s apart: velocity ramps at 2 m/s^2 along world x, yaw `yawDeg`, body rate ramps at 10 deg/s^2 about z. */
function series(yawDeg = 0): Record<string, unknown> {
  const times = [0, 0.1, 0.2, 0.3, 0.4];
  return {
    times,
    velocityMps: times.map((t) => [2 * t, 0, 0]),
    attitudeDeg: times.map(() => [0, 0, yawDeg]),
    bodyRateDegS: times.map((t) => [0, 0, 100 * t]),
    rotors: { r1: { thrustN: times.map((t) => 5 + t) } },
  };
}

describe('flightInstants', () => {
  it('differences the recorded velocity and body rate, rotates into the body axes and reads the rotor thrust', () => {
    const instants = flightInstants(series(), GRAVITY);
    if (typeof instants === 'string') throw new Error(instants);
    expect(instants).toHaveLength(5);
    for (const instant of instants) {
      expect(instant.accelMps2[0]).toBeCloseTo(2, 12);
      expect(instant.angularAccel[2]).toBeCloseTo((10 * Math.PI) / 18, 12);
      expect(instant.gravityMps2).toEqual([0, 0, -9.80665]);
    }
    expect(instants[2]?.angularVelocity[2]).toBeCloseTo((20 * Math.PI) / 180, 12);
    expect(instants[3]?.thrustN['r1']).toBeCloseTo(5.3, 12);
    expect(instants[0]?.timeS).toBe(0);
  });

  it('expresses the world acceleration in the yawed body axes (yaw 90 deg: world x is body -y) and gravity follows the roll', () => {
    const yawed = flightInstants(series(90), GRAVITY);
    if (typeof yawed === 'string') throw new Error(yawed);
    expect(yawed[1]?.accelMps2[0]).toBeCloseTo(0, 12);
    expect(yawed[1]?.accelMps2[1]).toBeCloseTo(-2, 12);
    const rolled = flightInstants({ ...series(), attitudeDeg: [0, 1, 2, 3, 4].map(() => [90, 0, 0]) }, GRAVITY);
    if (typeof rolled === 'string') throw new Error(rolled);
    // roll 90 deg: body y points to world +z, so world gravity -z is body -y
    expect(rolled[0]?.gravityMps2[1]).toBeCloseTo(-9.80665, 12);
    expect(rolled[0]?.gravityMps2[2]).toBeCloseTo(0, 12);
    const pitched = flightInstants({ ...series(), attitudeDeg: [0, 1, 2, 3, 4].map(() => [0, 90, 0]) }, GRAVITY);
    if (typeof pitched === 'string') throw new Error(pitched);
    expect(pitched[0]?.gravityMps2[0]).toBeCloseTo(9.80665, 12);
  });

  it.each([
    ['no series', undefined, 'no series'],
    ['too few samples', { ...series(), times: [0, 1] }, 'fewer than 3'],
    ['a non-increasing time', { ...series(), times: [0, 0.1, 0.1, 0.3, 0.4] }, 'not increasing'],
    ['a short velocity list', { ...series(), velocityMps: [[0, 0, 0]] }, 'lacks velocity'],
    ['a non-finite attitude', { ...series(), attitudeDeg: [0, 1, 2, 3, 4].map(() => [0, 0, Number.NaN]) }, 'lacks velocity'],
  ])('refuses %s with a message', (_name, input, message) => {
    expect(flightInstants(input, GRAVITY)).toEqual(expect.stringContaining(message));
  });

  it('a run without rotor thrust still gives instants (thrust empty)', () => {
    const { rotors: _unused, ...bare } = series();
    const instants = flightInstants(bare, GRAVITY);
    if (typeof instants === 'string') throw new Error(instants);
    expect(instants[0]?.thrustN).toEqual({});
  });
});

describe('chooseInstants', () => {
  const instants = (() => {
    const made = flightInstants(
      {
        times: [0, 1, 2, 3, 4, 5],
        velocityMps: [0, 1, 2, 3, 4, 5].map((t) => [0, 0, t * t]),
        attitudeDeg: [0, 1, 2, 3, 4, 5].map(() => [0, 0, 0]),
        bodyRateDegS: [0, 1, 2, 3, 4, 5].map((t) => [0, 0, 10 * t * t]),
      },
      GRAVITY,
    );
    if (typeof made === 'string') throw new Error(made);
    return made;
  })();

  it('peak_load is the largest specific force, a time the nearest sample, envelope the three peaks without duplicates', () => {
    const peak = chooseInstants(instants, 'peak_load');
    expect(peak.map((pick) => pick.instant.index)).toEqual([5]);
    expect(chooseInstants(instants, 2.4)[0]?.instant.index).toBe(2);
    expect(chooseInstants(instants, 2.6)[0]?.instant.index).toBe(3);
    const envelope = chooseInstants(instants, 'envelope');
    // acceleration, rate and angular acceleration all peak at the last sample: one case
    expect(envelope).toHaveLength(1);
    expect(envelope[0]?.label).toBe('peak_f');
  });

  it('keeps distinct peaks as separate cases', () => {
    const mixed = flightInstants(
      {
        times: [0, 1, 2, 3, 4],
        velocityMps: [0, 1, 2, 3, 4].map((t) => [t < 2 ? 5 * t : 10, 0, 0]),
        attitudeDeg: [0, 1, 2, 3, 4].map(() => [0, 0, 0]),
        bodyRateDegS: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 90],
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
      [0, 0, 0],
    );
    if (typeof mixed === 'string') throw new Error(mixed);
    const labels = chooseInstants(mixed, 'envelope').map((pick) => `${pick.label}@${pick.instant.index}`);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels.map((label) => label.split('@')[1])).size).toBe(labels.length);
  });
});

describe('bestSupportPattern', () => {
  it('rejects coincident points and finds a full-rank pattern for spread points', () => {
    expect(
      bestSupportPattern([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).toBeNull();
    const pattern = bestSupportPattern([
      [0, 0, 0],
      [10, 0, 0],
      [0, 5, 3],
    ]);
    expect(pattern?.dofs.map((dofs) => dofs.length)).toEqual([3, 2, 1]);
    expect(pattern?.conditioning).toBeGreaterThan(0.05);
  });
});

describe('reliefAssessment', () => {
  const bar = barDocument({ supports: false });
  const supports = (doc: CadDocument): CadDocument =>
    mustRun(doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    });
  const withLoad = (doc: CadDocument, params: Record<string, unknown>): CadDocument =>
    mustRun(doc, 'add_fea_load', { analysisId: bar.analysisId, name: 'load', loadCase: 'LC1', ...params });
  const target = { entityId: bar.boxId, facesNear: [[1, 0, 0]] };
  const assess = (doc: CadDocument): ReturnType<typeof reliefAssessment> =>
    reliefAssessment(doc, doc.analysis?.cases[bar.analysisId] ?? ({} as never));

  it('is null without a free-body support', () => {
    expect(assess(withLoad(bar.doc, { kind: 'gravity', vector: [0, 0, -9810] }))).toBeNull();
  });

  it('names the loads it cannot assess (per-node force, pressure, force without points) instead of guessing, and skips their case', () => {
    const doc = withLoad(withLoad(supports(bar.doc), { kind: 'force', vector: [1, 0, 0], distribution: 'per_node', target }), {
      kind: 'pressure',
      magnitude: 1,
      target,
      loadCase: 'LC2',
    });
    const result = assess(doc);
    expect(result?.balances).toEqual([]);
    expect(result?.unassessed).toHaveLength(2);
    expect(result?.unassessed.join(' ')).toContain('per_node');
    expect(result?.unassessed.join(' ')).toContain('pressure');
    // a document edited by hand: a force whose target lost its points
    const forced = withLoad(supports(bar.doc), { kind: 'force', vector: [1, 0, 0], target });
    const analysis = forced.analysis?.cases[bar.analysisId];
    const id = analysis?.loadOrder[0] ?? '';
    const stripped = {
      ...forced,
      analysis: {
        ...forced.analysis,
        cases: {
          ...forced.analysis?.cases,
          [bar.analysisId]: { ...analysis, loads: { [id]: { ...analysis?.loads[id], target: { entityId: bar.boxId } } } },
        },
      },
    } as unknown as CadDocument;
    expect(assess(stripped)?.unassessed.join(' ')).toContain('no target points');
  });

  it('a part without mass is reported, not balanced', () => {
    const none = barDocument({ supports: false, material: 'none' });
    const doc = mustRun(none.doc, 'set_free_body_support', {
      analysisId: none.analysisId,
      entityId: none.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    });
    const result = reliefAssessment(doc, doc.analysis?.cases[none.analysisId] ?? ({} as never));
    expect(result?.balances).toEqual([]);
    expect(result?.unassessed[0]).toContain('no mass');
  });

  it('balances a rotation about a point off the centre of mass: the mount force is m w^2 s (centrifugal), and a wrong one is flagged', () => {
    const mass = 2 * 7.85e-9;
    const omega = 100;
    const state = (force: number): CadDocument => {
      const result = execute(supports(bar.doc), 'export_flight_loads', {
        analysisId: bar.analysisId,
        state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, omega], angularAccel: [0, 0, 0] },
        referencePoint: [10, 0, 0],
        mounts: [{ name: 'tie', target: { entityId: bar.boxId, pointsNear: [[0, 0, 0]] }, force: [force, 0, 0] }],
      });
      if (result.rejected === true) throw new Error(result.summary);
      return result.document;
    };
    // O = (10, 0, 0), centre of mass at the origin: s = (-10, 0, 0); the body force -m w x (w x s) = -m w^2 (10) in x, so the tie carries +m w^2 10
    expect(assess(state(mass * omega ** 2 * 10))?.balances[0]?.balanced).toBe(true);
    expect(assess(state(mass * omega ** 2 * 11))?.balances[0]?.balanced).toBe(false);
  });
});

describe('designHash and export edge cases', () => {
  const hashOf = (doc: CadDocument): string =>
    flightDesignHash(doc, doc.analysis?.cases[Object.keys(doc.analysis?.cases ?? {})[0] ?? ''] ?? ({ parts: {} } as never));
  it('is stable for the same document and sensitive to a body, not to an unrelated entity', () => {
    const bar = barDocument({ supports: false });
    expect(hashOf(bar.doc)).toBe(hashOf(bar.doc));
    const added = mustRun(bar.doc, 'add_box', { size: [1, 1, 1] });
    expect(hashOf(added)).toBe(hashOf(bar.doc));
    const body = mustRun(bar.doc, 'add_rigid_body', { entityIds: [bar.boxId], id: 'b', massKg: 1 });
    expect(hashOf(body)).not.toBe(hashOf(bar.doc));
    const heavier = mustRun(body, 'set_gravity', { gravity: [0, 0, -1] });
    expect(hashOf(heavier)).not.toBe(hashOf(body));
  });

  it('keeps the loads of other load cases when a case is re-exported, and refuses a direction without a rotor and a state without a reference point', () => {
    const bar = barDocument({ supports: false });
    const hand = mustRun(bar.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'g',
      kind: 'gravity',
      vector: [0, 0, -1],
      loadCase: 'other',
    });
    const state = { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] };
    const first = execute(hand, 'export_flight_loads', { analysisId: bar.analysisId, state });
    const second = execute(first.document, 'export_flight_loads', { analysisId: bar.analysisId, state });
    const loads = second.document.analysis?.cases[bar.analysisId];
    expect(loads?.loadOrder).toHaveLength(2);
    expect(loads?.loads[loads.loadOrder[0] ?? '']?.loadCase).toBe('other');
    const direction = execute(hand, 'export_flight_loads', {
      analysisId: bar.analysisId,
      state,
      mounts: [{ name: 'm', direction: [0, 0, 1], force: [1, 0, 0], target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] } }],
    });
    expectNoOp(direction, hand);
    expect(direction.error?.code).toBe('FLL_MOUNT_INVALID');
    const massless = barDocument({ supports: false, material: 'none' });
    const refused = execute(massless.doc, 'export_flight_loads', { analysisId: massless.analysisId, state });
    expectNoOp(refused, massless.doc);
    expect(refused.error?.code).toBe('FLL_STATE_INVALID');
  });
});

describe('review fixes', () => {
  const bar = barDocument({ supports: false });
  const state = { linearAccel: [1, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] };
  const exported = (): CadDocument => {
    const supported = mustRun(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    });
    return mustRun(supported, 'export_flight_loads', { analysisId: bar.analysisId, state });
  };

  it('the 3-2-1 pattern is refused just below a pivot of 0.05 and accepted just above (P3 off the P1P2 line)', () => {
    const at = (h: number): boolean =>
      bestSupportPattern([
        [0, 0, 0],
        [1, 0, 0],
        [0.5, h, 0],
      ]) !== null;
    let [low, high] = [0, 1];
    for (let i = 0; i < 50; i++) {
      const mid = (low + high) / 2;
      if (at(mid)) high = mid;
      else low = mid;
    }
    expect(high).toBeGreaterThan(0.01);
    expect(high).toBeLessThan(0.5);
    expect(at(high * 0.95)).toBe(false);
    expect(at(high * 1.05)).toBe(true);
  });

  it('FLL_RUN_STALE also sees a change of an analysed part (the design hash includes analysis.parts)', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    if (analysis === undefined) throw new Error('no case');
    const hash = flightDesignHash(doc, analysis);
    const entity = doc.entities[bar.boxId];
    if (entity === undefined) throw new Error('no entity');
    const edited = {
      ...doc,
      entities: { ...doc.entities, [bar.boxId]: { ...entity, name: 'changed', position: [5, 0, 0] } },
    } as CadDocument;
    expect(flightDesignHash(edited, analysis)).not.toBe(hash);
  });

  it('a second inertial load in one load case is refused by the deck and not assessed by the balance', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    const first = analysis?.loads[analysis.loadOrder[0] ?? ''];
    if (analysis === undefined || first === undefined) throw new Error('no load');
    const twin = { ...first, id: 'twin' };
    const two = {
      ...doc,
      analysis: {
        ...doc.analysis,
        cases: {
          ...doc.analysis?.cases,
          [bar.analysisId]: { ...analysis, loads: { ...analysis.loads, twin }, loadOrder: [...analysis.loadOrder, 'twin'] },
        },
      },
    } as CadDocument;
    expect(reliefAssessment(two, two.analysis?.cases[bar.analysisId] ?? ({} as never))?.unassessed.join(' ')).toContain(
      'more than one inertial load',
    );
    const sets = Object.fromEntries(analysis.constraintOrder.map((id, index) => [`C_${id}`, [[1], [2], [3]][index] ?? [1]]));
    const written = writeInp(two, bar.analysisId, barMesh(two, bar.analysisId, bar.boxId, sets));
    expect('code' in written && written.code).toBe('FEA_LOAD_INVALID');
    expect('message' in written && written.message).toContain('more than one inertial load');
  });

  it('validation rejects a malformed freeBody, flightSource and angular vector and accepts the recorded ones', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    if (analysis === undefined) throw new Error('no case');
    const constraintId = analysis.constraintOrder[0] ?? '';
    const loadId = analysis.loadOrder[0] ?? '';
    const errorsOf = (loadPatch: Record<string, unknown>, constraintPatch: Record<string, unknown> = {}): string =>
      analysisErrors({
        ...doc,
        analysis: {
          ...doc.analysis,
          cases: {
            ...doc.analysis?.cases,
            [bar.analysisId]: {
              ...analysis,
              loads: { ...analysis.loads, [loadId]: { ...analysis.loads[loadId], ...loadPatch } },
              constraints: { ...analysis.constraints, [constraintId]: { ...analysis.constraints[constraintId], ...constraintPatch } },
            },
          },
        },
      } as unknown as Record<string, unknown>).join(' ');
    expect(errorsOf({})).toBe('');
    expect(errorsOf({}, { freeBody: 'yes' })).toContain('freeBody must be true');
    expect(errorsOf({ flightSource: { scenario: 3, timeS: null, designHash: null } })).toContain('flightSource');
    expect(errorsOf({ flightSource: { scenario: 's', timeS: 'now', designHash: 'h' } })).toContain('flightSource');
    expect(errorsOf({ flightSource: 'x' })).toContain('flightSource');
    expect(errorsOf({ flightSource: { scenario: 's', timeS: 1.5, designHash: 'abc' } })).toBe('');
    expect(errorsOf({ angularVelocity: [0, 'x', 0] })).toContain('angularVelocity');
  });

  it('drops a numerically negligible angular acceleration / rotation (one uniform field, no per-element lines) and names it in the deck', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    const sets = Object.fromEntries((analysis?.constraintOrder ?? []).map((id, index) => [`C_${id}`, [[1], [2], [3]][index] ?? [1]]));
    const ctx = buildDeckContext(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
    if (ctx === null) throw new Error('no context');
    // a flown hover: |alpha| ~ 1e-8 rad/s^2 and |omega| ~ 4e-10 rad/s against a 17 541 mm/s^2 field over a 2 mm part
    const noise = {
      centrifugal: [{ omegaSquared: 1.6e-19, point: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number] }],
      angular: [{ alpha: [1e-8, -8e-9, 0] as [number, number, number], point: [0, 0, 0] as [number, number, number] }],
    };
    const lines = inertialDloadLines(ctx, [0, 0, -17541.75], noise);
    if ('code' in lines) throw new Error(lines.message);
    expect(lines.perElement).toBe(false);
    expect(lines.lines.filter((line) => !line.startsWith('**'))).toEqual([]);
    expect(lines.lines.join('\n')).toContain('negligible');
  });

  it('refuses a real angular-acceleration field on a mesh too large for CalculiX per-element body loads', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    const sets = Object.fromEntries((analysis?.constraintOrder ?? []).map((id, index) => [`C_${id}`, [[1], [2], [3]][index] ?? [1]]));
    const small = barMesh(doc, bar.analysisId, bar.boxId, sets);
    const block = small.blocks[0];
    if (block === undefined) throw new Error('no block');
    const many = Array.from({ length: 40_000 }, (_, index) => [
      index + 1,
      ...(block.elements[index % block.elements.length] ?? []).slice(1),
    ]);
    const ctx = buildDeckContext(doc, bar.analysisId, { ...small, blocks: [{ ...block, elements: many }] });
    if (ctx === null) throw new Error('no context');
    const refused = inertialDloadLines(ctx, [0, 0, -9806.65], { centrifugal: [], angular: [{ alpha: [0, 0, 50], point: [0, 0, 0] }] });
    expect('code' in refused && refused.code).toBe('FLL_INERTIAL_FIELD_TOO_LARGE');
  });

  it('with OP=MOD (nonlinear steps) an element whose angular field is zero still gets GRAV 0, and the centroids are cached', () => {
    const doc = exported();
    const analysis = doc.analysis?.cases[bar.analysisId];
    const sets = Object.fromEntries((analysis?.constraintOrder ?? []).map((id, index) => [`C_${id}`, [[1], [2], [3]][index] ?? [1]]));
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets);
    const ctx = buildDeckContext(doc, bar.analysisId, mesh);
    if (ctx === null) throw new Error('no context');
    // element 1 = nodes 1 2 4 8: centroid (1.5, 0.5, 0.25); O on the line through it along alpha = z
    const terms = {
      centrifugal: [],
      angular: [{ alpha: [0, 0, 5] as [number, number, number], point: [1.5, 0.5, 0] as [number, number, number] }],
    };
    const plain = inertialDloadLines(ctx, [0, 0, 0], terms);
    const kept = inertialDloadLines(ctx, [0, 0, 0], terms, true);
    if ('code' in plain || 'code' in kept) throw new Error('refused');
    expect(plain.lines.some((line) => line.startsWith('1, GRAV'))).toBe(false);
    expect(kept.lines).toContain('1, GRAV, 0, 0, 0, 1');
    expect(kept.lines).toHaveLength(plain.lines.length + 1);
    expect(inertialDloadLines(ctx, [0, 0, 0], terms, true)).toEqual(kept);
  });
});

describe('branch coverage of the pure parts', () => {
  const bar = barDocument({ supports: false });

  it('a run whose series has one sample is refused with FLL_RUN_FAILED (no NaN sampling rate reaches the loads)', () => {
    const fake = {
      run: (doc: CadDocument) => ({
        document: doc,
        summary: 'fake',
        affected: [],
        data: { series: { times: [0], velocityMps: [[0, 0, 0]], attitudeDeg: [[0, 0, 0]], bodyRateDegS: [[0, 0, 0]] } },
      }),
    };
    const ctx = { ...defaultContext(), registry: (name: string) => (name === 'run_flight' ? (fake as never) : getCommand(name)) };
    const result = execute(bar.doc, 'export_flight_loads', { analysisId: bar.analysisId, scenario: 'x', referencePoint: [0, 0, 0] }, ctx);
    expectNoOp(result, bar.doc);
    expect(result.error?.code).toBe('FLL_RUN_FAILED');
    expect(result.summary).toContain('fewer than 3');
    // no dynamics plugin registered
    const none = execute(
      bar.doc,
      'export_flight_loads',
      { analysisId: bar.analysisId, scenario: 'x', referencePoint: [0, 0, 0] },
      { ...defaultContext(), registry: () => undefined },
    );
    expect(none.error?.code).toBe('FLL_RUN_FAILED');
    expect(none.summary).toContain('not registered');
  });

  it.each([
    ['times not a list', { times: 'abc' }],
    ['a NaN time', { times: [0, 1, Number.NaN, 3, 4] }],
    ['a rotors table that is not a record', { rotors: 5 }],
    ['rotor thrust that is not numbers', { rotors: { r1: { thrustN: ['a', 'b', 'c', 'd', 'e'] } } }],
    ['a rotor that is not a record', { rotors: { r1: 3 } }],
  ])('hostile series: %s never throws', (_name, patch) => {
    const times = [0, 1, 2, 3, 4];
    const base = {
      times,
      velocityMps: times.map(() => [0, 0, 0]),
      attitudeDeg: times.map(() => [0, 0, 0]),
      bodyRateDegS: times.map(() => [0, 0, 0]),
    };
    const result = flightInstants({ ...base, ...patch }, GRAVITY);
    if (typeof result === 'string') expect(result.length).toBeGreaterThan(0);
    else expect(result.every((instant) => Object.keys(instant.thrustN).length === 0)).toBe(true);
  });

  it('supportPattern: an exactly collinear and a coincident set have no pattern; the best pattern of a generic set has distinct dofs per point', () => {
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ]),
    ).toBeNull();
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 0.01, 0],
      ]),
    ).toBeNull();
    const generic = bestSupportPattern([
      [0, 0, 0],
      [3, 1, 0.5],
      [1, 4, 2],
    ]);
    expect(generic?.dofs[0]).toEqual(['ux', 'uy', 'uz']);
    expect(new Set(generic?.dofs[1]).size).toBe(2);
    expect(generic?.dofs[2]).toHaveLength(1);
  });

  it('inertialContribution defaults (no reference point, no angular terms) and its centrifugal axis; elementCentroids skip missing nodes and quadratic mid nodes keep the centroid', () => {
    const doc = mustRun(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    });
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, {});
    const ctx = buildDeckContext(doc, bar.analysisId, mesh);
    if (ctx === null) throw new Error('no context');
    const base = { id: 'i', name: 'i', loadCase: 'LC1', category: 'limit' as const, kind: 'inertial' as const };
    const plain = inertialContribution(ctx, base, 2);
    expect(plain.field).toEqual([-0, -0, -0]);
    expect(plain.centrifugal).toBeUndefined();
    expect(plain.angular).toBeUndefined();
    const spin = inertialContribution(ctx, { ...base, vector: [1, 2, 3], angularVelocity: [0, 3, 4], referencePoint: [1, 1, 1] }, 1);
    expect(spin.field).toEqual([-1, -2, -3]);
    expect(spin.centrifugal).toEqual({ omegaSquared: 25, point: [1, 1, 1], axis: [0, 0.6, 0.8] });
    // an element naming a node the mesh lacks: the known corners give the centroid; one with no known node gets no line
    const holey = {
      ...mesh,
      blocks: [
        {
          type: 'C3D4' as const,
          entityId: bar.boxId,
          elements: [
            [1, 1, 2, 4, 99],
            [2, 98, 99, 97, 96],
          ],
        },
      ],
    };
    const holeyCtx = buildDeckContext(doc, bar.analysisId, holey);
    if (holeyCtx === null) throw new Error('no context');
    const lines = inertialDloadLines(holeyCtx, [0, 0, 0], { centrifugal: [], angular: [{ alpha: [0, 0, 1], point: [0, 0, 0] }] });
    if ('code' in lines) throw new Error('refused');
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0]).toMatch(/^1, GRAV, /);
  });

  it('the balance and the hash tolerate a part whose entity is gone (not a 3D solid: reported, not thrown)', () => {
    const supported = mustRun(bar.doc, 'set_free_body_support', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    });
    const { [bar.boxId]: _gone, ...rest } = supported.entities;
    const broken = { ...supported, entities: rest } as CadDocument;
    const analysis = broken.analysis?.cases[bar.analysisId];
    if (analysis === undefined) throw new Error('no case');
    expect(reliefAssessment(broken, analysis)?.unassessed[0]).toContain('not a 3D solid');
    expect(flightDesignHash(broken, analysis)).toMatch(/^[0-9a-f]{16}$/);
  });
});
