/** add_transmission: gears, belts, lead / ball screws and racks between physics joints, with losses, self-locking and backlash. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import type { DynamicJoint, DynamicsModel } from '@core/model/dynamics';
import { idTakenInDynamicsOrFlight } from '../flight/model';
import { transmissionJoints, transmissionRatio, type Transmission } from '@core/model/transmissions';
import { idOrNext } from '@lib/explicitId';
import { transmissionEfficiency } from '../sim/transmissions';
import { dynamicsOf, withDynamics } from './bodies';
import { toSource } from './motorSchemas';
import { buildTransmission, isRefusal, type TransmissionWiring } from './transmissionBuild';
import { transmissionParams } from './transmissionSchema';

const REMEDIATION: Readonly<Record<string, string>> = {
  DRV_TRANSMISSION_JOINTS:
    'gear / belt couple two revolute joints; lead_screw / ball_screw couple a revolute `screw` with a prismatic `nut`; rack_pinion a revolute `pinion` with a prismatic `rack` (add_body_joint).',
  DRV_TRANSMISSION_OVERCONSTRAINED:
    'A joint can be driven by one transmission only (it may still drive others): couple the driver through a chain, not twice.',
  DRV_EFFICIENCY_INVALID: 'Efficiencies are in (0, 1]; a thread must keep a forward efficiency above 0 (reduce mu or raise the lead).',
};

const FIELDS: Readonly<Record<Transmission['kind'], readonly string[]>> = {
  gear: ['driver', 'driven'],
  belt: ['driver', 'driven'],
  lead_screw: ['screw', 'nut'],
  ball_screw: ['screw', 'nut'],
  rack_pinion: ['pinion', 'rack'],
};

const efficient = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value > 0 && value <= 1);

/** True when `driver` is already driven, directly or through other transmissions, by `driven` (the new coupling would close a circle). */
function circular(dynamics: DynamicsModel, driver: string, driven: string): boolean {
  const driverOf = new Map(
    Object.values(dynamics.transmissions ?? {}).map((t) => [transmissionJoints(t).driven, transmissionJoints(t).driver]),
  );
  for (let current: string | undefined = driver, guard = 0; current !== undefined && guard <= driverOf.size; guard++) {
    if (current === driven) return true;
    current = driverOf.get(current);
  }
  return false;
}

/**
 * @affects adds 1 transmission to doc.dynamics.transmissions (affected: [transmissionId])
 * @invariant the joints exist and have the kinds the transmission kind needs (gear / belt: two revolute; screws and rack: revolute driver + prismatic driven);
 *   a joint is driven by at most one transmission, no circular chain; efficiencies in (0, 1]; a thread keeps a forward efficiency above 0; ratio finite, non-zero
 * @failure unknown joint, wrong kinds -> DRV_TRANSMISSION_JOINTS; joint already driven / circular -> DRV_TRANSMISSION_OVERCONSTRAINED;
 *   efficiency outside (0, 1] -> DRV_EFFICIENCY_INVALID; missing or inconsistent numbers, taken id -> no-op
 */
