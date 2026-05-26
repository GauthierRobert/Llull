/**
 * Command registry.
 *
 * The registry is what makes "define once, use everywhere" work. Register a
 * command here and it is instantly available to:
 *   - the UI (iterate the registry to build menus)
 *   - the AI bridge (generate tool schemas via `toToolSchemas`)
 *   - the MCP server (same schemas, served over the wire)
 */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { addBox, addCylinder, addSphere, addCone, addTorus, addWedge, addPyramid, extrude, move, deleteEntity } from './geometry';
import { rotateEntity, scaleEntity, mirrorEntity, arrayLinear, arrayPolar } from './transform';
import { drawLine, drawPolyline, drawArc, drawCircle, drawRectangle, drawPoint, drawEllipse, drawSpline } from './draw2d';
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
import { filletEdge, chamferEdge } from './modify3d';
import {
  explodePolyline,
  offset2D,
  trim,
  extend,
  fillet2D,
  chamfer2D,
} from './modify2d';
import {
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
} from './layers';
import {
  measureDistance,
  measureAngle,
  measureArea,
  measurePerimeter,
  measureBoundingBox,
  measureVolume,
  massProperties,
} from './measure';

// Using `unknown` for params here; each definition narrows its own type internally.
const definitions = [
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
] as ReadonlyArray<CommandDefinition<unknown>>;

const byName = new Map<string, CommandDefinition<unknown>>(
  definitions.map((d) => [d.name, d]),
);

export function listCommands(): ReadonlyArray<CommandDefinition<unknown>> {
  return definitions;
}

export function getCommand(name: string): CommandDefinition<unknown> | undefined {
  return byName.get(name);
}

/**
 * The single entry point every surface calls. Validates the command exists,
 * runs it, and returns the result. This is the choke point where you'd add
 * logging, undo-stack push, permission checks, etc.
 */
export function execute(
  doc: CadDocument,
  commandName: string,
  params: unknown,
): CommandResult {
  const def = byName.get(commandName);
  if (!def) {
    return { document: doc, summary: `Unknown command: ${commandName}`, affected: [] };
  }
  return def.run(doc, params);
}

/** Generate AI/MCP tool schemas from the registry. */
export function toToolSchemas(): Array<{
  name: string;
  description: string;
  input_schema: CommandDefinition<unknown>['paramsSchema'];
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}> {
  return definitions.map((d) => {
    const schema: {
      name: string;
      description: string;
      input_schema: CommandDefinition<unknown>['paramsSchema'];
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
      };
    } = {
      name: d.name,
      description: d.description,
      input_schema: d.paramsSchema,
    };
    if (d.annotations) {
      const ann: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {};
      if (d.annotations.readOnly === true) ann.readOnlyHint = true;
      if (d.annotations.destructive === true) ann.destructiveHint = true;
      if (d.annotations.idempotent === true) ann.idempotentHint = true;
      if (Object.keys(ann).length > 0) schema.annotations = ann;
    }
    return schema;
  });
}
