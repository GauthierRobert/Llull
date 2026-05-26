/**
 * Command registry.
 *
 * The registry is what makes "define once, use everywhere" work. Register a
 * command here and it is instantly available to:
 *   - the UI (iterate the registry to build menus)
 *   - the AI bridge (generate tool schemas via `toToolSchemas`)
 *   - the MCP server (same schemas, served over the wire)
 */

import type { CadDocument, FeatureStep } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
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
import { historyCommands, setRegistryRef } from './history';
import { createConfiguration, activateConfiguration, setConfigRegistryRef } from './configurations';
import { createMaterial, assignMaterial } from './materials';
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
  ...historyCommands,
  createConfiguration,
  activateConfiguration,
  createMaterial,
  assignMaterial,
] as ReadonlyArray<CommandDefinition<unknown>>;

const byName = new Map<string, CommandDefinition<unknown>>(
  definitions.map((d) => [d.name, d]),
);

// Wire up the late-bound references so history.ts and configurations.ts can call
// getCommand without a circular import at module load time.
setRegistryRef((name) => byName.get(name));
setConfigRegistryRef((name) => byName.get(name));

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
 *
 * Feature history append rules (architecture L8):
 * - If the command is read-only (`annotations.readOnly`) it returns the same
 *   doc reference — no step is appended.
 * - If the command is flagged `annotations.metaHistory` no step is appended.
 *   This covers two cases: history meta-commands (which edit the history list
 *   itself — appending would recurse) and parameter-table commands
 *   (`set_parameter`/`delete_parameter`), whose effect is document INPUT state,
 *   not a replayable geometry step (L8). Their current values are carried into
 *   replay via `base.parameters` in `replayHistory`.
 * - Otherwise, when the returned document reference differs from the input
 *   (i.e. the command actually mutated the document), a FeatureStep is
 *   appended to the new document's featureHistory.
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
  const result = def.run(doc, params);

  // Skip history append for read-only queries and history meta-commands.
  const ann = def.annotations;
  const isReadOnly = ann?.readOnly === true;
  const isMetaHistory = ann?.metaHistory === true;
  if (isReadOnly || isMetaHistory) {
    return result;
  }

  // Only append when the document actually changed (pure mutation detection).
  if (result.document === doc) {
    return result;
  }

  const step: FeatureStep = {
    id: nextId('step'),
    name: commandName,
    params,
    suppressed: false,
  };

  return {
    ...result,
    document: {
      ...result.document,
      featureHistory: [...result.document.featureHistory, step],
    },
  };
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
