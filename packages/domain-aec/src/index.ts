/**
 * Public API of the AEC domain package: the plugins the composition root installs
 * (`src/app/plugins.ts`) and the helpers the UI renders with.
 */

export { buildingPlugin } from './building/plugin';
export { industrialPlugin } from './industrial/plugin';
export { civilPlugin } from './civil/plugin';
export { buildPlanDrawing } from './building/drawings/planDrawing';
export { CATEGORY_LAYER } from './building/evaluate/entities';
export { buildingElementOf } from './building/evaluate/integrity';
export type { CostLine } from './building/quantities/costing';
