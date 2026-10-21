/** Public API of the aerospace domain package: the plugins the composition root installs. */

// sheet metal plugin
export { sheetMetalPlugin } from './sheetmetal/plugin';

// fasteners plugin and the stack type the panels focus
export { fastenersPlugin } from './fasteners/plugin';
export { type FastenerStack } from './fasteners/types';

// aerodynamics plugin and the vortex-lattice model/kernel the native solver route runs
export { aerodynamicsPlugin } from './aerodynamics/plugin';
export { panelCount, solveBasis } from './aerodynamics/vlmKernel';
export {
  isVlmRefusal,
  resolveVortexLattice,
  VLM_NATIVE_PANEL_CAP,
  VLM_TS_PANEL_CAP,
  vortexLatticeData,
  vortexLatticeParams,
  type VortexLatticeModel,
} from './aerodynamics/vlmModel';

// surfacing plugin
export { surfacingPlugin } from './surfacing/plugin';

// composites plugin
export { compositesPlugin } from './composites/plugin';

// fluids plugin
export { fluidsPlugin } from './fluids/plugin';

// CFD plugin
export { cfdPlugin } from './cfd/plugin';
