/** Flight loads on rigid bodies (13 FLT M1): body-fixed rotors and body drag, applied by simulate_motion from the body state. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { dynamicsIdTaken } from '@core/model/dynamics';
import { idOrNext, idTaken } from '@lib/explicitId';
import { flightOf, ISA_SEA_LEVEL_DENSITY, type Rotor, type RotorCoefficients } from '../flight/model';
import { dynamicsOf } from './bodies';

/** Why `bodyId` cannot carry a flight load (missing or fixed), or null. */
function bodyProblem(doc: CadDocument, bodyId: string): string | null {
  const bodies = dynamicsOf(doc).bodies;
  const body = Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : undefined;
  if (body === undefined) return `body '${bodyId}' is not a rigid body (add_rigid_body first)`;
  return body.fixed ? `body '${bodyId}' is fixed to the ground; a flight load needs a moving body` : null;
}

const format = (value: number): string => value.toPrecision(4);

const tableSchema = z
  .object({
    points: z
      .array(z.tuple([z.number(), z.number().min(0), z.number().min(0)]))
      .min(2)
      .describe('[[J, Ct, Cp], ...]: advance ratio J = V_axial / (n·D) strictly increasing (it may start below 0 for descent data).'),
    source: z.string().describe('Where the table comes from (report, data file, test); required, non-empty (FLT_TABLE_SOURCE_MISSING).'),
    grade: z
      .enum(['A', 'B', 'C'])
      .optional()
      .describe('Source grade: A measured / verified, B published curve, C reconstructed or unchecked. Default C.'),
  })
  .describe('Measured Ct(J), Cp(J): monotone cubic (PCHIP) between points, held at the end values outside them (then flagged).');

/**
 * @affects adds 1 rotor to doc.flight.rotors (affected: [rotorId])
 * @invariant body is a non-fixed rigid body; axis non-zero; exactly one of (static pair + source) or table; table J strictly increasing
 * @invariant the rotor acts only through simulate_motion (and the commands that run it): thrust along the body-fixed axis, J from the body state
 * @failure unknown / fixed body, zero axis, both or neither coefficient forms, half a static pair, unsorted table, taken id -> no-op;
 *          missing or empty source -> FLT_TABLE_SOURCE_MISSING
 */
