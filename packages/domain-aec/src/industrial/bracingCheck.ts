/**
 * Wind bracing check of a steel hall: longitudinal wind on the gables → roof X-bracing → wall
 * X-bracing (tension-only diagonals), compression struts and gable wind posts.
 * @layer domain-aec
 */

export { craneWallForce } from './bracingModel';
export type { CraneWallForce, BracingRow } from './bracingModel';
export { checkBracing } from './bracingCheckRun';
