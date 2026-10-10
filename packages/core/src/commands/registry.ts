/**
 * @layer core/commands
 * The registry: core `definitions` + every installed plugin's commands. UI menus, MCP tool
 * schemas (`toToolSchemas`) and `execute` all read it — register once, every surface gains it.
 */

import type { CadDocument, FeatureStep } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { type ExecutionContext, currentContext, runInContext } from './context';
import { guardCommand } from './guard';
import { kernelUnavailable } from './kernelRefusal';
import { rejection } from './noop';
import { stepIdSource } from '../lib/id';
import { addWedge, addPyramid } from './geometryPrismatic';
import { addCylinder, addSphere, addCone, addTorus } from './geometryRound';
import { addBox, extrude, move, deleteEntity } from './geometryBasic';
import { rotateEntity, scaleEntity, mirrorEntity, arrayLinear, arrayPolar } from './transform';
import { drawBeltAround } from './draw2dBelt';
import { drawEllipse, drawSpline, drawInvolute } from './draw2dCurves';
import {
  drawLine,
  drawPolyline,
  drawArc,
  drawCircle,
  drawRectangle,
  drawPoint,
} from './draw2dBasic';
import { loadDocument } from './persistence';
import { extrudeSketch, revolveProfile } from './profile';
import { duplicateEntity, groupEntities, ungroupEntities, setEntityName } from './edit';
import { booleanUnion, booleanSubtract, booleanIntersect } from './boolean';
import { describeScene } from './scene';
import { animateSpin, animateOscillate, stopAnimation } from './animation';
import { findEntities } from './query';
import { buildProject } from './project';
import { setUnits } from './units';
import { setParameter, deleteParameter } from './parameters';
import { checkModel } from './check';
import { renderView } from './render';
import { makeTubeBetween } from './composite';
import { addText, addDimension } from './annotate';
import { filletEdge, chamferEdge, shellSolid } from './modify3d';
import { inspectTopology, exportStepExact } from './brep';
import { instantiateTemplate } from './templates';
import { historyCommands } from './history';
import { createConfiguration, activateConfiguration } from './configurations';
import { createMaterial, assignMaterial } from './materials';
import { saveRecipe, instantiateRecipe } from './recipes';
import { fillet2D, chamfer2D } from './modify2dCorners';
import { trim, extend } from './modify2dTrimExtend';
import { explodePolyline, offset2D } from './modify2dBasic';
import {
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
} from './layers';
import { measureBoundingBox, measureVolume, massProperties } from './measureSolid';
import { measureArea, measurePerimeter } from './measureAreaPerimeter';
import { measureDistance, measureAngle } from './measureDistanceAngle';
import { exportStl } from './export';
import { exportObj, exportGltf } from './export_formats';
import { exportCode } from './code_exchange';
import { applyCodeTrace } from './code_trace';
import { importMesh } from './import_mesh';
import { importDxf } from './import_dxf';
import { createComponent, insertInstance, explodeInstance } from './assemblies';
import { clearDocument } from './document';
import { setCamera, lookAt, fitView } from './camera';
import { align, distribute, stackOn } from './place';
import { arrayAlongPath, distributeOnArc } from './array_along_path';
import { addConstraint, deleteConstraint, updateConstraint, solveConstraints } from './constraints';
import { addMate } from './mates';
import { billOfMaterials } from './billOfMaterials';
import { addDriveRelation, deleteDriveRelation, evaluateMotion, bakeMotion } from './jointsDrive';
import { addJoint, deleteJoint, setJointValue } from './jointsEdit';
import { motionStudy } from './motion_study';
import { addSpurGear } from './gears';
import { distributeAlongPath } from './distribute';
import { deleteEntities, duplicateEntities, moveEntities } from './batch';
import { onPluginInstalled } from '../plugins/host';

