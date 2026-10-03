/**
 * Building (AEC / BIM) and industrial command sets, installed as plugins (see plugin.ts).
 * @layer domain-aec
 */

import type { CommandDefinition } from '@core/commands/types';
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
import { exportDxf } from './dxfExport';
import { exportPlanSheet } from './sheet';
import { exportElevationSheet } from './elevation';
import { exportIfc } from './ifcBuild';
import { addBuildingTemplate } from './templates';
import { addSlabOpening, deleteSlabOpening } from './slabOpenings';
import { listSteelProfiles } from './industrial/memberSupport';
import { addSteelMember, updateSteelMember } from './industrial/memberSteelCommands';
import { addFooting, addPanel } from './industrial/memberFootingPanelCommands';
import { addEquipment, addPipeRun } from './industrial/equipment';
import { addCraneRunway, addPortalFrameBuilding } from './industrial/portal';
import { checkClashes } from './industrial/clash';
import { addCableTray } from './industrial/trays';
import { addBasePlates } from './industrial/plates';
import { addCurvedWall } from './curvedWalls';
import { setWallLayers } from './wallLayers';
import { addMomentConnections } from './industrial/connections';
import { checkPortalFrames } from './industrial/frameCheckPortal';
import { designPortalFrames } from './industrial/frameDesign';
import { checkBracing } from './industrial/bracingCheckRun';
import { foundationCheck } from './industrial/foundationCheckRun';
import { designFootings } from './industrial/footingDesignCommand';
import { exportNcFiles } from './industrial/ncExport';
import { checkPurlins } from './industrial/purlinCheckRun';
import { designPurlins } from './industrial/purlinDesign';
import { exportAnchorPlan } from './industrial/anchorPlanExport';
import { runwayCheck } from './industrial/runwayCheckRun';
import { quantityTakeoff, buildingSchedule, setCostRates, estimateCost } from './takeoff';

/** AEC / BIM commands (levels, walls, openings, slabs, sheets, IFC, takeoff). */
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
  addCurvedWall,
  setWallLayers,
] as ReadonlyArray<CommandDefinition<unknown>>;

/** Industrial-steel commands (portal frames, members, checks, fabrication). */
export const industrialCommands = [
  listSteelProfiles,
  addSteelMember,
  updateSteelMember,
  addFooting,
  addPanel,
  addEquipment,
  addPipeRun,
  addCableTray,
  addBasePlates,
  addMomentConnections,
  checkPortalFrames,
  designPortalFrames,
  checkBracing,
  foundationCheck,
  designFootings,
  exportNcFiles,
  checkPurlins,
  designPurlins,
  exportAnchorPlan,
  runwayCheck,
  addCraneRunway,
  addPortalFrameBuilding,
  checkClashes,
] as ReadonlyArray<CommandDefinition<unknown>>;
export { type PlanPrimitive } from './planModel';
export { buildPlanDrawing } from './planDrawing';
export { CATEGORY_LAYER } from './entities';
export { fromMm } from './model';
export { buildingElementOf } from './integrity';
export type { CostLine } from './costing';
