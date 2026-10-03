import type { DocumentUnit, EntityKind, Layer, CameraState, Vec3 } from '../model/types';
import { isRecord } from '../lib/isRecord';

// ---------------------------------------------------------------------------
// Primitive type-narrowing helpers (no `any`)
// ---------------------------------------------------------------------------

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** A Vec3 where all three components are finite numbers. */
function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** /^#[0-9a-fA-F]{6}$/ — the only hex format accepted by the renderer. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
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

// ---------------------------------------------------------------------------
// Structural + value validators
// ---------------------------------------------------------------------------

export function validateCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return (
    isFiniteVec3(v['target']) &&
    typeof v['azimuth'] === 'number' &&
    Number.isFinite(v['azimuth']) &&
    typeof v['polar'] === 'number' &&
    Number.isFinite(v['polar']) &&
    typeof v['distance'] === 'number' &&
    Number.isFinite(v['distance'])
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
  if (!isValidHexColor(color))
    return `entity ${id}: color '${String(color)}' is not a valid hex color (#rrggbb)`;

  // Kind-specific numeric invariants.
  switch (kind) {
    case 'box':
    case 'wedge': {
      const size = v['size'];
      if (!Array.isArray(size) || size.length !== 3)
        return `entity ${id} (${kind}): size must be a 3-element array`;
      for (let i = 0; i < 3; i++) {
        const c = size[i] as unknown;
        if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0)
          return `entity ${id} (${kind}): size[${i}] must be finite and > 0, got ${String(c)}`;
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const radius = v['radius'];
      const height = v['height'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (${kind}): radius must be finite and > 0, got ${String(radius)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (${kind}): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'sphere': {
      const radius = v['radius'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (sphere): radius must be finite and > 0, got ${String(radius)}`;
      break;
    }
    case 'torus': {
      const ringRadius = v['ringRadius'];
      const tubeRadius = v['tubeRadius'];
      if (typeof ringRadius !== 'number' || !Number.isFinite(ringRadius) || ringRadius <= 0)
        return `entity ${id} (torus): ringRadius must be finite and > 0, got ${String(ringRadius)}`;
      if (typeof tubeRadius !== 'number' || !Number.isFinite(tubeRadius) || tubeRadius <= 0)
        return `entity ${id} (torus): tubeRadius must be finite and > 0, got ${String(tubeRadius)}`;
      break;
    }
    case 'pyramid': {
      const baseWidth = v['baseWidth'];
      const baseDepth = v['baseDepth'];
      const height = v['height'];
      if (typeof baseWidth !== 'number' || !Number.isFinite(baseWidth) || baseWidth <= 0)
        return `entity ${id} (pyramid): baseWidth must be finite and > 0, got ${String(baseWidth)}`;
      if (typeof baseDepth !== 'number' || !Number.isFinite(baseDepth) || baseDepth <= 0)
        return `entity ${id} (pyramid): baseDepth must be finite and > 0, got ${String(baseDepth)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (pyramid): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'extrusion': {
      const depth = v['depth'];
      if (typeof depth !== 'number' || !Number.isFinite(depth))
        return `entity ${id} (extrusion): depth must be a finite number, got ${String(depth)}`;
      break;
    }
    // 2D shapes: radius-bearing kinds
    case 'arc':
    case 'circle': {
      const radius = v['radius'];
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0)
        return `entity ${id} (${kind}): radius must be finite and > 0, got ${String(radius)}`;
      break;
    }
    case 'rectangle': {
      const width = v['width'];
      const height = v['height'];
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
        return `entity ${id} (rectangle): width must be finite and > 0, got ${String(width)}`;
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (rectangle): height must be finite and > 0, got ${String(height)}`;
      break;
    }
    case 'ellipse': {
      const radiusX = v['radiusX'];
      const radiusY = v['radiusY'];
      if (typeof radiusX !== 'number' || !Number.isFinite(radiusX) || radiusX <= 0)
        return `entity ${id} (ellipse): radiusX must be finite and > 0, got ${String(radiusX)}`;
      if (typeof radiusY !== 'number' || !Number.isFinite(radiusY) || radiusY <= 0)
        return `entity ${id} (ellipse): radiusY must be finite and > 0, got ${String(radiusY)}`;
      break;
    }
    case 'text': {
      const height = v['height'];
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
        return `entity ${id} (text): height must be finite and > 0, got ${String(height)}`;
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
          if (typeof c !== 'number' || !Number.isFinite(c))
            return `entity ${id} (instance): scale[${i}] must be a finite number, got ${String(c)}`;
        }
      }
      break;
    }
    // 'line', 'polyline', 'point', 'spline', 'dimension', 'mesh' — no extra numeric invariants enforced here
    default:
      break;
  }

  return null; // valid
}

/**
 * Validate a Material entry. Returns a descriptive error string on failure, or `null` on success.
 */
export function validateMaterialValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `material '${name}' is not an object`;
  const { density, color, metalness, roughness } = v;
  if (typeof density !== 'number' || !Number.isFinite(density) || density <= 0)
    return `material '${name}': density must be finite and > 0, got ${String(density)}`;
  if (!isValidHexColor(color))
    return `material '${name}': color '${String(color)}' is not a valid hex color (#rrggbb)`;
  if (
    typeof metalness !== 'number' ||
    !Number.isFinite(metalness) ||
    metalness < 0 ||
    metalness > 1
  )
    return `material '${name}': metalness must be a finite number in [0, 1], got ${String(metalness)}`;
  if (
    typeof roughness !== 'number' ||
    !Number.isFinite(roughness) ||
    roughness < 0 ||
    roughness > 1
  )
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
