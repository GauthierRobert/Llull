import { type Component, type JointKind, CONSTRAINT_KINDS } from '../../model/types';
import { isStringArray } from '../../lib/isStringArray';
import { findComponentCycle } from '../assembly/assemblies';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { isReservedKey } from '../../lib/reservedKey';
import { documentExtensions } from '../../plugins/host';
import { corruptionReason } from '../guard';
import { getCommand, listCommands } from '../commandTable';
import { validateAnimationValue, validateComponentValue, validateConfigurationValue, validateGroupValue } from './collections';
import { drawingsProblems } from './drawingsValidation';
import { pmiProblems } from './pmiValidation';
import { exchangeProblems } from './exchangeValidation';
import { dynamicsProblems } from './dynamicsValidation';
import { prototypeProblems } from './prototypeValidation';
import { reviewProblems } from './reviewValidation';
import { displayProblems } from './displayValidation';
import { kernelSliceProblems } from './kernelValidation';
import { validateCamera, validateLayer, validateEntityValue, validateMaterialValue, validateParameterValue } from './guards';
import { materialLibraryProblems } from './materialRecordValidation';
import { mechanismProblems } from './mechanismValidation';
import { sketchPlaneProblems } from './sketchPlaneValidation';

const VALID_CONSTRAINT_KINDS: ReadonlySet<string> = new Set(CONSTRAINT_KINDS);

/** All legal joint kinds (must stay in sync with JointKind union in types.ts). */
const VALID_JOINT_KINDS: ReadonlySet<string> = new Set<JointKind>([
  'revolute',
  'prismatic',
  'rigid',
  'cylindrical',
  'pin_slot',
  'planar',
  'ball',
  'cam',
]);

function validateJointMateRef(id: string, field: string, v: unknown): string | null {
  if (!isRecord(v)) return `joint '${id}': ${field} must be an object`;
  if (typeof v['instanceId'] !== 'string' || (v['instanceId'] as string).length === 0)
    return `joint '${id}': ${field}.instanceId must be a non-empty string`;
  const f = v['frame'];
  if ('frame' in v && f !== 'origin' && f !== 'axis-x' && f !== 'axis-y' && f !== 'axis-z')
    return `joint '${id}': ${field}.frame must be origin|axis-x|axis-y|axis-z, got '${String(f)}'`;
  return null;
}

function validateJointAxis(id: string, axis: unknown): string | null {
  if (axis === 'x' || axis === 'y' || axis === 'z' || isVec3(axis)) return null;
  return `joint '${id}': axis must be 'x', 'y', 'z', or a [x,y,z] finite-number array, got ${JSON.stringify(axis)}`;
}

function validateJointValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `joint '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `joint '${id}': id field must be a string`;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !VALID_JOINT_KINDS.has(kind))
    return `joint '${id}': unknown kind '${String(kind)}'. Allowed: ${[...VALID_JOINT_KINDS].join(', ')}.`;
  const refErr = validateJointMateRef(id, 'a', v['a']) ?? validateJointMateRef(id, 'b', v['b']) ?? validateJointAxis(id, v['axis']);
  if (refErr !== null) return refErr;
  if (kind === 'revolute') return isFiniteNumber(v['angle']) ? null : `joint '${id}' (revolute): angle must be a finite number`;
  if (kind === 'prismatic')
    return isFiniteNumber(v['displacement']) ? null : `joint '${id}' (prismatic): displacement must be a finite number`;
  const values = v['values'];
  return Array.isArray(values) && values.every(isFiniteNumber)
    ? null
    : `joint '${id}' (${kind}): values must be an array of finite numbers`;
}

function validateDriveRelationValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `driveRelation '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `driveRelation '${id}': id field must be a string`;
  if (typeof v['driver'] !== 'string' || (v['driver'] as string).length === 0)
    return `driveRelation '${id}': driver must be a non-empty string`;
  if (typeof v['driven'] !== 'string' || (v['driven'] as string).length === 0)
    return `driveRelation '${id}': driven must be a non-empty string`;
  if (!isFiniteNumber(v['ratio'])) return `driveRelation '${id}': ratio must be a finite number`;
  if (v['offset'] !== undefined && !isFiniteNumber(v['offset']))
    return `driveRelation '${id}': offset must be a finite number when present`;
  return null;
}

function validateConstraintValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `constraint '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `constraint '${id}': id field must be a string`;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !VALID_CONSTRAINT_KINDS.has(kind)) return `constraint '${id}': unknown kind '${String(kind)}'`;
  for (const field of ['a', 'b'] as const) {
    const ref = v[field];
    if (!isRecord(ref)) return `constraint '${id}': ${field} must be an object`;
    if (typeof ref['entityId'] !== 'string' || ref['entityId'].length === 0)
      return `constraint '${id}': ${field}.entityId must be a non-empty string`;
    const rk = ref['kind'];
    if ('kind' in ref && rk !== 'start' && rk !== 'end' && rk !== 'center' && rk !== 'mid')
      return `constraint '${id}': ${field}.kind must be start|end|center|mid, got '${String(rk)}'`;
  }
  const val = v['value'];
  if ((kind === 'distance' || kind === 'angle') && typeof val !== 'number' && typeof val !== 'string')
    return `constraint '${id}' (${kind}): value must be a number or string`;
  return null;
}

function validateRecipeValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `recipe '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `recipe '${name}': name field must be a string`;
  if (!Array.isArray(v['steps'])) return `recipe '${name}': steps must be an array`;
  for (let i = 0; i < v['steps'].length; i++) {
    const step = v['steps'][i] as unknown;
    if (!isRecord(step)) return `recipe '${name}': steps[${i}] is not an object`;
    if (typeof step['id'] !== 'string') return `recipe '${name}': steps[${i}].id must be a string`;
    if (typeof step['name'] !== 'string') return `recipe '${name}': steps[${i}].name must be a string`;
  }
  return null;
}

const PROTOTYPE_KEYED_RECORDS = [
  'entities',
  'layers',
  'materials',
  'materialLibraries',
  'parameters',
  'animations',
  'configurations',
  'groups',
  'recipes',
  'components',
  'constraints',
  'joints',
  'driveRelations',
  'contactSets',
  'explodedViews',
  'sketchPlanes',
  'sketchLinks',
] as const;

/** Commands that rewrite or replay `featureHistory`; recorded as a step they would re-enter replay. Other legacy meta/read-only steps replay inertly. */
const HISTORY_CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'replay_history',
  'set_step_suppressed',
  'edit_step_params',
  'reorder_step',
  'delete_step',
  'insert_step',
  'load_document',
]);

/** Feature history steps are replayed by name/params: each must be well-formed, unique, and name a replayable registered command. */
function historyProblems(history: ReadonlyArray<unknown>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  // an empty command table means the registry was never imported: names cannot be checked, so do not reject every step
  const tableLoaded = listCommands().length > 0;
  history.forEach((step, index) => {
    if (!isRecord(step) || typeof step['id'] !== 'string' || typeof step['name'] !== 'string') {
      errors.push(`featureHistory[${index}] is malformed (needs string id and name)`);
      return;
    }
    const where = `featureHistory[${index}] (${step['id']})`;
    if (seen.has(step['id'])) errors.push(`${where}: duplicate step id`);
    seen.add(step['id']);
    const command = getCommand(step['name']);
    if (!command && tableLoaded) errors.push(`${where}: unknown command '${step['name']}'`);
    else if (command && HISTORY_CONTROL_COMMANDS.has(step['name']))
      errors.push(`${where}: '${step['name']}' edits the history itself and cannot be a history step`);
    if (!isRecord(step['params'])) errors.push(`${where}: params must be an object`);
    if (step['affected'] !== undefined && !isStringArray(step['affected'])) errors.push(`${where}: affected must be an array of strings`);
    if (step['suppressed'] !== undefined && typeof step['suppressed'] !== 'boolean') errors.push(`${where}: suppressed must be a boolean`);
  });
  return errors;
}

/** Structural validation of the raw document record (shape-only, no value checks). Value checks are done in `validateDocumentValues`. */
export function validateDocumentShape(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const { entities, order, layers, layerOrder, selection, camera } = v;
  return (
    isRecord(entities) &&
    isStringArray(order) &&
    isStringArray(layerOrder) &&
    isStringArray(selection) &&
    isRecord(layers) &&
    validateCamera(camera)
  );
}

/**
 * Deep value validation of the document record. Returns an array of error strings. Integrity policy: dangling selection ids, entity key !=
 * entity.id, and duplicate order ids are REJECTED (not repaired). An empty array means the document is valid.
 */
