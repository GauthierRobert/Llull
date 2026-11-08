/** add_flight_controller / define_flight_scenario (13 FLT M2): records, defaults, refusals, purity, delete cascade, load validation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { flightDocument } from '@dynamics/flight/document';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { airframe, G, quadDrone, rotorParams, step } from './flightFixture';

const withController = (): CadDocument => step(quadDrone(), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;

const withScenario = (): CadDocument =>
  step(withController(), 'define_flight_scenario', {
    body: 'frame',
    controller: 'fc',
    durationS: 4,
    id: 'hover',
    setpoints: [{ t: 0 }, { t: 1, position: [0, 0, 1], yawDeg: 10 }],
    wind: { steady: [1, 0, 0], gusts: [{ startS: 2, durationS: 1, peak: [0, 3, 0] }] },
    initialAngularVelocity: [0, 0, 0.1],
  }).doc;

/** The document plus a 10 mm box as rigid body `id` (fixed when asked). */
function secondBody(doc: CadDocument, id: string, fixed: boolean): CadDocument {
  const box = step(doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
  return step(box.doc, 'add_rigid_body', { entityIds: [box.id], id, massKg: 1, ...(fixed ? { fixed: true } : {}) }).doc;
}

describe('add_flight_controller', () => {
  it('stores a controller over every rotor of the body with its defaults listed', () => {
    const doc = quadDrone();
    const result = execute(doc, 'add_flight_controller', { body: 'frame', maxRpm: 7000 });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^controller-/);
    const controller = result.document.flight?.controllers?.[id];
    expect(controller?.rotorIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(controller?.rateHz).toBe(400);
    expect(controller?.motorTimeConstantS).toBe(0.03);
    expect(controller?.gains.rate.p).toEqual([20, 20, 10]);
    expect(controller?.mixer).toBeNull();
    expect(controller?.defaulted).toContain('gains.velocity.i');
    expect(controller?.defaulted).toHaveLength(15);
    expect(result.summary).toContain('4 rotors (r1, r2, r3, r4) at 400.0 Hz, geometric mixer of rank 4');
    expect(result.summary).toContain('max thrust 32.15 N');
    expect(result.document.order).toEqual(doc.order);
  });

  it('keeps given inputs out of `defaulted` and takes an explicit mixer and rotor subset order', () => {
    const mixer = [
      [0.25, -1.39, -1.39, 15.4],
      [0.25, 1.39, 1.39, 15.4],
      [0.25, 1.39, -1.39, -15.4],
      [0.25, -1.39, 1.39, -15.4],
    ];
    const result = execute(quadDrone(), 'add_flight_controller', {
      body: 'frame',
      rotors: ['r1', 'r2', 'r3', 'r4'],
      maxRpm: 7000,
      minRpm: 1000,
      rateHz: 500,
      motorTimeConstantS: 0,
      gains: { position: [1, 1, 1], velocity: { p: [1, 1, 1], i: [0, 0, 0], d: [0, 0, 0] }, attitude: [5, 5, 2], rate: { p: [15, 15, 8] } },
      limits: { maxTiltDeg: 20, maxHorizontalSpeedMps: 2, maxVerticalSpeedMps: 1, maxRateDegS: [100, 100, 50] },
      mixer,
      id: 'mine',
    });
    const controller = result.document.flight?.controllers?.['mine'];
    expect(controller?.mixer).toEqual(mixer);
    expect(controller?.defaulted).toEqual(['gains.rate.i', 'gains.rate.d']);
    expect(result.summary).toContain('explicit mixer');
  });

  it('refuses a bad body, rotor list, speed range, mixer size and taken id', () => {
    const doc = quadDrone();
    const fails = (params: Record<string, unknown>, text: string): void =>
      expectNoOp(execute(doc, 'add_flight_controller', { body: 'frame', maxRpm: 7000, ...params }), doc, text);
    fails({ body: 'ghost' }, 'not a rigid body');
    fails({ rotors: ['r1', 'r1', 'r2', 'r3'] }, 'listed twice');
    fails({ rotors: ['r1', 'ghost'] }, "'ghost' is not a rotor on body 'frame'");
    fails({ minRpm: 7000 }, 'minRpm 7000 must be below maxRpm 7000');
    fails({ mixer: [[1, 0, 0, 0]] }, 'mixer has 1 rows for 4 rotors');
    fails({ id: 'r1' }, "id 'r1' is already used");
    const bare = airframe(1, [0.01, 0.01, 0.01], [0, 0, -G]);
    expectNoOp(execute(bare, 'add_flight_controller', { body: 'frame', maxRpm: 7000 }), bare, 'has no rotor');
  });

  it('refuses FLT_MIXER_RANK for a layout that cannot command 4 axes or a rotor without static thrust', () => {
    let coaxial = airframe(1, [0.01, 0.01, 0.01], [0, 0, -G]);
    for (const [id, spin] of [
      ['a', 'ccw'],
      ['b', 'cw'],
    ] as const)
      coaxial = step(coaxial, 'add_rotor', rotorParams({ id, spin, thrustCoefficient: 0.1, powerCoefficient: 0.05 })).doc;
    const rank = execute(coaxial, 'add_flight_controller', { body: 'frame', maxRpm: 7000 });
    expectNoOp(rank, coaxial, 'commands 2 of the 4 axes');
    expect(rank.error?.code).toBe('FLT_MIXER_RANK');
    const dead = step(quadDrone(), 'add_rotor', rotorParams({ id: 'r5', thrustCoefficient: 0, powerCoefficient: 0 })).doc;
    expect(execute(dead, 'add_flight_controller', { body: 'frame', maxRpm: 7000 }).error).toMatchObject({
      code: 'FLT_MIXER_RANK',
      ids: ['r5'],
    });
    const zeroMixer = execute(quadDrone(), 'add_flight_controller', {
      body: 'frame',
      maxRpm: 7000,
      mixer: Array.from({ length: 4 }, () => [1, 0, 0, 0]),
    });
    expect(zeroMixer.error?.code).toBe('FLT_MIXER_RANK');
    expect(zeroMixer.summary).toContain('the mixer commands 1 of the 4 axes');
  });

  it('is pure', () => {
    const doc = withController();
    expectPure(doc, () => execute(doc, 'add_flight_controller', { body: 'frame', maxRpm: 6000, id: 'fc2' }));
  });
});

describe('define_flight_scenario', () => {
  it('stores set-points, initial twist and wind with the settle band defaulted', () => {
    const doc = withScenario();
    const scenario = doc.flight?.scenarios?.['hover'];
    expect(scenario).toEqual({
      id: 'hover',
      bodyId: 'frame',
      controllerId: 'fc',
      durationS: 4,
      setpoints: [
        { t: 0, position: [0, 0, 0], yawDeg: 0 },
        { t: 1, position: [0, 0, 1], yawDeg: 10 },
      ],
      initialVelocity: [0, 0, 0],
      initialAngularVelocity: [0, 0, 0.1],
      wind: { steady: [1, 0, 0], gusts: [{ startS: 2, durationS: 1, peak: [0, 3, 0] }] },
      settleBandM: 0.1,
      defaulted: ['settleBandM'],
    });
  });

  it('defaults to one hold for an open-loop flight and says set-points only score it', () => {
    const result = execute(quadDrone(), 'define_flight_scenario', { body: 'frame', durationS: 2, setpoints: [{ t: 0 }, { t: 1 }] });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^scenario-/);
    expect(result.document.flight?.scenarios?.[id]?.controllerId).toBeNull();
    expect(result.summary).toContain('open loop: set-points only score the tracking error');
    const hold = execute(quadDrone(), 'define_flight_scenario', { body: 'frame', durationS: 2, settleBandM: 0.2 });
    expect(hold.document.flight?.scenarios?.[hold.affected[0] ?? '']).toMatchObject({
      setpoints: [{ t: 0, position: [0, 0, 0], yawDeg: 0 }],
      defaulted: [],
    });
  });

  it('refuses bad bodies, controllers, set-point times, late gusts and taken ids', () => {
    const doc = withController();
    const fails = (params: Record<string, unknown>, text: string): void =>
      expectNoOp(execute(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', durationS: 5, ...params }), doc, text);
    fails({ body: 'ghost' }, 'not a rigid body');
    fails({ controller: 'ghost' }, "no flight controller 'ghost'");
    fails({ setpoints: [{ t: 1 }] }, 'first set-point must be at t = 0');
    fails({ setpoints: [{ t: 0 }, { t: 2 }, { t: 2 }] }, 'strictly increase');
    fails({ setpoints: [{ t: 0 }, { t: 5 }] }, 'not inside the 5 s run');
    fails({ wind: { gusts: [{ startS: 5, durationS: 1, peak: [1, 0, 0] }] } }, 'gust starting at 5 s');
    fails({ id: 'fc' }, "id 'fc' is already used");
    const second = secondBody(doc, 'other', false);
    expectNoOp(
      execute(second, 'define_flight_scenario', { body: 'other', controller: 'fc', durationS: 1 }),
      second,
      "controller 'fc' flies body 'frame', not 'other'",
    );
    const fixed = secondBody(second, 'ground', true);
    expectNoOp(execute(fixed, 'define_flight_scenario', { body: 'ground', durationS: 1 }), fixed, 'fixed to the ground');
  });

  it('is pure', () => {
    const doc = withScenario();
    expectPure(doc, () => execute(doc, 'define_flight_scenario', { body: 'frame', durationS: 1, id: 's2' }));
  });
});

describe('flight controller / scenario lifecycle', () => {
  it('delete_dynamics_item removes a scenario, a controller with its scenarios, and cascades from a rotor or the body', () => {
    const doc = withScenario();
    const scenario = execute(doc, 'delete_dynamics_item', { id: 'hover' });
    expect(scenario.document.flight?.scenarios).toEqual({});
    expect(scenario.document.flight?.controllers?.['fc']).toBeDefined();
    const controller = execute(doc, 'delete_dynamics_item', { id: 'fc' });
    expect(controller.document.flight?.controllers).toEqual({});
    expect(controller.document.flight?.scenarios).toEqual({});
    expect(controller.summary).toContain('and 1 dependent record(s)');
    const rotor = execute(doc, 'delete_dynamics_item', { id: 'r2' });
    expect(Object.keys(rotor.document.flight?.rotors ?? {})).toEqual(['r1', 'r3', 'r4']);
    expect(rotor.document.flight?.controllers).toEqual({});
    expect(rotor.summary).toContain('and 2 dependent record(s)');
    const body = execute(doc, 'delete_dynamics_item', { id: 'frame' });
    expect(body.document.flight).toEqual({ rotors: {}, bodyDrag: {}, controllers: {}, scenarios: {} });
  });

  it('inspect_dynamics lists them; save / load and history replay keep them', () => {
    const doc = withScenario();
    expect(execute(doc, 'inspect_dynamics', {}).summary).toContain('flight controller(s) fc, flight scenario(s) hover');
    expect(deserializeDocument(serializeDocument(doc)).flight).toEqual(doc.flight);
    expect(execute(doc, 'replay_history', {}).document.flight).toEqual(doc.flight);
  });

  it('load validation names bad controllers and scenarios', () => {
    const raw = (JSON.parse(serializeDocument(withScenario())) as { document: Record<string, unknown> }).document;
    expect(flightDocument.validate(raw)).toEqual([]);
    const flight = raw['flight'] as {
      controllers: Record<string, Record<string, unknown>>;
      scenarios: Record<string, Record<string, unknown>>;
    };
    const fc = flight.controllers['fc'] ?? {};
    const hover = flight.scenarios['hover'] ?? {};
    const bad = (patch: Record<string, unknown>): string[] => flightDocument.validate({ ...raw, flight: { ...flight, ...patch } });
    expect(bad({ controllers: { fc: { ...fc, rateHz: 0 } } })[0]).toMatch(/^flight\.controllers\.fc\.rateHz: /);
    expect(bad({ controllers: { fc: { ...fc, rotorIds: ['r1', 'ghost'] } } })).toEqual([
      "flight.controllers.fc.rotorIds: 'ghost' is not a rotor",
    ]);
    expect(bad({ controllers: { fc: { ...fc, rotorIds: ['r1', 'r1'] } } })).toEqual([
      'flight.controllers.fc.rotorIds: a rotor is listed twice',
    ]);
    expect(bad({ controllers: { fc: { ...fc, minRpm: 8000 } } })).toEqual(['flight.controllers.fc: minRpm must be below maxRpm']);
    expect(bad({ controllers: { fc: { ...fc, mixer: [[1, 0, 0, 0]] } } })).toEqual(['flight.controllers.fc.mixer: one row per rotor']);
    expect(bad({ controllers: { other: fc } })).toContain('flight.controllers.other.id must equal its key');
    expect(bad({ controllers: { r1: { ...fc, id: 'r1' } } })).toContain(
      "flight.controllers.r1: id 'r1' is also a dynamics record or a rotor",
    );
    expect(bad({ scenarios: { hover: { ...hover, controllerId: 'ghost' } } })).toEqual([
      "flight.scenarios.hover.controllerId: 'ghost' is not a flight controller",
    ]);
    expect(bad({ scenarios: { hover: { ...hover, setpoints: [{ t: 1, position: [0, 0, 0], yawDeg: 0 }] } } })).toEqual([
      'flight.scenarios.hover.setpoints: times must start at 0, strictly increase and stay below durationS',
    ]);
    expect(
      bad({ scenarios: { hover: { ...hover, wind: { steady: [0, 0, 0], gusts: [{ startS: 9, durationS: 1, peak: [1, 0, 0] }] } } } }),
    ).toEqual(['flight.scenarios.hover.wind.gusts: a gust starts after the run']);
    expect(bad({ scenarios: { fc: { ...hover, id: 'fc' } } })).toContain("flight.scenarios.fc: id 'fc' is also a flight controller");
    expect(bad({ scenarios: { other: hover } })).toContain('flight.scenarios.other.id must equal its key');
    const hostile = JSON.parse(
      `{"rotors": ${JSON.stringify((raw['flight'] as { rotors: unknown }).rotors)}, "bodyDrag": {}, "scenarios": {"__proto__": {}}}`,
    ) as unknown;
    expect(flightDocument.validate({ ...raw, flight: hostile })).toEqual(['flight.scenarios.__proto__: reserved key']);
  });

  it('refuses a scenario whose controller flies another body on load', () => {
    const doc = secondBody(withScenario(), 'other', false);
    const raw = (JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> }).document;
    const flight = raw['flight'] as { scenarios: Record<string, Record<string, unknown>> };
    const moved = { ...flight, scenarios: { hover: { ...flight.scenarios['hover'], bodyId: 'other' } } };
    expect(flightDocument.validate({ ...raw, flight: moved })).toEqual(['flight.scenarios.hover.controllerId: it flies another body']);
  });
});
