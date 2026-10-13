/**
 * Building (AEC / BIM) commands — levels, walls, openings, slabs, sheets, IFC, takeoff — the
 * `building` plugin's catalog (see plugin.ts).
 */

import { commandCatalog } from '@core/commands/schema';
import { addLevel, updateLevel, deleteLevel, setActiveLevel, setProjectInfo, describeBuilding } from './elements/levels';
import { addGridLine, addGridSystem } from './elements/grid';
import { drawWalls, updateWall } from './elements/walls';
import { addDoor, addWindow, updateOpening } from './elements/openings';
import { addSlab, addColumn, addBeam, addStair } from './elements/structure';
import { addRoom, deleteBuildingElement, moveBuildingElement, copyLevelElements } from './elements/elements';
import { exportDxf } from './exchange/dxfExport';
import { exportPlanSheet } from './drawings/sheet';
import { exportElevationSheet } from './drawings/elevation';
import { exportIfc } from './exchange/ifcBuild';
import { addBuildingTemplate } from './templates';
import { addSlabOpening, deleteSlabOpening } from './elements/slabOpenings';
import { addCurvedWall } from './elements/curvedWalls';
import { setWallLayers } from './elements/wallLayers';
import { quantityTakeoff, buildingSchedule, setCostRates, estimateCost } from './quantities/takeoff';

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
