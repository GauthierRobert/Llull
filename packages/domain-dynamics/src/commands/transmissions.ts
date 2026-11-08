/** add_transmission: gears, belts, lead / ball screws and racks between physics joints, with losses, self-locking and backlash. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import type { DynamicJoint, DynamicsModel } from '@core/model/dynamics';
import { idTakenInDynamicsOrFlight } from '../flight/model';
import { transmissionJoints, transmissionRatio, type Transmission } from '@core/model/transmissions';
import { idOrNext } from '@lib/explicitId';
import { leadScrewEfficiency, transmissionEfficiency } from '../sim/transmissions';
import { dynamicsOf, withDynamics } from './bodies';
import { sourceSchema, toSource } from './motorSchemas';

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

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;
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
  params: z.object({
    kind: z.enum(['gear', 'belt', 'lead_screw', 'ball_screw', 'rack_pinion']).describe('Transmission kind.'),
    driver: z.string().optional().describe('gear, belt: revolute joint id that drives (the input).'),
    driven: z.string().optional().describe('gear, belt: revolute joint id that follows.'),
    ratio: z
      .number()
      .optional()
      .describe('gear: speed(driven) / speed(driver), negative reverses. Give this OR `teeth`; with both they must agree.'),
    teeth: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional()
      .describe('gear: tooth counts [driver, driven]: ratio = driverTeeth / drivenTeeth (negated by `reverseRotation`).'),
    reverseRotation: z
      .boolean()
      .optional()
      .describe('gear with `teeth`: true for an external spur mesh (driven turns the other way). Default false.'),
    driverDiameterMm: z.number().optional().describe('belt: driver pulley pitch diameter, mm (> 0).'),
    drivenDiameterMm: z.number().optional().describe('belt: driven pulley pitch diameter, mm (> 0).'),
    screw: z.string().optional().describe('lead_screw, ball_screw: revolute joint id of the screw (the input).'),
    nut: z.string().optional().describe('lead_screw, ball_screw: prismatic joint id of the nut.'),
    pinion: z.string().optional().describe('rack_pinion: revolute joint id of the pinion (the input).'),
    rack: z.string().optional().describe('rack_pinion: prismatic joint id of the rack.'),
    leadMm: z
      .number()
      .optional()
      .describe(
        'screws: advance of the nut per screw revolution, mm (> 0); the positive screw sense advances the nut along its joint axis.',
      ),
    meanDiameterMm: z.number().optional().describe('lead_screw: mean thread diameter d_m, mm (> 0).'),
    mu: z
      .number()
      .optional()
      .describe(
        'lead_screw: coefficient of friction of the thread flanks (>= 0): steel on bronze 0.08-0.15 lubricated, 0.35 dry steel on steel.',
      ),
    flankAngleDeg: z.number().optional().describe('lead_screw: flank half-angle α_n in degrees, [0, 90). Default 0 (square thread).'),
    pitchRadiusMm: z.number().optional().describe('rack_pinion: pitch radius of the pinion, mm (> 0).'),
    efficiency: z
      .number()
      .optional()
      .describe(
        'gear, belt, ball_screw, rack_pinion: forward efficiency in (0, 1]. gear / belt / rack default 1 (ideal); required for ball_screw.',
      ),
    efficiencyBack: z
      .number()
      .optional()
      .describe('gear, rack_pinion, ball_screw: back-drive efficiency in (0, 1]. Default = efficiency (required for ball_screw).'),
    backlashDeg: z.number().optional().describe('gear: total angular gap at the driven shaft, degrees (> 0).'),
    backlashMm: z.number().optional().describe('rack_pinion: total linear gap of the rack, mm (> 0).'),
    meshStiffnessNmPerRad: z.number().optional().describe('gear with backlash: contact stiffness at the driven shaft, N·m/rad (> 0).'),
    meshStiffnessNPerM: z.number().optional().describe('rack_pinion with backlash: contact stiffness at the rack, N/m (> 0).'),
    meshDampingRatio: z.number().optional().describe('gear / rack_pinion with backlash: damping ratio of the contact (> 0, default 0.5).'),
    source: sourceSchema.optional().describe('Where the efficiencies / geometry come from (recommended: grades the result).'),
    id: z.string().optional().describe('Optional explicit transmission id.'),
  }),
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
    let transmission: Transmission;
    if (params.kind === 'gear') {
      const fromTeeth =
        params.teeth === undefined ? undefined : (params.reverseRotation === true ? -1 : 1) * (params.teeth[0] / params.teeth[1]);
      if (params.ratio === undefined && fromTeeth === undefined) return fail('gear needs a ratio or tooth counts');
      if (params.ratio !== undefined && fromTeeth !== undefined && Math.abs(params.ratio - fromTeeth) > 1e-9 * Math.abs(fromTeeth))
        return fail(`ratio ${params.ratio} disagrees with the tooth counts (${params.teeth?.join('/')} give ${fromTeeth})`);
      const ratio = params.ratio ?? fromTeeth ?? 0;
      if (!(Math.abs(ratio) > 0) || !Number.isFinite(ratio)) return fail('ratio must be finite and non-zero');
      if (params.backlashDeg !== undefined && !positive(params.backlashDeg)) return fail('backlashDeg must be > 0');
      if (!positive(params.meshStiffnessNmPerRad ?? 1) || !positive(params.meshDampingRatio ?? 1))
        return fail('mesh stiffness and damping ratio must be > 0');
      transmission = {
        kind: 'gear',
        id,
        driver: driverId,
        driven: drivenId,
        ratio,
        ...(params.teeth === undefined ? {} : { teeth: params.teeth }),
        ...(params.efficiency === undefined ? {} : { efficiency: params.efficiency }),
        ...(params.efficiencyBack === undefined ? {} : { efficiencyBack: params.efficiencyBack }),
        ...(params.backlashDeg === undefined ? {} : { backlashDeg: params.backlashDeg }),
        ...(params.meshStiffnessNmPerRad === undefined ? {} : { meshStiffnessNmPerRad: params.meshStiffnessNmPerRad }),
        ...(params.meshDampingRatio === undefined ? {} : { meshDampingRatio: params.meshDampingRatio }),
        ...source,
      };
    } else if (params.kind === 'belt') {
      if (!positive(params.driverDiameterMm) || !positive(params.drivenDiameterMm))
        return fail('belt needs driverDiameterMm and drivenDiameterMm > 0');
      transmission = {
        kind: 'belt',
        id,
        driver: driverId,
        driven: drivenId,
        driverDiameterMm: params.driverDiameterMm,
        drivenDiameterMm: params.drivenDiameterMm,
        ...(params.efficiency === undefined ? {} : { efficiency: params.efficiency }),
        ...(params.efficiencyBack === undefined ? {} : { efficiencyBack: params.efficiencyBack }),
        ...source,
      };
    } else if (params.kind === 'lead_screw') {
      if (!positive(params.leadMm) || !positive(params.meanDiameterMm)) return fail('lead_screw needs leadMm and meanDiameterMm > 0');
      if (params.mu === undefined || !Number.isFinite(params.mu) || params.mu < 0) return fail('lead_screw needs mu >= 0');
      if (params.flankAngleDeg !== undefined && !(params.flankAngleDeg >= 0 && params.flankAngleDeg < 90))
        return fail('flankAngleDeg must be in [0, 90)');
      transmission = {
        kind: 'lead_screw',
        id,
        screw: driverId,
        nut: drivenId,
        leadMm: params.leadMm,
        meanDiameterMm: params.meanDiameterMm,
        mu: params.mu,
        ...(params.flankAngleDeg === undefined ? {} : { flankAngleDeg: params.flankAngleDeg }),
        ...source,
      };
      if (leadScrewEfficiency(transmission).forward <= 1e-3)
        return refuse('DRV_EFFICIENCY_INVALID', `the thread (lead angle + friction angle >= 90 deg) cannot lift: forward efficiency is 0`);
    } else if (params.kind === 'ball_screw') {
      if (!positive(params.leadMm)) return fail('ball_screw needs leadMm > 0');
      if (params.efficiency === undefined || params.efficiencyBack === undefined)
        return refuse('DRV_EFFICIENCY_INVALID', 'ball_screw needs efficiency and efficiencyBack');
      transmission = {
        kind: 'ball_screw',
        id,
        screw: driverId,
        nut: drivenId,
        leadMm: params.leadMm,
        efficiency: params.efficiency,
        efficiencyBack: params.efficiencyBack,
        ...source,
      };
    } else {
      if (!positive(params.pitchRadiusMm)) return fail('rack_pinion needs pitchRadiusMm > 0');
      if (params.backlashMm !== undefined && !positive(params.backlashMm)) return fail('backlashMm must be > 0');
      if (!positive(params.meshStiffnessNPerM ?? 1) || !positive(params.meshDampingRatio ?? 1))
        return fail('mesh stiffness and damping ratio must be > 0');
      transmission = {
        kind: 'rack_pinion',
        id,
        pinion: driverId,
        rack: drivenId,
        pitchRadiusMm: params.pitchRadiusMm,
        ...(params.efficiency === undefined ? {} : { efficiency: params.efficiency }),
        ...(params.efficiencyBack === undefined ? {} : { efficiencyBack: params.efficiencyBack }),
        ...(params.backlashMm === undefined ? {} : { backlashMm: params.backlashMm }),
        ...(params.meshStiffnessNPerM === undefined ? {} : { meshStiffnessNPerM: params.meshStiffnessNPerM }),
        ...(params.meshDampingRatio === undefined ? {} : { meshDampingRatio: params.meshDampingRatio }),
        ...source,
      };
    }
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
