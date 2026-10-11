/**
 * Building (AEC / BIM) and industrial command sets, installed as plugins (see plugin.ts).
 * @layer domain-aec
 */

import { commandCatalog } from '@core/commands/schema';
import {
  addLevel,
  updateLevel,
  deleteLevel,
  setActiveLevel,
  setProjectInfo,
  describeBuilding,
} from './building/elements/levels';
import { addGridLine, addGridSystem } from './building/elements/grid';
import { addWall, drawWalls, updateWall } from './building/elements/walls';
import { addDoor, addWindow, updateOpening } from './building/elements/openings';
import { addSlab, addColumn, addBeam, addStair } from './building/elements/structure';
import {
  addRoom,
  deleteBuildingElement,
  moveBuildingElement,
  copyLevelElements,
} from './building/elements/elements';
import { exportDxf } from './building/exchange/dxfExport';
import { exportPlanSheet } from './building/drawings/sheet';
import { exportElevationSheet } from './building/drawings/elevation';
import { exportIfc } from './building/exchange/ifcBuild';
import { addBuildingTemplate } from './building/templates';
import { addSlabOpening, deleteSlabOpening } from './building/elements/slabOpenings';
import { listSteelProfiles } from './steel/steelProfileList';
import { addSteelMember, updateSteelMember } from './industrial/framing/memberSteelCommands';
import {
  addGridBeams,
  addGridBracing,
  addGridColumns,
} from './industrial/framing/gridFramingCommands';
import { addEquipmentOpenings } from './industrial/equipment/equipmentOpenings';
import { addFooting, addPanel } from './industrial/framing/memberFootingPanelCommands';
import { addEquipment, addPipeRun } from './industrial/equipment/equipment';
import { updateEquipment } from './industrial/equipment/equipmentUpdate';
import { addCraneRunway, addPortalFrameBuilding } from './industrial/portal/portal';
import { checkClashes } from './industrial/clash/clash';
import { addCableTray } from './industrial/piping/trays';
import { addBasePlates } from './industrial/connections/plates';
import { addCurvedWall } from './building/elements/curvedWalls';
import { setWallLayers } from './building/elements/wallLayers';
import { addMomentConnections } from './industrial/connections/connections';
import { checkPortalFrames } from './industrial/frames/frameCheckPortal';
import { designPortalFrames } from './industrial/frames/frameDesign';
import { checkBracing } from './industrial/bracing/bracingCheckRun';
import { foundationCheck } from './industrial/foundations/foundationCheckRun';
import { designFootings } from './industrial/foundations/footingDesignCommand';
import { exportNcFiles } from './industrial/fabrication/ncExport';
import { checkPurlins } from './industrial/purlins/purlinCheckRun';
import { designPurlins } from './industrial/purlins/purlinDesign';
import { exportAnchorPlan } from './industrial/anchorPlan/anchorPlanExport';
import { runwayCheck } from './industrial/runway/runwayCheckRun';
import { checkSteelMembers } from './industrial/steelDesign/steelMembersCheck';
import { addPipeSupport } from './industrial/piping/pipeSupports';
import { checkPipeSupports } from './industrial/piping/pipeSupportCheck';
import {
  quantityTakeoff,
  buildingSchedule,
  setCostRates,
  estimateCost,
} from './building/quantities/takeoff';

/** AEC / BIM commands (levels, walls, openings, slabs, sheets, IFC, takeoff). */
export const buildingCommands = commandCatalog(
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
);

/** Industrial-steel commands (portal frames, members, checks, fabrication). */
export const industrialCommands = commandCatalog(
  listSteelProfiles,
  addSteelMember,
  updateSteelMember,
  addGridColumns,
  addGridBeams,
  addGridBracing,
  addFooting,
  addPanel,
  addEquipment,
  updateEquipment,
  addEquipmentOpenings,
  addPipeRun,
  addPipeSupport,
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
  checkSteelMembers,
  checkPipeSupports,
  addCraneRunway,
  addPortalFrameBuilding,
  checkClashes,
);
export { type PlanPrimitive } from './building/drawings/planModel';
export { buildPlanDrawing } from './building/drawings/planDrawing';
export { CATEGORY_LAYER } from './building/evaluate/entities';
export { fromMm } from './building/model';
export { buildingElementOf } from './building/evaluate/integrity';
export type { CostLine } from './building/quantities/costing';
