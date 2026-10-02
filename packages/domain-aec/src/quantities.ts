/**
 * Pure quantity takeoff and schedules over the constructive building model.
 * All quantities are metric (m, m², m³, ea) regardless of document units.
 * @layer domain-aec
 * @pure
 */

export { wallQuantities, slabNetArea, stairVolume } from './takeoffBasics';
export type { TakeoffUnit, TakeoffLine, WallQuantities } from './takeoffBasics';
export { computeTakeoff, memberLength, memberMass, pipeLength, panelArea } from './takeoffCompute';
export { buildSchedule, toCsv } from './scheduleBuild';
export type { ScheduleKind, Schedule } from './scheduleBuild';
export { rateFor, priceTakeoff } from './costing';
export type { CostLine } from './costing';
