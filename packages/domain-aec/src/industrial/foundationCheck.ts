/**
 * Foundation verification of portal-frame columns: pad footing soil bearing (Meyerhof effective
 * width), uplift (EQU), sliding, and base plate concrete bearing + anchor bolts.
 * @layer core/commands/building/industrial
 */

export type { FoundationRow, ClayLayer, Factors, Combination } from './foundationModel';
export {
  combine,
  footingMoment,
  hasMoment,
  plateDemands,
  hasCase,
  ultimateCombinations,
  findFooting,
  findPlate,
} from './foundationCombinations';
export {
  clayLayerError,
  consolidationSettlement,
  footingSettlement,
  footingSettlementParts,
} from './foundationSettlement';
export {
  footingRows,
  groundSlabWeight,
  slidingHorizontalOf,
  defaultThrustTie,
} from './foundationRows';
export { checkFoundations, SOIL_SHAPE, foundationCheck } from './foundationCheckRun';
export type { FoundationCheckParams } from './foundationCheckRun';
