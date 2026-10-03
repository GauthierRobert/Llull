import type { ConstraintKind, JointKind } from '../model/types';
import { isRecord } from '../lib/isRecord';
import { documentExtensions } from '../plugins/host';
import {
  isFiniteNumber,
  isStringArray,
  validateCamera,
  validateLayer,
  validateEntityValue,
  validateMaterialValue,
  validateParameterValue,
} from './persistenceGuards';

/** All legal constraint kinds (must stay in sync with ConstraintKind union in types.ts). */
const VALID_CONSTRAINT_KINDS: ReadonlySet<string> = new Set<ConstraintKind>([
  'coincident',
  'parallel',
  'perpendicular',
  'tangent',
  'distance',
  'angle',
]);

/** All legal joint kinds (must stay in sync with JointKind union in types.ts). */
const VALID_JOINT_KINDS: ReadonlySet<string> = new Set<JointKind>(['revolute', 'prismatic']);

/**
 * Validate a JointMateRef embedded object. Returns error string or null.
 */
function validateJointMateRef(id: string, field: string, v: unknown): string | null {
  if (!isRecord(v)) return `joint '${id}': ${field} must be an object`;
  if (typeof v['instanceId'] !== 'string' || (v['instanceId'] as string).length === 0) {
    return `joint '${id}': ${field}.instanceId must be a non-empty string`;
  }
  if ('frame' in v) {
    const f = v['frame'];
    if (f !== 'origin' && f !== 'axis-x' && f !== 'axis-y' && f !== 'axis-z') {
      return `joint '${id}': ${field}.frame must be origin|axis-x|axis-y|axis-z, got '${String(f)}'`;
    }
  }
  return null;
}

/**
 * Validate an axis field ('x'|'y'|'z' or a 3-element finite-number array).
 * Returns error string or null.
 */
function validateJointAxis(id: string, axis: unknown): string | null {
  if (axis === 'x' || axis === 'y' || axis === 'z') return null;
  if (Array.isArray(axis) && axis.length === 3 && (axis as unknown[]).every(isFiniteNumber)) {
    return null;
  }
  return `joint '${id}': axis must be 'x', 'y', 'z', or a [x,y,z] finite-number array, got ${JSON.stringify(axis)}`;
}

/**
 * Validate a Joint entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateJointValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `joint '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `joint '${id}': id field must be a string`;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !VALID_JOINT_KINDS.has(kind)) {
    return `joint '${id}': unknown kind '${String(kind)}'. Allowed: revolute, prismatic.`;
  }
  const refErrA = validateJointMateRef(id, 'a', v['a']);
  if (refErrA !== null) return refErrA;
  const refErrB = validateJointMateRef(id, 'b', v['b']);
  if (refErrB !== null) return refErrB;
  const axisErr = validateJointAxis(id, v['axis']);
  if (axisErr !== null) return axisErr;
  if (kind === 'revolute') {
    if (!isFiniteNumber(v['angle'])) {
      return `joint '${id}' (revolute): angle must be a finite number`;
    }
  } else {
    if (!isFiniteNumber(v['displacement'])) {
      return `joint '${id}' (prismatic): displacement must be a finite number`;
    }
  }
  return null;
}

/**
 * Validate a DriveRelation entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateDriveRelationValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `driveRelation '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `driveRelation '${id}': id field must be a string`;
  if (typeof v['driver'] !== 'string' || (v['driver'] as string).length === 0)
    return `driveRelation '${id}': driver must be a non-empty string`;
  if (typeof v['driven'] !== 'string' || (v['driven'] as string).length === 0)
    return `driveRelation '${id}': driven must be a non-empty string`;
  if (!isFiniteNumber(v['ratio'])) return `driveRelation '${id}': ratio must be a finite number`;
  if ('offset' in v && v['offset'] !== undefined) {
    if (!isFiniteNumber(v['offset']))
      return `driveRelation '${id}': offset must be a finite number when present`;
  }
  return null;
}

/**
 * Validate a Constraint entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateConstraintValue(id: string, v: unknown): string | null {
  if (!isRecord(v)) return `constraint '${id}' is not an object`;
  if (typeof v['id'] !== 'string') return `constraint '${id}': id field must be a string`;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !VALID_CONSTRAINT_KINDS.has(kind)) {
    return `constraint '${id}': unknown kind '${String(kind)}'`;
  }
  // Validate EntityRef a and b.
  for (const field of ['a', 'b'] as const) {
    const ref = v[field];
    if (!isRecord(ref)) return `constraint '${id}': ${field} must be an object`;
    if (typeof ref['entityId'] !== 'string' || ref['entityId'].length === 0) {
      return `constraint '${id}': ${field}.entityId must be a non-empty string`;
    }
    if ('kind' in ref) {
      const rk = ref['kind'];
      if (rk !== 'start' && rk !== 'end' && rk !== 'center' && rk !== 'mid') {
        return `constraint '${id}': ${field}.kind must be start|end|center|mid, got '${String(rk)}'`;
      }
    }
  }
  // Dimensional constraints require a value field.
  if (kind === 'distance' || kind === 'angle') {
    const val = v['value'];
    if (typeof val !== 'number' && typeof val !== 'string') {
      return `constraint '${id}' (${kind}): value must be a number or string`;
    }
  }
  return null;
}

/**
 * Validate a Recipe entry. Returns a descriptive error string on failure, or `null` on success.
 */
function validateRecipeValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `recipe '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `recipe '${name}': name field must be a string`;
  if (!Array.isArray(v['steps'])) return `recipe '${name}': steps must be an array`;
  for (let i = 0; i < v['steps'].length; i++) {
    const step = v['steps'][i] as unknown;
    if (!isRecord(step)) return `recipe '${name}': steps[${i}] is not an object`;
    if (typeof step['id'] !== 'string') return `recipe '${name}': steps[${i}].id must be a string`;
    if (typeof step['name'] !== 'string')
      return `recipe '${name}': steps[${i}].name must be a string`;
  }
  return null;
}

/**
 * Structural validation of the raw document record (shape-only, no value checks).
 * Value checks are done in `validateDocumentValues`.
 */
export function validateDocumentShape(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const { entities, order, layers, layerOrder, selection, camera } = v;
  if (!isRecord(entities)) return false;
  if (!isStringArray(order)) return false;
  if (!isStringArray(layerOrder)) return false;
  if (!isStringArray(selection)) return false;
  if (!isRecord(layers)) return false;
  if (!validateCamera(camera)) return false;
  return true;
}

/**
 * Deep value validation of the document record. Returns an array of error strings.
 * Integrity policy: dangling selection ids, entity key != entity.id, and duplicate order ids are REJECTED (not repaired).
 * An empty array means the document is valid.
 */
export function validateDocumentValues(v: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Entities
  const entities = v['entities'] as Record<string, unknown>;
  for (const [eid, entity] of Object.entries(entities)) {
    const err = validateEntityValue(entity);
    if (err !== null) errors.push(err);
    if (isRecord(entity) && entity['id'] !== eid) {
      errors.push(`entity record key '${eid}' does not match entity.id '${String(entity['id'])}'`);
    }

    // Validate layer reference
    const layerIdVal = isRecord(entity) ? entity['layerId'] : undefined;
    const layers = v['layers'] as Record<string, unknown>;
    if (
      typeof layerIdVal === 'string' &&
      !Object.prototype.hasOwnProperty.call(layers, layerIdVal)
    ) {
      errors.push(`entity ${eid}: layerId '${layerIdVal}' does not reference a known layer`);
    }
  }

  // Order must reference existing entities (renderers index entities[id] directly)
  for (const orderedId of v['order'] as string[]) {
    if (!Object.prototype.hasOwnProperty.call(entities, orderedId)) {
      errors.push(`order: '${orderedId}' does not reference a known entity`);
    }
  }

  // Duplicate ids in order would render/process an entity twice
  const orderIds = v['order'] as string[];
  if (new Set(orderIds).size !== orderIds.length) {
    errors.push('order contains duplicate entity ids');
  }

  // Selection must reference existing entities (policy: reject, same as order — no silent repair)
  for (const selectedId of v['selection'] as string[]) {
    if (!Object.prototype.hasOwnProperty.call(entities, selectedId)) {
      errors.push(`selection: '${selectedId}' does not reference a known entity`);
    }
  }

  // Feature history steps are replayed by name/params — each must be a well-formed record
  if (Array.isArray(v['featureHistory'])) {
    v['featureHistory'].forEach((step: unknown, index: number) => {
      if (!isRecord(step) || typeof step['id'] !== 'string' || typeof step['name'] !== 'string') {
        errors.push(`featureHistory[${index}] is malformed (needs string id and name)`);
      }
    });
  }

  // Layers
  const layers = v['layers'] as Record<string, unknown>;
  for (const layer of Object.values(layers)) {
    if (!validateLayer(layer)) errors.push(`layer entry is malformed: ${JSON.stringify(layer)}`);
  }

  const validateSection = (
    section: unknown,
    validate: (key: string, value: unknown) => string | null,
  ): void => {
    if (!isRecord(section)) return;
    for (const [key, value] of Object.entries(section)) {
      const err = validate(key, value);
      if (err !== null) errors.push(err);
    }
  };
  validateSection(v['materials'], validateMaterialValue);
  validateSection(v['parameters'], validateParameterValue);
  validateSection(v['recipes'], validateRecipeValue);
  validateSection(v['constraints'], validateConstraintValue);
  validateSection(v['joints'], validateJointValue);
  for (const extension of documentExtensions()) errors.push(...extension.validate(v));
  validateSection(v['driveRelations'], validateDriveRelationValue);

  return errors;
}
