/** Free stream -> Mach number -> regime -> solver (TECHNICAL_SPEC §5.1 step 12, FR-CFD-06); refusal outside the solver ranges. */

import type { CfdCase, CfdSolver } from '@aero/cfd/types';
import { US1976 } from '../shared/atmosphere';
import { isAirState, resolveAirState } from '../shared/airState';

/** Lattice-Boltzmann is a low-Mach method: it covers Mach below this. */
export const LBM_MAX_MACH = 0.3;
/** Upper end of the Euler solver range (hypersonic real-gas effects are not modelled). */
export const EULER_MAX_MACH = 5;

const AIR_GAS_CONSTANT = US1976.gasConstantUniversal / US1976.molarMassAir;

export interface FlowState {
  readonly machNumber: number;
  readonly speedMS: number;
  readonly speedOfSoundMS: number;
  readonly densityKgM3: number;
  readonly viscosityPaS: number;
  readonly temperatureK: number | null;
  readonly airSource: string;
  readonly regime: 'low_speed' | 'compressible';
  readonly solver: CfdSolver;
}

export type FlowResolution =
  | { readonly ok: true; readonly state: FlowState }
  | { readonly ok: false; readonly code: string; readonly message: string };

const refuse = (code: string, message: string): FlowResolution => ({ ok: false, code, message });

const solverRange = (solver: CfdSolver): string =>
  solver === 'lbm' ? `Mach < ${LBM_MAX_MACH}` : `${LBM_MAX_MACH} <= Mach <= ${EULER_MAX_MACH}`;

const solverFor = (mach: number): CfdSolver | null => (mach < LBM_MAX_MACH ? 'lbm' : mach <= EULER_MAX_MACH ? 'euler' : null);

/**
 * @failure no air state / bad free stream -> CFD_PARAM_INVALID; Mach above 5, or regime / forced solver outside its Mach range -> CFD_REGIME_MISMATCH
 */
export function resolveFlow(cfdCase: Pick<CfdCase, 'regime' | 'freestream' | 'solver'>): FlowResolution {
  const { freestream } = cfdCase;
  const hasMach = freestream.mach !== undefined;
  const hasSpeed = freestream.speedMS !== undefined;
  if (hasMach === hasSpeed) return refuse('CFD_PARAM_INVALID', 'freestream needs exactly one of mach / speedMS');
  const value = freestream.mach ?? freestream.speedMS ?? 0;
  if (!(Number.isFinite(value) && value > 0)) return refuse('CFD_PARAM_INVALID', 'freestream mach / speedMS must be a finite number > 0');
  if (freestream.air !== undefined && freestream.altitudeM !== undefined)
    return refuse('CFD_PARAM_INVALID', 'freestream gives both altitudeM and air: give one');
  const air = freestream.air;
  if (air !== undefined && !(air.densityKgM3 > 0 && air.temperatureK > 0 && air.viscosityPaS > 0))
    return refuse('CFD_PARAM_INVALID', 'freestream.air densityKgM3 / temperatureK / viscosityPaS must be > 0');
  const resolved = air === undefined ? resolveAirState({ altitudeM: freestream.altitudeM ?? 0 }) : null;
  if (resolved !== null && !isAirState(resolved)) return refuse('CFD_PARAM_INVALID', resolved.message);
  const speedOfSoundMS =
    air !== undefined ? Math.sqrt(US1976.gamma * AIR_GAS_CONSTANT * air.temperatureK) : (resolved?.speedOfSoundMS ?? 0);
  const machNumber = freestream.mach ?? (freestream.speedMS ?? 0) / speedOfSoundMS;
  const speedMS = freestream.speedMS ?? machNumber * speedOfSoundMS;
  const solver = solverFor(machNumber);
  if (solver === null)
    return refuse('CFD_REGIME_MISMATCH', `Mach ${machNumber.toPrecision(4)} is above ${EULER_MAX_MACH}: no solver covers it`);
  const regime = solver === 'lbm' ? 'low_speed' : 'compressible';
  if (cfdCase.regime !== 'auto' && cfdCase.regime !== regime)
    return refuse('CFD_REGIME_MISMATCH', `regime ${cfdCase.regime} does not fit Mach ${machNumber.toPrecision(4)} (${regime})`);
  if (cfdCase.solver !== undefined && cfdCase.solver !== solver)
    return refuse(
      'CFD_REGIME_MISMATCH',
      `solver ${cfdCase.solver} needs ${solverRange(cfdCase.solver)}, the free stream is Mach ${machNumber.toPrecision(4)}`,
    );
  return {
    ok: true,
    state: {
      machNumber,
      speedMS,
      speedOfSoundMS,
      densityKgM3: air?.densityKgM3 ?? resolved?.densityKgM3 ?? 0,
      viscosityPaS: air?.viscosityPaS ?? resolved?.viscosityPaS ?? 0,
      temperatureK: air?.temperatureK ?? resolved?.temperatureK ?? null,
      airSource: air !== undefined ? 'given air state' : (resolved?.source ?? ''),
      regime,
      solver,
    },
  };
}