export const addRotor = defineCommand({
  name: 'add_rotor',
  description:
    'Fix a rotor (propeller + motor of a drone, a VTOL lift fan) to a rigid body for free flight in simulate_motion (13 FLT). Unlike ' +
    'add_propeller (a fixed WORLD thrust direction on a spinning joint), the rotor is part of the body: its thrust axis and hub rotate with the ' +
    'body, so a tilted airframe thrusts sideways. Each step, from the body state: hub velocity v_hub = v + ω × r, axial inflow V = v_hub · axis, ' +
    'advance ratio J = V / (n·D) (n = rpm / 60 rev/s, D = diameter m); thrust T = Ct·ρ·n²·D⁴ along `axis` at `hub` (so an off-centre rotor ' +
    'also pitches / rolls the body); reaction torque Q = Cp·ρ·n²·D⁵ / (2π) on the body about -axis for spin "ccw" (+axis for "cw"), the yaw ' +
    'control of a multirotor; gyroscopic torque -ω × H with H = spinInertiaKgM2 · 2πn along ±axis (precession of a spinning rotor). The speed is ' +
    'held at `rpm` for the whole run (no controller yet). Coefficients: give `thrustCoefficient` + `powerCoefficient` + `source` (a static pair, ' +
    'valid at J = 0: a run reaching |J| > 0.05 warns FLT_OUTSIDE_VALIDATED_RANGE) OR `table` (measured [J, Ct, Cp] rows, e.g. UIUC propeller ' +
    'data; outside the table the end values are held and the run warns). No default coefficients exist: unknown props are refused ' +
    '(FLT_TABLE_SOURCE_MISSING without a source). simulate_motion then reports data.flight.rotors (thrust N, torque N·m, power W, J range). ' +
    'The rotor mass should be part of the body (its entities); only its spinning inertia is given here. Delete with delete_dynamics_item. ' +
    'Returns the rotor id in affected[0].',
  params: z.object({
    body: z.string().describe('Id of the (non-fixed) rigid body carrying the rotor, usually the airframe.'),
    hub: vec3('Hub centre, world coordinates in DOCUMENT units at the modelled pose (the point rides on the body).'),
    axis: vec3(
      'Thrust direction at the modelled pose, e.g. [0, 0, 1] for a lift rotor; fixed in the body. Need not be unit, must be non-zero.',
    ),
    spin: z
      .enum(['cw', 'ccw'])
      .describe(
        '"ccw" = turns counter-clockwise seen from the side the thrust points to (angular velocity along +axis); "cw" the reverse.',
      ),
    rpm: z.number().min(0).max(200000).describe('Rotor speed in rev/min, held constant over the run.'),
    diameter: z.number().positive().describe('Rotor tip diameter in METRES (a 10-inch prop is 0.254).'),
    thrustCoefficient: z
      .number()
      .min(0)
      .optional()
      .describe('Static thrust coefficient Ct (J = 0), e.g. 0.1158; with powerCoefficient + source.'),
    powerCoefficient: z
      .number()
      .min(0)
      .optional()
      .describe('Static power coefficient Cp (J = 0), e.g. 0.0466; with thrustCoefficient + source.'),
    source: z.string().optional().describe('Where the static pair comes from (data file, test); required with the static pair.'),
    table: tableSchema.optional(),
    airDensity: z.number().positive().optional().describe('kg/m³; default 1.225 (ISA sea level).'),
    spinInertiaKgM2: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Moment of inertia of the spinning parts (blades, hub, motor bell) about the axis, kg·m²; default 0 = no gyroscopic torque.',
      ),
    id: z.string().optional().describe('Optional explicit rotor id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_rotor');
    const problem = bodyProblem(doc, params.body);
    if (problem !== null) return fail(problem);
    if (Math.hypot(...params.axis) < 1e-12) return fail('axis must be non-zero');
    const { table, thrustCoefficient: ct, powerCoefficient: cp } = params;
    const hasPair = ct !== undefined || cp !== undefined;
    if (table !== undefined && hasPair) return fail('give the static pair (thrustCoefficient + powerCoefficient) OR table, not both');
    if (table === undefined && (ct === undefined || cp === undefined))
      return fail('give thrustCoefficient + powerCoefficient (static, with source) or a [J, Ct, Cp] table: no default coefficients exist');
    const source = (table?.source ?? params.source ?? '').trim();
    if (source === '')
      return codedRejection(
        doc,
        'add_rotor',
        'FLT_TABLE_SOURCE_MISSING',
        'the rotor coefficients have no source',
        'Give `source` (static pair) or `table.source`: where the coefficients were measured or published.',
      );
    if (table !== undefined && table.points.some((point, i) => i > 0 && point[0] <= (table.points[i - 1]?.[0] ?? Infinity)))
      return fail('table J values must strictly increase');
    const rotorId = idOrNext(params.id, 'rotor');
    const flight = flightOf(doc);
    if (dynamicsIdTaken(dynamicsOf(doc), rotorId) || idTaken(flight.rotors, rotorId)) return fail(`id '${rotorId}' is already used`);
    const coefficients: RotorCoefficients =
      table !== undefined
        ? { kind: 'table', points: table.points, source, grade: table.grade ?? 'C' }
        : { kind: 'static', thrustCoefficient: ct ?? 0, powerCoefficient: cp ?? 0, source };
    const rotor: Rotor = {
      id: rotorId,
      bodyId: params.body,
      hub: params.hub,
      axis: params.axis,
      spin: params.spin,
      rpm: params.rpm,
      diameter: params.diameter,
      coefficients,
      airDensity: params.airDensity ?? ISA_SEA_LEVEL_DENSITY,
      spinInertiaKgM2: params.spinInertiaKgM2 ?? 0,
    };
    const n = rotor.rpm / 60;
    const [ct0, cp0] =
      coefficients.kind === 'static'
        ? [coefficients.thrustCoefficient, coefficients.powerCoefficient]
        : [coefficients.points[0]?.[1] ?? 0, coefficients.points[0]?.[2] ?? 0];
    const thrust = ct0 * rotor.airDensity * n * n * rotor.diameter ** 4;
    const torque = (cp0 * rotor.airDensity * n * n * rotor.diameter ** 5) / (2 * Math.PI);
    const law =
      coefficients.kind === 'static'
        ? `static Ct ${format(ct0)} / Cp ${format(cp0)}`
        : `table of ${coefficients.points.length} points (grade ${coefficients.grade}), first row J ${format(coefficients.points[0]?.[0] ?? 0)}`;
    return changed(
      { ...doc, flight: { ...flight, rotors: { ...flight.rotors, [rotorId]: rotor } } },
      `add_rotor: '${rotorId}' on body '${rotor.bodyId}' — D ${format(rotor.diameter)} m at ${format(rotor.rpm)} rpm, ${rotor.spin}, axis [${rotor.axis.join(', ')}], ` +
        `${law} (${source}); at the first coefficients thrust ${format(thrust)} N, torque ${format(torque)} N·m, power ${format(torque * 2 * Math.PI * n)} W.`,
      [rotorId],
    );
  },
});

