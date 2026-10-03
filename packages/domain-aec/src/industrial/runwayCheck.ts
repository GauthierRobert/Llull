/**
 * Crane runway beam verification (preliminary): bending + shear under moving wheel loads, lateral
 * bending, lateral-torsional buckling, SLS deflections (EN 1993-6 §7.3) and fatigue (EN 1993-1-9).
 * @layer domain-aec
 */

export {
  RAILS,
  GAMMA_BUFFER,
  DEFAULT_TRAVEL_SPEED,
  DEFAULT_BUFFER_STIFFNESS,
  bufferForce,
  wheelMoment,
  wheelShear,
} from './runwayCheckModel';
export type {
  CraneClass,
  GirderType,
  RailSize,
  RunwayCheckParams,
  RunwayCheckRow,
} from './runwayCheckModel';
export { runwayCheck } from './runwayCheckRun';
