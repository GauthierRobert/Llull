/**
 * Portal frame analysis models: the 2D frames of a level (rafters in vertical planes y = const +
 * the columns under them) with their characteristic load cases.
 * @layer domain-aec
 * @pure
 */

export {
  WIND_CASES,
  WIND_PRESSURE_CASES,
  ROOF_PRESSURE_CASE_MIN_CPE,
  windCasesOf,
  craneCapacityOf,
  HOISTING_CLASSES,
  CRANE_FACTORS,
  craneActions,
  valleyLines,
  DOWNWIND_ROOF_FACTOR,
} from './frameModelTypes';
export type {
  LoadCase,
  WindCase,
  CaseLoads,
  AnalysisMember,
  NodeCaseLoad,
  FrameModel,
  FrameLoads,
  HoistingClass,
  CraneModel,
  CraneActions,
} from './frameModelTypes';
export { framesOf } from './frameModelFrames';
export { solveCombination, baseReactions } from './frameModelSolve';
export type { NodeForce, BaseReaction } from './frameModelSolve';