/**
 * @affects sets (or with an all-zero cdaM2 removes) doc.flight.bodyDrag[body] (affected: [body])
 * @invariant body is a non-fixed rigid body; every cdaM2 component >= 0
 * @failure unknown / fixed body, removing a drag the body does not have -> no-op
 */
export const setBodyDrag = defineCommand({
  name: 'set_body_drag',
  annotations: { idempotent: true },
  description:
    'Give a rigid body quadratic air drag for simulate_motion (13 FLT): in the body axes, F_i = -½·ρ·CdA_i·|v|·v_i at the centre of mass, v the ' +
    'velocity of the centre of mass relative to still air (no wind yet), so the drag turns with the body. `cdaM2` = drag area Cd·A per body ' +
    'axis in m² (the world x, y, z axes at the modelled pose), e.g. a 1.1 kg quadcopter frame [0.02, 0.02, 0.05]. A falling body then reaches ' +
    "the terminal speed sqrt(2·m·g / (ρ·CdA)). Replaces the body's previous drag; all-zero cdaM2 removes it. No lift and no drag moment.",
  params: z.object({
    body: z.string().describe('Id of the (non-fixed) rigid body.'),
    cdaM2: z
      .tuple([z.number().min(0), z.number().min(0), z.number().min(0)])
      .describe('Drag area Cd·A along the body x, y, z axes, m² (>= 0 each); [0, 0, 0] removes the drag.'),
    airDensity: z.number().positive().optional().describe('kg/m³; default 1.225 (ISA sea level).'),
  }),
  run: (doc, { body, cdaM2, airDensity }): CommandResult => {
    const fail = failer(doc, 'set_body_drag');
    const problem = bodyProblem(doc, body);
    if (problem !== null) return fail(problem);
    const flight = flightOf(doc);
    const { [body]: previous, ...others } = flight.bodyDrag;
    if (cdaM2.every((value) => value === 0)) {
      if (previous === undefined) return fail(`body '${body}' has no drag to remove`);
      return changed({ ...doc, flight: { ...flight, bodyDrag: others } }, `set_body_drag: removed the drag of body '${body}'.`, [body]);
    }
    const drag = { bodyId: body, cdaM2, airDensity: airDensity ?? ISA_SEA_LEVEL_DENSITY };
    return changed(
      { ...doc, flight: { ...flight, bodyDrag: { ...others, [body]: drag } } },
      `set_body_drag: body '${body}' CdA [${cdaM2.map(format).join(', ')}] m² (body axes), ρ ${format(drag.airDensity)} kg/m³` +
        `${previous === undefined ? '' : ' (replaced the previous drag)'}.`,
      [body],
    );
  },
});
