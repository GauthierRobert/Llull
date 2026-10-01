/**
 * Building (AEC / BIM) command set, appended to the registry.
 * @layer core/commands/building
 */

import type { CommandDefinition } from '../types';
import {
  addLevel,
  updateLevel,
  deleteLevel,
  setActiveLevel,
  setProjectInfo,
  describeBuilding,
} from './levels';
import { addGridLine, addGridSystem } from './grid';
import { addWall, drawWalls, updateWall } from './walls';
import { addDoor, addWindow, updateOpening } from './openings';
import { addSlab, addColumn, addBeam, addStair } from './structure';
import { addRoom, deleteBuildingElement, moveBuildingElement, copyLevelElements } from './elements';
import { exportDxf } from './dxf';
import { exportPlanSheet } from './sheet';
import { exportElevationSheet } from './elevation';
import { exportIfc } from './ifc';
import { addBuildingTemplate } from './templates';
import { addSlabOpening, deleteSlabOpening } from './slabOpenings';
import {
  addFooting,
  addPanel,
  addSteelMember,
  listSteelProfiles,
  updateSteelMember,
} from './industrial/members';
import { addEquipment, addPipeRun } from './industrial/equipment';
import { addCraneRunway, addPortalFrameBuilding } from './industrial/portal';
import { checkClashes } from './industrial/clash';
import { addCableTray } from './industrial/trays';
import { addBasePlates } from './industrial/plates';
import { addCurvedWall } from './curvedWalls';
import { setWallLayers } from './wallLayers';
import { quantityTakeoff, buildingSchedule, setCostRates, estimateCost } from './takeoff';

export const buildingCommands = [
  addLevel,
  updateLevel,
  deleteLevel,
  setActiveLevel,
  setProjectInfo,
  describeBuilding,
  addGridLine,
  addGridSystem,
  addWall,
  drawWalls,
  updateWall,
  addDoor,
  addWindow,
  updateOpening,
  addSlab,
  addColumn,
  addBeam,
  addStair,
  addSlabOpening,
  deleteSlabOpening,
  addRoom,
  deleteBuildingElement,
  moveBuildingElement,
  copyLevelElements,
  quantityTakeoff,
  buildingSchedule,
  setCostRates,
  estimateCost,
  exportDxf,
  exportPlanSheet,
  exportElevationSheet,
  exportIfc,
  addBuildingTemplate,
  listSteelProfiles,
  addSteelMember,
  updateSteelMember,
  addFooting,
  addPanel,
  addEquipment,
  addPipeRun,
  addCableTray,
  addBasePlates,
  addCurvedWall,
  setWallLayers,
  addCraneRunway,
  addPortalFrameBuilding,
  checkClashes,
] as ReadonlyArray<CommandDefinition<unknown>>;

/** Public read-only building API for the UI (plans, layers, quantities, integrity). */
export { buildPlanDrawing, type PlanPrimitive } from './plan';
export { CATEGORY_LAYER } from './evaluate';
export { fromMm } from './model';
export { buildingElementOf } from './integrity';
export type { CostLine } from './quantities';
