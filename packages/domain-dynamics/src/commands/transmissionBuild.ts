/** add_transmission: per-kind validation and construction of the transmission record. */

import type { CommandResult } from '@core/commands/types';
import type { z } from '@core/commands/schema';
import type { Transmission } from '@core/model/transmissions';
import { leadScrewEfficiency } from '../sim/transmissions';
import type { toSource } from './motorSchemas';
import type { transmissionParams } from './transmissionSchema';

type Params = z.infer<typeof transmissionParams>;

export interface TransmissionWiring {
  readonly id: string;
  readonly driverId: string;
  readonly drivenId: string;
  readonly source: { source?: ReturnType<typeof toSource> };
  readonly fail: (message: string) => CommandResult;
  readonly refuse: (code: string, message: string, ids?: readonly string[]) => CommandResult;
}

type Built = Transmission | CommandResult;

export const isRefusal = (built: Built): built is CommandResult => 'document' in built;

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

function buildGear(params: Params, wiring: TransmissionWiring): Built {
  const { id, driverId, drivenId, source, fail } = wiring;
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
  return {
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
}

function buildBelt(params: Params, wiring: TransmissionWiring): Built {
  const { id, driverId, drivenId, source, fail } = wiring;
  if (!positive(params.driverDiameterMm) || !positive(params.drivenDiameterMm))
    return fail('belt needs driverDiameterMm and drivenDiameterMm > 0');
  return {
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
}

function buildLeadScrew(params: Params, wiring: TransmissionWiring): Built {
  const { id, driverId, drivenId, source, fail, refuse } = wiring;
  if (!positive(params.leadMm) || !positive(params.meanDiameterMm)) return fail('lead_screw needs leadMm and meanDiameterMm > 0');
  if (params.mu === undefined || !Number.isFinite(params.mu) || params.mu < 0) return fail('lead_screw needs mu >= 0');
  if (params.flankAngleDeg !== undefined && !(params.flankAngleDeg >= 0 && params.flankAngleDeg < 90))
    return fail('flankAngleDeg must be in [0, 90)');
  const transmission: Transmission = {
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
  return transmission;
}

function buildBallScrew(params: Params, wiring: TransmissionWiring): Built {
  const { id, driverId, drivenId, source, fail, refuse } = wiring;
  if (!positive(params.leadMm)) return fail('ball_screw needs leadMm > 0');
  if (params.efficiency === undefined || params.efficiencyBack === undefined)
    return refuse('DRV_EFFICIENCY_INVALID', 'ball_screw needs efficiency and efficiencyBack');
  return {
    kind: 'ball_screw',
    id,
    screw: driverId,
    nut: drivenId,
    leadMm: params.leadMm,
    efficiency: params.efficiency,
    efficiencyBack: params.efficiencyBack,
    ...source,
  };
}

function buildRackPinion(params: Params, wiring: TransmissionWiring): Built {
  const { id, driverId, drivenId, source, fail } = wiring;
  if (!positive(params.pitchRadiusMm)) return fail('rack_pinion needs pitchRadiusMm > 0');
  if (params.backlashMm !== undefined && !positive(params.backlashMm)) return fail('backlashMm must be > 0');
  if (!positive(params.meshStiffnessNPerM ?? 1) || !positive(params.meshDampingRatio ?? 1))
    return fail('mesh stiffness and damping ratio must be > 0');
  return {
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

export function buildTransmission(params: Params, wiring: TransmissionWiring): Built {
  switch (params.kind) {
    case 'gear':
      return buildGear(params, wiring);
    case 'belt':
      return buildBelt(params, wiring);
    case 'lead_screw':
      return buildLeadScrew(params, wiring);
    case 'ball_screw':
      return buildBallScrew(params, wiring);
    case 'rack_pinion':
      return buildRackPinion(params, wiring);
  }
}
