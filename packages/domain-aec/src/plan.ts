/**
 * Pure floor-plan drawing of one level: a horizontal cut (default 1.2 m above the floor) of the
 * building model, as neutral 2D primitives consumed by the DXF and SVG sheet writers.
 * Coordinates are model plan coordinates in document units.
 * @layer domain-aec
 * @pure
 */

export { DIMENSION_LAYER } from './planModel';
export type { PlanStyle, PlanFill, PlanPrimitive, PlanDrawing, PlanSource } from './planModel';
export { boundsOf, dimensionLabel } from './planArchitectural';
export { buildPlanDrawing } from './planDrawing';