export function validateDocumentValues(v: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const entities = v['entities'] as Record<string, unknown>;
  const layers = v['layers'] as Record<string, unknown>;
  for (const [eid, entity] of Object.entries(entities)) {
    const err = validateEntityValue(entity);
    if (err !== null) errors.push(err);
    else {
      const corruption = corruptionReason(entity);
      if (corruption !== null) errors.push(`entity ${eid}: contains ${corruption}`);
    }
    if (isRecord(entity) && entity['id'] !== eid)
      errors.push(`entity record key '${eid}' does not match entity.id '${String(entity['id'])}'`);
    const layerIdVal = isRecord(entity) ? entity['layerId'] : undefined;
    if (typeof layerIdVal === 'string' && !Object.hasOwn(layers, layerIdVal))
      errors.push(`entity ${eid}: layerId '${layerIdVal}' does not reference a known layer`);
  }
  // Order must reference existing entities (renderers index entities[id] directly)
  for (const orderedId of v['order'] as string[]) {
    if (!Object.hasOwn(entities, orderedId)) errors.push(`order: '${orderedId}' does not reference a known entity`);
  }
  // `order` is exactly the entity key set: an entity missing from it would dodge every order-driven scan
  const ordered = new Set(v['order'] as string[]);
  for (const eid of Object.keys(entities)) if (!ordered.has(eid)) errors.push(`order is missing entity '${eid}'`);
  // Duplicate ids in order would render/process an entity twice
  const orderIds = v['order'] as string[];
  if (new Set(orderIds).size !== orderIds.length) errors.push('order contains duplicate entity ids');
  // Selection must reference existing entities (policy: reject, same as order — no silent repair)
  for (const selectedId of v['selection'] as string[]) {
    if (!Object.hasOwn(entities, selectedId)) errors.push(`selection: '${selectedId}' does not reference a known entity`);
  }
  for (const key of PROTOTYPE_KEYED_RECORDS) {
    const record = v[key];
    if (!isRecord(record)) continue;
    for (const id of Object.keys(record)) if (isReservedKey(id)) errors.push(`${key}: id '${id}' is a reserved JavaScript property name`);
  }
  for (const layerId of v['layerOrder'] as string[])
    if (!Object.hasOwn(layers, layerId)) errors.push(`layerOrder: '${layerId}' does not reference a known layer`);
  const validateSection = (section: unknown, validate: (key: string, value: unknown) => string | null): void => {
    if (!isRecord(section)) return;
    for (const [key, value] of Object.entries(section)) {
      const err = validate(key, value);
      if (err !== null) errors.push(err);
    }
  };
  validateSection(v['groups'], validateGroupValue);
  validateSection(v['animations'], validateAnimationValue);
  validateSection(v['configurations'], validateConfigurationValue);
  validateSection(v['components'], validateComponentValue);
  // Component definitions must not reference themselves (renderers and bounds walk them recursively); only well-formed ones are walked
  const components = v['components'];
  if (isRecord(components) && errors.length === 0) {
    for (const id of Object.keys(components)) {
      const cycle = findComponentCycle(components as Record<string, Component>, id);
      if (cycle) errors.push(`component '${id}' contains itself (${cycle.join(' -> ')})`);
    }
  }
  const history = v['featureHistory'];
  if (Array.isArray(history)) errors.push(...historyProblems(history));
  for (const layer of Object.values(layers)) {
    if (!validateLayer(layer)) errors.push(`layer entry is malformed: ${JSON.stringify(layer)}`);
  }
  validateSection(v['materials'], validateMaterialValue);
  errors.push(...materialLibraryProblems(v['materialLibraries'], v['materials']));
  validateSection(v['parameters'], validateParameterValue);
  validateSection(v['recipes'], validateRecipeValue);
  validateSection(v['constraints'], validateConstraintValue);
  validateSection(v['joints'], validateJointValue);
  errors.push(...drawingsProblems(v['drawings']));
  errors.push(...pmiProblems(v['pmi']));
  errors.push(...exchangeProblems(v['exchange']));
  errors.push(...dynamicsProblems(v['dynamics']));
  errors.push(...prototypeProblems(v['prototype']));
  errors.push(...reviewProblems(v['review']));
  errors.push(...displayProblems(v['display']));
  errors.push(...kernelSliceProblems(v));
  for (const extension of documentExtensions()) errors.push(...extension.validate(v));
  validateSection(v['driveRelations'], validateDriveRelationValue);
  errors.push(...mechanismProblems(v));
  errors.push(...sketchPlaneProblems(v));
  return errors;
}
