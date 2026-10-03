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
import type { CommandDefinition, CommandResult, ParamsSchema } from './types';
import type { ExecutionContext } from './context';
import { currentContext, runInContext } from './context';
import { formatIssues } from './schema';
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
import { filletEdge, chamferEdge } from './modify3d';
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
import { createComponent, insertInstance, explodeInstance } from './assemblies';
import { clearDocument } from './document';
import { setCamera, lookAt, fitView } from './camera';
import { align, distribute, stackOn } from './place';
import { arrayAlongPath, distributeOnArc } from './array_along_path';
import { addConstraint, deleteConstraint, updateConstraint, solveConstraints } from './constraints';
import { addMate, billOfMaterials } from './mates';
import { addDriveRelation, deleteDriveRelation, evaluateMotion, bakeMotion } from './jointsDrive';
import { addJoint, deleteJoint, setJointValue } from './jointsEdit';
import { motionStudy } from './motion_study';
import { addSpurGear } from './gears';
import { distributeAlongPath } from './distribute';
import { deleteEntities } from './deleteMany';
import { derivationViolation } from './derivation';
import { onPluginInstalled, pluginGuards } from '../plugins/host';
import { moveEntities } from './moveMany';

function containsNonFinite(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value) && value.some((v) => v === undefined || v === null)) return true;
  return Object.values(value).some((v) => containsNonFinite(v, depth + 1));
}

/** A top-level 2-number `position` is a planar shorthand: pad z=0 (never mutates `params`). */
function padPlanarPosition(params: object): object {
  const position = (params as { position?: unknown }).position;
  const isPlanar =
    Array.isArray(position) &&
    position.length === 2 &&
    position.every((n) => typeof n === 'number');
  return isPlanar ? { ...params, position: [...position, 0] } : params;
}

/** Every entity carries a Vec3 `position`; a short/odd vector would poison downstream math. */
function hasMalformedPosition(entity: unknown): boolean {
  if (typeof entity !== 'object' || entity === null) return false;
  const position = (entity as { position?: unknown }).position;
  return position !== undefined && (!Array.isArray(position) || position.length !== 3);
}

/** Param keys whose string values are looked up as keys in document records (ids). */
const ID_LIKE_KEY = /^id$|Ids?$|^ids$/;

/**
 * True when an id-like param value is an Object.prototype key (`constructor`, `__proto__`, ...),
 * which would alias plain-object entity-bag lookups. Free text (names, content) is never scanned.
 */
function hasPrototypeIdKey(value: unknown, keyHint = '', depth = 0): boolean {
  if (typeof value === 'string') return ID_LIKE_KEY.test(keyHint) && value in Object.prototype;
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasPrototypeIdKey(v, keyHint, depth + 1));
  return Object.entries(value).some(([k, v]) => hasPrototypeIdKey(v, k, depth + 1));
}

const POSITION_CONTRACT = ' Format [x, y, z]; [x, y] is accepted and placed at z=0.';

/** Append the position contract so the agent-visible schema matches `padPlanarPosition`. */
function describePositionContract(schema: ParamsSchema): ParamsSchema {
  const position = schema.properties['position'];
  if (!position || position.type !== 'array') return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      position: { ...position, description: position.description + POSITION_CONTRACT },
    },
  };
}

function corruptionReason(entity: unknown): string | null {
  if (containsNonFinite(entity)) return 'non-finite numbers (NaN/Infinity/undefined components)';
  if (hasMalformedPosition(entity)) return 'a malformed position (must be a 3-number [x, y, z])';
  return null;
}

/**
 * @pure
 * @failure params fail `paramsValidator` (zod schema) -> no-op naming the failing path
 * @failure run throws (warned with stack), id-like params equal an Object.prototype key
 * (would alias entity-bag lookups), or affected entities contain NaN/Infinity/undefined vector
 * components or a non-Vec3 position -> no-op, affected:[]
 * @invariant non-object params are coerced to {} so field destructuring cannot throw;
 * a 2-number `position` is padded to [x, y, 0]; free-text params are never rejected
 */