const rawDefinitions = [
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

/** Core commands, then every installed plugin's commands in installation order. */
const definitions: CommandDefinition<unknown>[] = rawDefinitions.map(guardCommand);

const byName = new Map<string, CommandDefinition<unknown>>(definitions.map((d) => [d.name, d]));

onPluginInstalled((plugin) => {
  const names = plugin.commands.map((command) => command.name);
  const clash = plugin.commands.find(
    (command, index) => byName.has(command.name) || names.indexOf(command.name) !== index,
  );
  if (clash) {
    throw new Error(`plugin '${plugin.name}': command '${clash.name}' is already registered`);
  }
  for (const command of plugin.commands) {
    const guarded = guardCommand(command);
    definitions.push(guarded);
    byName.set(guarded.name, guarded);
  }
});

export function listCommands(): ReadonlyArray<CommandDefinition<unknown>> {
  return definitions;
}

export function getCommand(name: string): CommandDefinition<unknown> | undefined {
  return byName.get(name);
}

/**
 * The single choke point every surface calls (architecture L5, L8).
 * @invariant a mutating command (not `readOnly` / `metaHistory`) that changes the document appends
 * FeatureStep `step-<n>` (n = doc.nextStepNumber) and mints ids `<prefix>-<n>.<k>`, so replay
 * re-mints identical ids; an execute nested inside a running step joins it (no extra step)
 * @failure unknown command, or `requiresKernel` while ctx.kernel is null -> no-op, affected:[], rejected:true
 */
export function execute(
  doc: CadDocument,
  commandName: string,
  params: unknown,
  ctx: ExecutionContext = currentContext(),
): CommandResult {
  const def = byName.get(commandName);
  if (!def) return rejection(doc, `Unknown command: ${commandName}`);
  const annotations = def.annotations;
  if (annotations?.requiresKernel === true && ctx.kernel === null)
    return rejection(doc, kernelUnavailable(commandName));
  const recordsStep = annotations?.readOnly !== true && annotations?.metaHistory !== true;
  if (!recordsStep || ctx.stepKey !== undefined) {
    // Queries, history meta-commands, and executes nested inside a running step append nothing.
    return runInContext(ctx, () => def.run(doc, params, ctx));
  }

  const stepNumber = doc.nextStepNumber ?? 1;
  const stepKey = String(stepNumber);
  const stepContext: ExecutionContext = { ...ctx, ids: stepIdSource(stepKey), stepKey };
  const result = runInContext(stepContext, () => def.run(doc, params, stepContext));

  if (result.document === doc) return result;

  const step: FeatureStep = {
    id: `step-${stepKey}`,
    name: commandName,
    params,
    suppressed: false,
    affected: result.affected,
  };

  return {
    ...result,
    document: {
      ...result.document,
      featureHistory: [...result.document.featureHistory, step],
      nextStepNumber: Math.max(result.document.nextStepNumber ?? 1, stepNumber + 1),
    },
  };
}

/** One registry entry as an AI/MCP tool schema. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: CommandDefinition<unknown>['paramsSchema'];
  annotations?: { readOnlyHint?: true; destructiveHint?: true; idempotentHint?: true };
}

function toolAnnotations(def: CommandDefinition<unknown>): ToolSchema['annotations'] {
  const ann: NonNullable<ToolSchema['annotations']> = {};
  if (def.annotations?.readOnly === true) ann.readOnlyHint = true;
  if (def.annotations?.destructive === true) ann.destructiveHint = true;
  if (def.annotations?.idempotent === true) ann.idempotentHint = true;
  return Object.keys(ann).length > 0 ? ann : undefined;
}

/** Generate AI/MCP tool schemas from the registry. */
export function toToolSchemas(): ToolSchema[] {
  return definitions.map((d) => {
    const annotations = toolAnnotations(d);
    return {
      name: d.name,
      description: d.description,
      input_schema: d.paramsSchema,
      ...(annotations ? { annotations } : {}),
    };
  });
}
