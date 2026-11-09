/** 14 FLL-M2 pure parts: the series -> instants conversion, instant choice, the rigid-body balance branches, the 3-2-1 pattern and the design hash. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { flightDesignHash } from '@cae/flightLoads/designHash';
import { chooseInstants, flightInstants } from '@cae/flightLoads/flightInstants';
import { reliefAssessment } from '@cae/flightLoads/rigidBalance';
import { bestSupportPattern } from '@cae/flightLoads/supportPattern';
import { expectNoOp } from '../../helpers/expectNoOp';
import { barDocument, mustRun } from './deckFixtures';

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
  it('is stable for the same document and sensitive to a body, not to an unrelated entity', () => {
    const bar = barDocument({ supports: false });
    expect(flightDesignHash(bar.doc)).toBe(flightDesignHash(bar.doc));
    const added = mustRun(bar.doc, 'add_box', { size: [1, 1, 1] });
    expect(flightDesignHash(added)).toBe(flightDesignHash(bar.doc));
    const body = mustRun(bar.doc, 'add_rigid_body', { entityIds: [bar.boxId], id: 'b', massKg: 1 });
    expect(flightDesignHash(body)).not.toBe(flightDesignHash(bar.doc));
    const heavier = mustRun(body, 'set_gravity', { gravity: [0, 0, -1] });
    expect(flightDesignHash(heavier)).not.toBe(flightDesignHash(body));
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
