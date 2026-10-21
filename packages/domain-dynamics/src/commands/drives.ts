/** Drives (engines / motors) and loads (propellers) acting on joints. */

import type { Motor, PropellerLoad, TorquePoint } from '@core/model/dynamics';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { idOrNext } from '@lib/explicitId';
import { changed, failer } from '@core/commands/noop';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from './bodies';

/**
 * @affects adds 1 motor to doc.dynamics (affected: [motorId])
 * @invariant joint exists; torque_curve: >= 1 point, strictly increasing rpm, throttle in [0, 1]; speed: maxTorque > 0
 * @failure unknown or prismatic joint, missing / unsorted curve, bad throttle, missing rpm / maxTorque, taken id -> no-op
 */
export const addMotor = defineCommand({
  name: 'add_motor',
  description:
    'Drive a joint for simulate_motion. kind "torque_curve" = an engine or electric motor: torque (N·m) vs shaft speed (rpm) at full ' +
    'throttle, e.g. curve [[0, 300], [2000, 420], [2800, 400], [3200, 0]], times `throttle` (0..1). A single constant torque: ' +
    '`torque: 50` (same as a one-point curve). The speed then rises until the load (propeller, friction, damping) absorbs the torque — ' +
    'the physically settled operating point. kind "speed" = a governed drive that holds `rpm` using at most `maxTorque` N·m (a test ' +
    "rig / constant-speed prop governor). Torque acts in the joint's positive direction (right-hand rule about the joint axis). " +
    'Returns the motor id in affected[0].',
  params: z.object({
    joint: z.string().describe('Joint id to drive (e.g. the crankshaft joint).'),
    kind: z.enum(['torque_curve', 'speed']).describe('"torque_curve" = engine (torque vs rpm); "speed" = holds a set rpm.'),
    curve: z
      .array(z.tuple([z.number(), z.number()]))
      .optional()
      .describe('torque_curve: [[rpm, torque N·m], …] with increasing rpm; linear between points, held flat outside them.'),
    torque: z.number().optional().describe('torque_curve shortcut: one constant torque in N·m (instead of curve).'),
    throttle: z.number().min(0).max(1).optional().describe('torque_curve: fraction of the curve torque, 0..1. Default 1.'),
    rpm: z.number().optional().describe('speed: target shaft speed in rpm.'),
    maxTorque: z.number().positive().optional().describe('speed: torque limit in N·m.'),
    id: z.string().optional().describe('Optional explicit motor id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_motor');
    const dynamics = dynamicsOf(doc);
    const joint = dynamics.joints[params.joint];
    if (joint === undefined) return fail(`joint '${params.joint}' not found (add_body_joint first)`);
    if (joint.kind !== 'revolute') return fail(`joint '${params.joint}' is prismatic; motors (rpm, N·m) drive revolute joints`);
    const motorId = idOrNext(params.id, 'motor');
    if (dynamicsIdTaken(dynamics, motorId)) return fail(`id '${motorId}' is already used`);
    let motor: Motor;
    if (params.kind === 'torque_curve') {
      const curve: TorquePoint[] = params.curve ?? (params.torque !== undefined ? [[0, params.torque]] : []);
      if (curve.length === 0) return fail('torque_curve needs `curve` or `torque`');
      if (curve.some(([rpm, torque]) => !Number.isFinite(rpm) || !Number.isFinite(torque))) return fail('curve values must be finite');
      if (curve.some((point, i) => i > 0 && point[0] <= (curve[i - 1]?.[0] ?? -Infinity))) return fail('curve rpm values must increase');
      motor = { id: motorId, kind: 'torque_curve', joint: params.joint, curve, throttle: params.throttle ?? 1 };
    } else {
      if (params.rpm === undefined || params.maxTorque === undefined) return fail('speed motor needs `rpm` and `maxTorque`');
      motor = { id: motorId, kind: 'speed', joint: params.joint, rpm: params.rpm, maxTorque: params.maxTorque };
    }
    const what =
      motor.kind === 'speed'
        ? `holds ${motor.rpm} rpm (≤ ${motor.maxTorque} N·m)`
        : `torque curve of ${motor.curve.length} point(s), peak ${Math.max(...motor.curve.map(([, t]) => t))} N·m, throttle ${motor.throttle}`;
    return changed(
      withDynamics(doc, { ...dynamics, motors: { ...dynamics.motors, [motorId]: motor } }),
      `add_motor: '${motorId}' on joint '${params.joint}' — ${what}.`,
      [motorId],
    );
  },
});

/**
 * @affects adds 1 propeller load to doc.dynamics (affected: [propellerId])
 * @invariant joint exists and is revolute; diameter, airDensity > 0; coefficients >= 0; thrustDirection non-zero
 * @failure unknown / prismatic joint, bad numbers, taken id -> no-op
 */
export const addPropeller = defineCommand({
  name: 'add_propeller',
  description:
    "Load a revolute joint with a propeller's aerodynamics for simulate_motion (static / take-off condition by default). With " +
    'n = rev/s and D = diameter (m): thrust T = Ct·ρ·n²·D⁴ (pushes the spinning body along thrustDirection), shaft power ' +
    'P = Cp·ρ·n³·D⁵, drag torque Q = P/(2πn) against the rotation. Ct, Cp come from propeller test data (static): typical fixed-pitch ' +
    'wooden / composite props Ct 0.08–0.14, Cp 0.04–0.08 (larger pitch → larger Cp). Use the PROPELLER joint (after any reduction ' +
    'gear). Forward flight (FR-FPR-75): give `table` (measured [J, Ct, Cp] rows, J = V/(n·D), strictly increasing from 0, with a source: ' +
    'monotone cubic interpolation, held at the ends) and `airspeedMps`; Ct, Cp then follow the table whenever J > 0 (J = 0 keeps the static pair) ' +
    'and a run beyond the last J warns FPR_OUTSIDE_VALIDATED_RANGE. No propeller table ships with llull: use measured data (NACA TR-640 class ' +
    'curves are about 1 % repeatable, applicability to your propeller is not validated). `inertiaKgM2` declares the shaft inertia when the ' +
    'propeller is not a rigid body (plausibility-checked against the Rotax 912 limit 0.15-0.60 kg·m²). Returns the propeller id in affected[0].',
  params: z.object({
    joint: z.string().describe('Revolute joint the propeller turns on.'),
    diameter: z.number().positive().describe('Propeller tip diameter in METRES (e.g. 1.8).'),
    thrustCoefficient: z.number().min(0).describe('Static thrust coefficient Ct (e.g. 0.11).'),
    powerCoefficient: z.number().min(0).describe('Static power coefficient Cp (e.g. 0.05).'),
    airDensity: z.number().positive().optional().describe('kg/m³; default 1.225 (ISA sea level).'),
    thrustDirection: vec3('World direction of the thrust on the propeller (the pull direction), e.g. [0, 1, 0].').optional(),
    airspeedMps: z
      .number()
      .min(0)
      .optional()
      .describe('Forward speed of the air relative to the propeller, m/s (>= 0). Needs `table`. Default 0 (static).'),
    table: z
      .object({
        points: z
          .array(z.tuple([z.number(), z.number(), z.number()]))
          .min(2)
          .describe('[[J, Ct, Cp], ...]: advance ratio J = V/(n·D) strictly increasing, first J >= 0.'),
        source: z.string().describe('Where the table comes from (report, figure, test); required.'),
        grade: z
          .enum(['A', 'B', 'C'])
          .optional()
          .describe('Source grade: A measured / verified, B published curve, C reconstructed or unchecked. Default C.'),
      })
      .optional()
      .describe('Measured Ct(J), Cp(J) replacing the static pair when J > 0.'),
    inertiaKgM2: z
      .number()
      .positive()
      .optional()
      .describe('Propeller moment of inertia about its shaft, kg·m² (when it is not a rigid body).'),
    id: z.string().optional().describe('Optional explicit propeller id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_propeller');
    const dynamics = dynamicsOf(doc);
    const joint = dynamics.joints[params.joint];
    if (joint === undefined) return fail(`joint '${params.joint}' not found (add_body_joint first)`);
    if (joint.kind !== 'revolute') return fail(`joint '${params.joint}' is prismatic; a propeller needs a revolute joint`);
    const thrustDirection = params.thrustDirection ?? joint.axis;
    if (Math.hypot(...thrustDirection) < 1e-12) return fail('thrustDirection must be non-zero');
    const table = params.table;
    if (table !== undefined) {
      if (table.source.trim() === '') return fail('table needs a non-empty source');
      if (table.points.some((point) => point.some((value) => !Number.isFinite(value)))) return fail('table values must be finite');
      if (table.points.some((point, i) => i > 0 && point[0] <= (table.points[i - 1]?.[0] ?? Infinity)) || (table.points[0]?.[0] ?? -1) < 0)
        return fail('table J values must start at >= 0 and strictly increase');
    } else if (params.airspeedMps !== undefined) return fail('airspeedMps needs a Ct / Cp table (give `table`)');
    const propellerId = idOrNext(params.id, 'prop');
    if (dynamicsIdTaken(dynamics, propellerId)) return fail(`id '${propellerId}' is already used`);
    const propeller: PropellerLoad = {
      id: propellerId,
      joint: params.joint,
      diameter: params.diameter,
      thrustCoefficient: params.thrustCoefficient,
      powerCoefficient: params.powerCoefficient,
      airDensity: params.airDensity ?? 1.225,
      thrustDirection,
      ...(params.airspeedMps !== undefined ? { airspeedMps: params.airspeedMps } : {}),
      ...(table !== undefined ? { table: { points: table.points, source: table.source, grade: table.grade ?? 'C' } } : {}),
      ...(params.inertiaKgM2 !== undefined ? { inertiaKgM2: params.inertiaKgM2 } : {}),
    };
    return changed(
      withDynamics(doc, { ...dynamics, propellers: { ...dynamics.propellers, [propellerId]: propeller } }),
      `add_propeller: '${propellerId}' on joint '${params.joint}' — D ${params.diameter} m, Ct ${params.thrustCoefficient}, ` +
        `Cp ${params.powerCoefficient}, ρ ${propeller.airDensity} kg/m³` +
        `${table === undefined ? '' : `; Ct/Cp table of ${table.points.length} points (J ${table.points[0]?.[0]}..${table.points[table.points.length - 1]?.[0]}, ${table.source}), airspeed ${params.airspeedMps ?? 0} m/s`}` +
        `${params.inertiaKgM2 === undefined ? '' : `; inertia ${params.inertiaKgM2} kg·m²`}.`,
      [propellerId],
    );
  },
});
