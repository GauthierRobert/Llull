/**
 * @layer core/commands
 * The registry: the composition point that fills the command table with the core catalog and
 * every installed plugin's commands. UI menus, MCP tool schemas (`toToolSchemas`) and `execute`
 * all read that table — register once, every surface gains it. Surfaces import from this module
 * so that importing the API also guarantees the core catalog is registered.
 */

import type { CommandDefinition } from './types';
import { registerCommands } from './commandTable';
import { addWedge, addPyramid } from './solids/prismatic';
import { addCylinder, addSphere, addCone, addTorus } from './solids/round';
import { addBox, extrude, move, deleteEntity } from './solids/basic';
import { rotateEntity, scaleEntity, mirrorEntity, arrayLinear, arrayPolar } from './edit/transform';
import { drawBeltAround } from './draw2d/belt';
import { drawEllipse, drawSpline, drawInvolute } from './draw2d/curves';
import {
  drawLine,
  drawPolyline,
  drawArc,
  drawCircle,
  drawRectangle,
  drawPoint,
} from './draw2d/basic';
import { loadDocument } from './persistence/serialization';
import { extrudeSketch, revolveProfile } from './solids/profile';
import { duplicateEntity, groupEntities, ungroupEntities, setEntityName } from './edit/basic';
import { booleanUnion, booleanSubtract, booleanIntersect } from './brep/boolean';
import { describeScene } from './inspect/scene';
import { animateSpin, animateOscillate, stopAnimation } from './motion/animation';
import { findEntities } from './inspect/query';
import { buildProject } from './project/buildProject';
import { setUnits } from './document/units';
import { setParameter, deleteParameter } from './parametric/parameters';
import { checkModel } from './inspect/checkModel';
import { renderView } from './render/renderView';
import { makeTubeBetween } from './solids/composite';
import { addText, addDimension } from './draw2d/annotate';
import { filletEdge, chamferEdge, shellSolid } from './brep/modify3d';
import { inspectTopology, exportStepExact } from './brep/topology';
import { instantiateTemplate } from './project/templates';
import { historyCommands } from './history/history';
import { createConfiguration, activateConfiguration } from './parametric/configurations';
import { createMaterial, assignMaterial } from './document/materials';
import { saveRecipe, instantiateRecipe } from './parametric/recipes';
import { fillet2D, chamfer2D } from './modify2d/corners';
import { trim, extend } from './modify2d/trimExtend';
import { explodePolyline, offset2D } from './modify2d/basic';
import {
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
} from './document/layers';
import { measureBoundingBox, measureVolume, massProperties } from './inspect/measureSolid';
import { measureArea, measurePerimeter } from './inspect/measureAreaPerimeter';
import { measureDistance, measureAngle } from './inspect/measureDistanceAngle';
import { exportStl } from './exchange/exportStl';
import { exportObj, exportGltf } from './exchange/exportFormats';
import { exportCode } from './exchange/exportCode';
import { applyCodeTrace } from './exchange/codeTrace';
import { importMesh } from './exchange/importMesh';
import { importDxf } from './exchange/importDxf';
import { createComponent, insertInstance, explodeInstance } from './assembly/assemblies';
import { clearDocument } from './document/clearDocument';
import { setCamera, lookAt, fitView } from './document/camera';
import { align, distribute, stackOn } from './edit/place';
import { arrayAlongPath, distributeOnArc } from './edit/arrayAlongPath';
import {
  addConstraint,
  deleteConstraint,
  updateConstraint,
  solveConstraints,
} from './parametric/constraints';
import { addMate } from './assembly/mates';
import { billOfMaterials } from './assembly/billOfMaterials';
import {
  addDriveRelation,
  deleteDriveRelation,
  evaluateMotion,
  bakeMotion,
} from './motion/jointsDrive';
import { addJoint, deleteJoint, setJointValue } from './motion/jointsEdit';
import { motionStudy } from './motion/motionStudy';
import { addSpurGear } from './solids/gears';
import { distributeAlongPath } from './edit/distribute';
import { deleteEntities, duplicateEntities, moveEntities } from './edit/batch';
import { onPluginInstalled } from '../plugins/host';

const coreCommands = [
  addBox,
  addCylinder,
  addSphere,
  addCone,
  addTorus,
  addWedge,
  addPyramid,
  extrude,
  move,
  deleteEntity,
  rotateEntity,
  scaleEntity,
  mirrorEntity,
  arrayLinear,
  arrayPolar,
  drawLine,
  drawPolyline,
  drawArc,
  drawCircle,
  drawRectangle,
  drawPoint,
  drawEllipse,
  drawSpline,
  loadDocument,
  extrudeSketch,
  revolveProfile,
  duplicateEntity,
  groupEntities,
  ungroupEntities,
  setEntityName,
  findEntities,
  booleanUnion,
  booleanSubtract,
  booleanIntersect,
  describeScene,
  buildProject,
  setUnits,
  measureDistance,
  measureAngle,
  measureArea,
  measurePerimeter,
  measureBoundingBox,
  measureVolume,
  massProperties,
  setParameter,
  deleteParameter,
  checkModel,
  explodePolyline,
  offset2D,
  trim,
  extend,
  fillet2D,
  chamfer2D,
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
  animateSpin,
  animateOscillate,
  stopAnimation,
  renderView,
  makeTubeBetween,
  addText,
  addDimension,
  filletEdge,
  chamferEdge,
  shellSolid,
  inspectTopology,
  exportStepExact,
  instantiateTemplate,
  ...historyCommands,
  createConfiguration,
  activateConfiguration,
  createMaterial,
  assignMaterial,
  exportStl,
  exportObj,
  exportGltf,
  exportCode,
  applyCodeTrace,
  importMesh,
  importDxf,
  saveRecipe,
  instantiateRecipe,
  createComponent,
  insertInstance,
  explodeInstance,
  clearDocument,
  setCamera,
  lookAt,
  fitView,
  align,
  distribute,
  stackOn,
  arrayAlongPath,
  distributeOnArc,
  addConstraint,
  deleteConstraint,
  updateConstraint,
  solveConstraints,
  addMate,
  billOfMaterials,
  addJoint,
  deleteJoint,
  setJointValue,
  addDriveRelation,
  deleteDriveRelation,
  evaluateMotion,
  bakeMotion,
  motionStudy,
  addSpurGear,
  drawInvolute,
  drawBeltAround,
  distributeAlongPath,
  deleteEntities,
  moveEntities,
  duplicateEntities,
] as ReadonlyArray<CommandDefinition<unknown>>;

registerCommands('core', coreCommands);
onPluginInstalled((plugin) => registerCommands(`plugin '${plugin.name}'`, plugin.commands));

export { execute } from './execute';
export { getCommand, listCommands, toToolSchemas, type ToolSchema } from './commandTable';
