/** add_rotor / set_body_drag (13 FLT M1): records, refusals, purity, delete cascade, load validation of the `flight` slice and undo-free replay. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { flightDocument } from '@dynamics/flight/document';
import { buildSimulationModel } from '@dynamics/sim/simulationModel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { airframe, G, rotorParams, step } from './flightFixture';

const frame = (): CadDocument => airframe(1, [0.01, 0.01, 0.01], [0, 0, -G]);

describe('add_rotor', () => {
  it('adds a static-coefficient rotor and reports its first-coefficient thrust, torque and power (VC-FLT-04 numbers)', () => {
    const doc = frame();
    const result = execute(
      doc,
      'add_rotor',
      rotorParams({ rpm: 6528, thrustCoefficient: 0.1299, powerCoefficient: 0.0531, hub: [10, 0, 0] }),
    );
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^rotor-/);
    expect(result.document.flight?.rotors[id]).toEqual({
      id,
      bodyId: 'frame',
      hub: [10, 0, 0],
      axis: [0, 0, 1],
      spin: 'ccw',
      rpm: 6528,
      diameter: 0.254,
      coefficients: { kind: 'static', thrustCoefficient: 0.1299, powerCoefficient: 0.0531, source: 'test input' },
      airDensity: 1.225,
      spinInertiaKgM2: 0,
    });
    expect(result.summary).toContain('thrust 7.840 N');
    expect(result.summary).toContain('power 88.57 W');
    expect(result.document.order).toEqual(doc.order);
  });

  it('stores a table with its grade (default C) and takes an explicit id', () => {
    const table = {
      points: [
        [0, 0.1, 0.05],
        [0.5, 0.05, 0.03],
      ],
      source: 'bench',
    };
    const params = { ...rotorParams({ table, id: 'r1', airDensity: 1.1, spinInertiaKgM2: 2e-5 }) };
    delete params['thrustCoefficient'];
    delete params['powerCoefficient'];
    delete params['source'];
    const result = execute(frame(), 'add_rotor', params);
    expect(result.affected).toEqual(['r1']);
    expect(result.document.flight?.rotors['r1']?.coefficients).toEqual({
      kind: 'table',
      points: table.points,
      source: 'bench',
      grade: 'C',
    });
    expect(result.summary).toContain('table of 2 points (grade C)');
  });

  it('refuses unknown, fixed and prototype-key bodies, a zero axis, both / neither / half coefficient forms, unsorted tables and taken ids', () => {
    const doc = frame();
    const fixedBox = step(doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
    const fixed = step(fixedBox.doc, 'add_rigid_body', { entityIds: [fixedBox.id], fixed: true, id: 'stand' }).doc;
    const table = {
      points: [
        [0, 0.1, 0.05],
        [0.5, 0.05, 0.03],
      ],
      source: 'bench',
    };
    const cases: [CadDocument, Record<string, unknown>, string][] = [
      [doc, rotorParams({ body: 'nope' }), "body 'nope' is not a rigid body"],
      [doc, rotorParams({ body: 'constructor' }), "body 'constructor' is not a rigid body"],
      [fixed, rotorParams({ body: 'stand' }), 'is fixed to the ground'],
      [doc, rotorParams({ axis: [0, 0, 0] }), 'axis must be non-zero'],
      [doc, rotorParams({ table }), 'not both'],
      [doc, { ...rotorParams({}), thrustCoefficient: undefined }, 'no default coefficients exist'],
      [doc, { ...rotorParams({}), thrustCoefficient: undefined, powerCoefficient: undefined }, 'no default coefficients exist'],
      [
        doc,
        {
          ...rotorParams({
            table: {
              ...table,
              points: [
                [0.5, 0.1, 0.05],
                [0.5, 0.05, 0.03],
              ],
            },
          }),
          thrustCoefficient: undefined,
          powerCoefficient: undefined,
        },
        'strictly increase',
      ],
      [doc, rotorParams({ id: 'frame' }), "id 'frame' is already used"],
    ];
    for (const [base, params, why] of cases) expectNoOp(execute(base, 'add_rotor', params), base, why);
    const once = step(doc, 'add_rotor', rotorParams({ id: 'r1' })).doc;
    expectNoOp(execute(once, 'add_rotor', rotorParams({ id: 'r1' })), once, "id 'r1' is already used");
  });

  it('FLT_TABLE_SOURCE_MISSING without a source (static pair or table)', () => {
    const doc = frame();
    const bare = execute(doc, 'add_rotor', { ...rotorParams({}), source: '  ' });
    expectNoOp(bare, doc, 'FLT_TABLE_SOURCE_MISSING');
    expect(bare.error?.code).toBe('FLT_TABLE_SOURCE_MISSING');
    const table = execute(doc, 'add_rotor', {
      ...rotorParams({
        table: {
          points: [
            [0, 0.1, 0.05],
            [0.5, 0.05, 0.03],
          ],
          source: '',
        },
      }),
      thrustCoefficient: undefined,
      powerCoefficient: undefined,
      source: undefined,
    });
    expect(table.error?.code).toBe('FLT_TABLE_SOURCE_MISSING');
  });

  it('is pure', () => {
    const doc = step(frame(), 'add_rotor', rotorParams({ id: 'r0' })).doc;
    expectPure(doc, () => execute(doc, 'add_rotor', rotorParams({ id: 'r1' })));
  });
});

describe('set_body_drag', () => {
  it('sets, replaces and removes the drag of a body', () => {
    const doc = frame();
    const set = execute(doc, 'set_body_drag', { body: 'frame', cdaM2: [0.01, 0.02, 0.05] });
    expect(set.affected).toEqual(['frame']);
    expect(set.document.flight?.bodyDrag['frame']).toEqual({ bodyId: 'frame', cdaM2: [0.01, 0.02, 0.05], airDensity: 1.225 });
    expect(set.summary).toContain('CdA [0.01000, 0.02000, 0.05000] m²');
    const replaced = execute(set.document, 'set_body_drag', { body: 'frame', cdaM2: [0.1, 0.1, 0.1], airDensity: 1 });
    expect(replaced.summary).toContain('replaced the previous drag');
    expect(replaced.document.flight?.bodyDrag['frame']?.airDensity).toBe(1);
    const removed = execute(replaced.document, 'set_body_drag', { body: 'frame', cdaM2: [0, 0, 0] });
    expect(removed.affected).toEqual(['frame']);
    expect(removed.document.flight?.bodyDrag).toEqual({});
  });

  it('refuses unknown or fixed bodies, negative areas and removing a drag that is not there', () => {
    const doc = frame();
    expectNoOp(execute(doc, 'set_body_drag', { body: 'nope', cdaM2: [1, 1, 1] }), doc, 'not a rigid body');
    expectNoOp(execute(doc, 'set_body_drag', { body: 'frame', cdaM2: [0, 0, 0] }), doc, 'has no drag to remove');
    expect(execute(doc, 'set_body_drag', { body: 'frame', cdaM2: [-1, 0, 0] }).summary).toContain('invalid params');
  });

  it('is pure', () => {
    const doc = execute(frame(), 'set_body_drag', { body: 'frame', cdaM2: [0.1, 0.1, 0.1] }).document;
    expectPure(doc, () => execute(doc, 'set_body_drag', { body: 'frame', cdaM2: [0, 0, 0] }));
  });
});

describe('flight slice lifecycle', () => {
  const withFlight = (): CadDocument => {
    const rotor = step(frame(), 'add_rotor', rotorParams({ id: 'r1' })).doc;
    return execute(rotor, 'set_body_drag', { body: 'frame', cdaM2: [0.1, 0.1, 0.1] }).document;
  };

  it('delete_dynamics_item removes a rotor by id, and a body takes its rotors and drag with it', () => {
    const doc = withFlight();
    const rotorGone = execute(doc, 'delete_dynamics_item', { id: 'r1' });
    expect(rotorGone.document.flight?.rotors).toEqual({});
    expect(rotorGone.document.flight?.bodyDrag['frame']).toBeDefined();
    expect(rotorGone.summary).toBe("delete_dynamics_item: removed 'r1'.");
    const bodyGone = execute(doc, 'delete_dynamics_item', { id: 'frame' });
    expect(bodyGone.document.flight).toEqual({ rotors: {}, bodyDrag: {} });
    expect(bodyGone.summary).toContain('and 2 dependent record(s)');
    expectNoOp(execute(doc, 'delete_dynamics_item', { id: 'r2' }), doc, "no dynamics record 'r2'");
  });

  it('saves and loads; history replay re-mints the same slice', () => {
    const doc = withFlight();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.flight).toEqual(doc.flight);
    const replayed = execute(doc, 'replay_history', {});
    expect(replayed.document).not.toBe(doc);
    expect(replayed.document.flight).toEqual(doc.flight);
  });

  it('load validation names the path of every bad value and dangling body', () => {
    const doc = withFlight();
    const raw = (JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> }).document;
    expect(flightDocument.validate(raw)).toEqual([]);
    const rotor = (raw['flight'] as { rotors: Record<string, Record<string, unknown>> }).rotors['r1'] ?? {};
    const bad = (patch: Record<string, unknown>, dynamics?: unknown): string[] =>
      flightDocument.validate({
        ...raw,
        ...(dynamics === undefined ? {} : { dynamics }),
        flight: { ...(raw['flight'] as object), ...patch },
      });
    expect(bad({ rotors: { r1: { ...rotor, rpm: -1 } } })).toEqual([expect.stringMatching(/^flight\.rotors\.r1\.rpm: /)]);
    expect(bad({ rotors: { r2: rotor } })).toEqual(['flight.rotors.r2.id must equal its key']);
    expect(bad({ rotors: { r1: { ...rotor, axis: [0, 0, 0] } } })).toEqual(['flight.rotors.r1.axis must be non-zero']);
    expect(bad({ rotors: { r1: { ...rotor, bodyId: 'ghost' } } })).toEqual([
      "flight.rotors.r1.bodyId: 'ghost' is not a rigid body of dynamics.bodies",
    ]);
    expect(
      bad({
        rotors: {
          r1: {
            ...rotor,
            coefficients: {
              kind: 'table',
              points: [
                [1, 0.1, 0.1],
                [0, 0.1, 0.1],
              ],
              source: 's',
              grade: 'A',
            },
          },
        },
      }),
    ).toEqual(['flight.rotors.r1.coefficients.points: J must strictly increase']);
    expect(bad({ bodyDrag: { other: { bodyId: 'frame', cdaM2: [1, 1, 1], airDensity: 1 } } })).toEqual([
      'flight.bodyDrag.other.bodyId must equal its key',
    ]);
    expect(bad({ bodyDrag: { frame: { bodyId: 'frame', cdaM2: [0, 0, 0], airDensity: 1 } } })).toEqual([
      'flight.bodyDrag.frame.cdaM2 must have a component > 0',
    ]);
    const fixedDynamics = {
      ...(raw['dynamics'] as object),
      bodies: { frame: { ...((raw['dynamics'] as { bodies: Record<string, object> }).bodies['frame'] ?? {}), fixed: true } },
    };
    expect(bad({}, fixedDynamics)).toEqual([
      "flight.rotors.r1.bodyId: 'frame' is fixed to the ground",
      "flight.bodyDrag.frame.bodyId: 'frame' is fixed to the ground",
    ]);
    expect(bad({ extra: 1 })[0]).toMatch(/^flight: /);
    expect(flightDocument.validate({ ...raw, flight: { rotors: { __proto__: rotor }, bodyDrag: {} } })).toEqual([]);
    expect(flightDocument.derivedEntityIds(doc).size).toBe(0);
    expect(flightDocument.restore(raw)).toBe(raw);
  });

  it('the simulation build refuses a rotor or drag whose body is missing or fixed, and adds no body state without flight records', () => {
    const doc = withFlight();
    const other = step(doc, 'add_box', { size: [10, 10, 10], position: [500, 0, 0] });
    const two = step(other.doc, 'add_rigid_body', { entityIds: [other.id], id: 'other' }).doc;
    const dynamics = two.dynamics!;
    const { frame: held, ...rest } = dynamics.bodies;
    const orphan = { ...two, dynamics: { ...dynamics, bodies: rest } } as CadDocument;
    expect(buildSimulationModel(orphan, 0.001)).toEqual({ error: "rotor 'r1' acts on 'frame', which is not a rigid body" });
    const welded = { ...two, dynamics: { ...dynamics, bodies: { ...rest, frame: { ...held, fixed: true } } } } as CadDocument;
    expect(buildSimulationModel(welded, 0.001)).toEqual({ error: "rotor 'r1' acts on 'frame', which is fixed to the ground" });
    const dragOnly = { ...welded, flight: { rotors: {}, bodyDrag: doc.flight?.bodyDrag ?? {} } } as CadDocument;
    expect(buildSimulationModel(dragOnly, 0.001)).toEqual({ error: "body drag of 'frame' acts on 'frame', which is fixed to the ground" });
    const built = buildSimulationModel(two, 0.001);
    expect('model' in built ? built.model.bodyStates : null).toEqual(['frame']);
    const bare = buildSimulationModel({ ...two, flight: { rotors: {}, bodyDrag: {} } } as CadDocument, 0.001);
    expect('model' in bare ? 'bodyStates' in bare.model || 'flight' in bare : null).toBe(false);
    expect(createEmptyDocument().flight).toBeUndefined();
  });
});