export const addTransmission = defineCommand({
  name: 'add_transmission',
  description:
    'Couple two physics joints (add_body_joint) through a transmission for simulate_motion; the coupling is a rigid constraint (both inertias interact) that ' +
    'LOSES POWER as friction on the driver joint and can lock. kind "gear": revolute `driver` and `driven`, speed(driven) = ratio × speed(driver) (ratio = ' +
    '-teeth(driver)/teeth(driven) for an external spur mesh, + for a belt or an internal gear; or give `teeth` [driver, driven] and `reverseRotation`; planetary with fixed ' +
    'ring, sun → carrier: sunTeeth / (sunTeeth + ringTeeth)); `efficiency` η_f in (0, 1] when the driver drives (spur meshes 0.98-0.995 [NASA TM 81426]; default 1 = ideal), ' +
    '`efficiencyBack` η_b when the load drives the driver (default = efficiency); `backlashDeg` (total gap at the driven shaft, lost motion on reversal) with optional ' +
    '`meshStiffnessNmPerRad` (default a 100 Hz mesh mode at the reflected inertia, reported as DRV_MESH_STIFFNESS_ASSUMED) and `meshDampingRatio` (default 0.5). ' +
    'kind "belt": `driverDiameterMm`, `drivenDiameterMm` (same direction, ratio = driver / driven diameter) and `efficiency`. kind "lead_screw": revolute `screw`, ' +
    "prismatic `nut` (nut advance per screw revolution = `leadMm`), efficiencies from the thread geometry: tan λ = lead / (π d_m), tan φ' = μ / cos α_n, " +
    "η_f = tan λ / tan(λ + φ'), η_b = tan(λ - φ') / tan λ; η_b <= 0 means SELF-LOCKING (the nut cannot back-drive the screw); needs `meanDiameterMm`, `mu`, optional " +
    '`flankAngleDeg` (0 square, 14.5 Acme, 15 trapezoidal ISO half-angle). kind "ball_screw": `screw`, `nut`, `leadMm`, `efficiency` (≈0.9) and `efficiencyBack` (≈0.85-0.9). ' +
    'kind "rack_pinion": revolute `pinion`, prismatic `rack`, `pitchRadiusMm` (rack advance = pitch radius × pinion angle), `efficiency`, optional `backlashMm` ' +
    'with `meshStiffnessNPerM`. Losses are exact for both directions: forward the friction level on the driver is |T|·(1-η_f)/η_f, back-driven |T|·(1-η_b) (T the ideal ' +
    'coupling torque), so the screw with η_b <= 0 holds a load with the motor off. Add the motor, joint physics and loads after the transmission. Returns the transmission id in affected[0].',
  params: transmissionParams,
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_transmission');
    const dynamics = dynamicsOf(doc);
    const refuse = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      codedRejection(doc, 'add_transmission', code, message, REMEDIATION[code] ?? 'see the command description', ids);
    const [first, second] = FIELDS[params.kind];
    const ends = [params[first as keyof typeof params], params[second as keyof typeof params]];
    if (typeof ends[0] !== 'string' || typeof ends[1] !== 'string')
      return fail(`${params.kind} needs \`${first}\` and \`${second}\` (joint ids)`);
    const [driverId, drivenId] = [ends[0], ends[1]];
    if (driverId === drivenId) return fail('a joint cannot be coupled to itself');
    const joints: [DynamicJoint | undefined, DynamicJoint | undefined] = [dynamics.joints[driverId], dynamics.joints[drivenId]];
    if (joints[0] === undefined) return fail(`joint '${driverId}' not found (add_body_joint first)`);
    if (joints[1] === undefined) return fail(`joint '${drivenId}' not found (add_body_joint first)`);
    const linear = params.kind !== 'gear' && params.kind !== 'belt';
    if (joints[0].kind !== 'revolute' || joints[1].kind !== (linear ? 'prismatic' : 'revolute'))
      return refuse(
        'DRV_TRANSMISSION_JOINTS',
        `${params.kind} needs ${first} '${driverId}' revolute (is ${joints[0].kind}) and ${second} '${drivenId}' ${linear ? 'prismatic' : 'revolute'} (is ${joints[1].kind})`,
        [driverId, drivenId],
      );
    const already = Object.values(dynamics.transmissions ?? {}).find((t) => transmissionJoints(t).driven === drivenId);
    if (already !== undefined)
      return refuse('DRV_TRANSMISSION_OVERCONSTRAINED', `joint '${drivenId}' is already driven by transmission '${already.id}'`, [
        drivenId,
        already.id,
      ]);
    if (circular(dynamics, driverId, drivenId))
      return refuse(
        'DRV_TRANSMISSION_OVERCONSTRAINED',
        `'${drivenId}' already drives '${driverId}' through transmissions: the coupling would be circular`,
        [driverId, drivenId],
      );
    if (!efficient(params.efficiency) || !efficient(params.efficiencyBack))
      return refuse(
        'DRV_EFFICIENCY_INVALID',
        `efficiency ${params.efficiency} / efficiencyBack ${params.efficiencyBack} must be in (0, 1]`,
      );
    const id = idOrNext(params.id, 'trans');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const source = params.source === undefined ? {} : { source: toSource(params.source) };
    const wiring: TransmissionWiring = { id, driverId, drivenId, source, fail, refuse };
    const built = buildTransmission(params, wiring);
    if (isRefusal(built)) return built;
    const transmission = built;
    const eta = transmissionEfficiency(transmission);
    const locking = eta.backward <= 0 ? ', SELF-LOCKING (η_b <= 0: holds a load with the motor off)' : '';
    const unit = linear ? 'm/rad' : '';
    return changed(
      withDynamics(doc, { ...dynamics, transmissions: { ...dynamics.transmissions, [id]: transmission } }),
      `add_transmission: ${transmission.kind} '${id}'${transmission.kind === 'gear' && transmission.teeth !== undefined ? ` (teeth ${transmission.teeth.join('/')})` : ''} — '${drivenId}' = ${Number(transmissionRatio(transmission).toPrecision(8))}${unit === '' ? ' ×' : ` ${unit} ×`} '${driverId}'; ` +
        `η_f ${Number(eta.forward.toPrecision(6))}, η_b ${Number(eta.backward.toPrecision(6))}${locking}` +
        `${transmission.kind === 'gear' && transmission.backlashDeg !== undefined ? `; backlash ${transmission.backlashDeg}°` : ''}` +
        `${transmission.kind === 'rack_pinion' && transmission.backlashMm !== undefined ? `; backlash ${transmission.backlashMm} mm` : ''}` +
        `${params.efficiency === undefined && (transmission.kind === 'gear' || transmission.kind === 'belt') ? ' (ideal; 0.99 is typical for a real mesh)' : ''}.`,
      [id],
    );
  },
});
