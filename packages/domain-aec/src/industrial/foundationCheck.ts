/**
 * Foundation verification of portal-frame columns: pad footing soil bearing (Meyerhof effective
 * width), uplift (EQU), sliding, and base plate concrete bearing + anchor bolts.
 * @layer domain-aec
 */

export type { FoundationRow, ClayLayer, Factors, Combination } from './foundationModel';
export {
  combine,
  footingMoment,
  plateDemands,
  hasCase,
  ultimateCombinations,
  findFooting,
  findPlate,
} from './foundationCombinations';
export { clayLayerError, consolidationSettlement } from './foundationSettlement';
export {
  footingRows,
  groundSlabWeight,
  slidingHorizontalOf,
  defaultThrustTie,
} from './foundationRows';
export { SOIL_SHAPE, foundationCheck } from './foundationCheckRun';
export type { FoundationCheckParams } from './foundationCheckRun';
