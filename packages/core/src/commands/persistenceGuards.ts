import type { DocumentUnit, EntityKind, Layer, CameraState, Vec3 } from '../model/types';
import { isRecord } from '../lib/isRecord';
import { isFiniteNumber } from '../lib/isFiniteNumber';
import { isHexColor } from '../lib/isHexColor';

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const isPositiveNumber = (v: unknown): v is number => isFiniteNumber(v) && v > 0;

/** Fields that must be finite and > 0, per entity kind. */
const POSITIVE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  sphere: ['radius'],
  torus: ['ringRadius', 'tubeRadius'],
  pyramid: ['baseWidth', 'baseDepth', 'height'],
  arc: ['radius'],
  circle: ['radius'],
  rectangle: ['width', 'height'],
  ellipse: ['radiusX', 'radiusY'],
  text: ['height'],
};

/** A Vec3 where all three components are finite numbers. */
function isFiniteVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

/** All legal entity kinds (must stay in sync with EntityKind union in types.ts). */
const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set<EntityKind>([
  // 3D solids
  'box',
  'cylinder',
  'sphere',
  'extrusion',
  'mesh',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'revolution',
  // 2D shapes
  'line',
  'polyline',
  'arc',
  'circle',
  'rectangle',
  'point',
  'ellipse',
  'spline',
  'text',
  'dimension',
  // Assembly
  'instance',
]);

export const VALID_UNITS: ReadonlySet<string> = new Set<DocumentUnit>([
  'mm',
  'cm',
  'm',
  'in',
  'ft',
]);

export function validateCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (
    isFiniteVec3(v['target']) &&
    isFiniteNumber(v['azimuth']) &&
    isFiniteNumber(v['polar']) &&
    isFiniteNumber(v['distance'])
  );
}

export function validateLayer(v: unknown): v is Layer {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['visible'] === 'boolean' &&
    typeof v['locked'] === 'boolean'
  );
}

/**
 * Validate the base fields shared by all entities, plus kind-specific numeric fields.
 * Returns a descriptive error string on failure, or `null` on success.
 */
export function validateEntityValue(v: unknown): string | null {
  if (!isRecord(v)) return 'entity is not an object';

  const id = v['id'];
  const kind = v['kind'];
  const position = v['position'];
  const rotation = v['rotation'];
  const layerId = v['layerId'];
  const color = v['color'];

  if (typeof id !== 'string') return 'entity.id is not a string';
  if (typeof kind !== 'string') return `entity ${id}: kind is not a string`;
  if (!VALID_ENTITY_KINDS.has(kind)) return `entity ${id}: unknown kind '${kind}'`;
  if (!isFiniteVec3(position)) return `entity ${id}: position must be a Vec3 of finite numbers`;
  if (!isFiniteVec3(rotation)) return `entity ${id}: rotation must be a Vec3 of finite numbers`;
  if (typeof layerId !== 'string') return `entity ${id}: layerId is not a string`;
  if (!isHexColor(color))
    return `entity ${id}: color '${String(color)}' is not a valid hex color (#rrggbb)`;

  // Kind-specific numeric invariants.
  for (const field of POSITIVE_FIELDS[kind] ?? []) {
    const value = v[field];
    if (!isPositiveNumber(value))
      return `entity ${id} (${kind}): ${field} must be finite and > 0, got ${String(value)}`;
  }
  switch (kind) {
    case 'box':
    case 'wedge': {
      const size = v['size'];
      if (!Array.isArray(size) || size.length !== 3)
        return `entity ${id} (${kind}): size must be a 3-element array`;
      for (let i = 0; i < 3; i++) {
        const c = size[i] as unknown;
        if (!isPositiveNumber(c))
          return `entity ${id} (${kind}): size[${i}] must be finite and > 0, got ${String(c)}`;
      }
      break;
    }
    case 'extrusion': {
      const depth = v['depth'];
      if (!isFiniteNumber(depth))
        return `entity ${id} (extrusion): depth must be a finite number, got ${String(depth)}`;
      break;
    }
    case 'instance': {
      const componentId = v['componentId'];
      if (typeof componentId !== 'string' || componentId.length === 0)
        return `entity ${id} (instance): componentId must be a non-empty string, got ${String(componentId)}`;
      // scale is optional; when present must be a 3-element finite array
      const scale = v['scale'];
      if (scale !== undefined) {
        if (!Array.isArray(scale) || scale.length !== 3)
          return `entity ${id} (instance): scale must be a 3-element array when present`;
        for (let i = 0; i < 3; i++) {
          const c = scale[i] as unknown;
          if (!isFiniteNumber(c))
            return `entity ${id} (instance): scale[${i}] must be a finite number, got ${String(c)}`;
        }
      }
      break;
    }
  }

  return null;
}

/**
 * Validate a Material entry. Returns a descriptive error string on failure, or `null` on success.
 */
export function validateMaterialValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `material '${name}' is not an object`;
  const { density, color, metalness, roughness } = v;
  if (!isPositiveNumber(density))
    return `material '${name}': density must be finite and > 0, got ${String(density)}`;
  if (!isHexColor(color))
    return `material '${name}': color '${String(color)}' is not a valid hex color (#rrggbb)`;
  const isUnit = (x: unknown): boolean => isFiniteNumber(x) && x >= 0 && x <= 1;
  if (!isUnit(metalness))
    return `material '${name}': metalness must be a finite number in [0, 1], got ${String(metalness)}`;
  if (!isUnit(roughness))
    return `material '${name}': roughness must be a finite number in [0, 1], got ${String(roughness)}`;
  return null;
}

/**
 * Validate a Parameter entry. Returns a descriptive error string or `null`.
 */
export function validateParameterValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `parameter '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `parameter '${name}': name field must be a string`;
  if (typeof v['expression'] !== 'string')
    return `parameter '${name}': expression must be a string`;
  if (typeof v['value'] !== 'number') return `parameter '${name}': value must be a number`;
  return null;
}
