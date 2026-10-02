/**
 * Portal frame verification: 2D frame analysis of every frame under the EN 1990 combinations of
 * dead, snow, wind and crane actions (global imperfections, Horne αcr and amplified moments),
 * EN 1993 member checks (cross-section, flexural buckling), moment connection bolt checks and
 * SLS deflections.
 * @layer core/commands/building/industrial
 */

export { connectionCheck } from './frameCheckSolve';
export type { CheckRow } from './frameCheckSolve';
export { checkFrames } from './frameCheckFrames';
export {
  FRAME_LOAD_SHAPE,
  resolveFrameLoads,
  describeLoads,
  checkPortalFrames,
} from './frameCheckPortal';
export type { FrameLoadParams } from './frameCheckPortal';
