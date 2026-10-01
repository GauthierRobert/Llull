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
import { exportIfc } from './ifc';
import { addBuildingTemplate } from './templates';
import { addSlabOpening, deleteSlabOpening } from './slabOpenings';
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
  exportIfc,
  addBuildingTemplate,
] as ReadonlyArray<CommandDefinition<unknown>>;