function guardCommand(def: CommandDefinition<unknown>): CommandDefinition<unknown> {
  return {
    ...def,
    paramsSchema: describePositionContract(def.paramsSchema),
    run: (doc, params, ctx): CommandResult => {
      const safeParams = padPlanarPosition(
        typeof params === 'object' && params !== null ? params : {},
      );
      if (hasPrototypeIdKey(safeParams)) {
        return {
          document: doc,
          summary: `${def.name} rejected: an id param is a reserved JavaScript property name (e.g. constructor, __proto__, toString). Use a different id.`,
          affected: [],
        };
      }
      if (def.paramsValidator) {
        let checked: ReturnType<typeof def.paramsValidator.safeParse>;
        try {
          checked = def.paramsValidator.safeParse(safeParams, { reportInput: true });
        } catch (error) {
          console.warn(
            `[llull] command '${def.name}' params validation threw:`,
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          const reason = error instanceof Error ? error.message : String(error);
          return {
            document: doc,
            summary: `${def.name} rejected: invalid params — ${reason}`,
            affected: [],
          };
        }
        if (!checked.success) {
          return {
            document: doc,
            summary: `${def.name} rejected: invalid params — ${formatIssues(checked.error)}. Document unchanged.`,
            affected: [],
          };
        }
      }
      let result: CommandResult;
      try {
        result = def.run(doc, safeParams, ctx ?? currentContext());
      } catch (error) {
        console.warn(
          `[llull] command '${def.name}' threw:`,
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        const reason = error instanceof Error ? error.message : String(error);
        return {
          document: doc,
          summary: `${def.name} failed: ${reason}; document unchanged.`,
          affected: [],
        };
      }
      const violation = derivationViolation(pluginGuards(), def.name, doc, result.document);
      if (violation !== null) {
        return { document: doc, summary: violation, affected: [] };
      }
      if (result.document !== doc) {
        for (const id of result.affected) {
          const reason = corruptionReason(result.document.entities[id]);
          if (reason !== null) {
            return {
              document: doc,
              summary: `${def.name} rejected: result for ${id} contains ${reason}. Document unchanged.`,
              affected: [],
            };
          }
        }
      }
      return result;
    },
  };
}

// Using `unknown` for params here; each definition narrows its own type internally.
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
 * - Step-scoped ids: a recorded command runs as step `step-<n>` (n = doc.nextStepNumber)
 *   and mints `<prefix>-<n>.<k>`; replaying that step re-mints the same ids. An execute nested
 *   inside a running step joins it (same id source, no extra step).
 */
export function execute(
  doc: CadDocument,
  commandName: string,
  params: unknown,
  ctx: ExecutionContext = currentContext(),
): CommandResult {
  const def = byName.get(commandName);
  if (!def) {
    return { document: doc, summary: `Unknown command: ${commandName}`, affected: [] };
  }
  if (def.annotations?.requiresKernel === true && ctx.kernel === null) {
    return {
      document: doc,
      summary: `${commandName}: geometry kernel not available (still loading or not installed); document unchanged — retry once the kernel is ready.`,
      affected: [],
    };
  }
  const ann = def.annotations;
  const recordsStep = ann?.readOnly !== true && ann?.metaHistory !== true;
  if (!recordsStep || ctx.stepKey !== undefined) {
    // Queries, history meta-commands, and executes nested inside a running step append nothing.
    return runInContext(ctx, () => def.run(doc, params, ctx));
  }

  const stepNumber = doc.nextStepNumber ?? 1;
  const stepKey = String(stepNumber);
  const stepContext: ExecutionContext = { ...ctx, ids: stepIdSource(stepKey), stepKey };
  const result = runInContext(stepContext, () => def.run(doc, params, stepContext));

  // Only append when the document actually changed (pure mutation detection).
  if (result.document === doc) {
    return result;
  }

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
      const ann: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } =
        {};
      if (d.annotations.readOnly === true) ann.readOnlyHint = true;
      if (d.annotations.destructive === true) ann.destructiveHint = true;
      if (d.annotations.idempotent === true) ann.idempotentHint = true;
      if (Object.keys(ann).length > 0) schema.annotations = ann;
    }
    return schema;
  });
}
