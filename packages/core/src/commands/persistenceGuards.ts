import {
  type Layer,
  type CameraState,
  type Vec2,
  type Vec3,
  SHAPE2D_KINDS,
  SOLID_KINDS,
} from '../model/types';
import { isRecord } from '../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../lib/isFiniteNumber';
import { isHexColor } from '../lib/isHexColor';
import { validateShapeRecipe } from '../geometry/shapeRecipe';
import { chainIssue } from '../geometry/curveSegments';
import type { CurveSegment } from '../model/curve';
import { isVec2 } from '../lib/vec2';

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

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

/** First structural problem of a saved sweep (path chain + section), or null. */
function sweepProblem(v: Record<string, unknown>): string | null {
  const path = v['path'];
  if (!Array.isArray(path) || path.length === 0 || !path.every((s) => isCurveSegment(s, 3)))
    return 'path must be a non-empty array of line/arc/bezier segments with [x, y, z] points';
  const pathIssue = chainIssue(path as CurveSegment<Vec3>[], false);
  if (pathIssue !== null) return `path invalid — ${pathIssue}`;
  const section = v['section'];
  if (!isRecord(section)) return 'section must be an object';
  if (section['shape'] === 'circle') {
    if (!isPositiveNumber(section['radius'])) return 'section radius must be finite and > 0';
    const bore = section['innerRadius'];
    if (bore !== undefined && !(isPositiveNumber(bore) && bore < (section['radius'] as number)))
      return 'section innerRadius must be > 0 and < radius';
    return null;
  }
  const profile = section['profile'];
  if (
    section['shape'] !== 'profile' ||
    !Array.isArray(profile) ||
    profile.length < 3 ||
    !profile.every(isVec2)
  )
    return "section must be { shape: 'circle', radius } or { shape: 'profile', profile (>= 3 points) }";
  return curvesProblem(section['curves']);
}

/** Optional exact 2D boundary (`curves`) problem, or null. */
function curvesProblem(curves: unknown): string | null {
  if (curves === undefined) return null;
  if (!(Array.isArray(curves) && curves.every((s) => isCurveSegment(s, 2))))
    return 'curves must be line/arc/bezier segments with [x, y] points';
  const issue = chainIssue(curves as CurveSegment<Vec2>[], true);
  return issue === null ? null : `curves must form one closed loop — ${issue}`;
}

function isCurveSegment(s: unknown, dims: number): boolean {
  return (
    isRecord(s) &&
    Array.isArray(s['points']) &&
    s['points'].length === SEGMENT_POINT_COUNT[String(s['type'])] &&
    s['points'].every(
      (p: unknown) => Array.isArray(p) && p.length === dims && p.every(isFiniteNumber),
    )
  );
}

/** Points per curve segment type (`CurveSegment`). */
const SEGMENT_POINT_COUNT: Readonly<Record<string, number>> = { line: 2, arc: 3, bezier: 4 };

/** A Vec3 where all three components are finite numbers. */
function isFiniteVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set([
  ...SOLID_KINDS,
  ...SHAPE2D_KINDS,
  'instance',
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
      const curves = curvesProblem(v['curves']);
      if (curves !== null) return `entity ${id} (extrusion): ${curves}`;
      break;
    }
    case 'revolution': {
      const curves = curvesProblem(v['curves']);
      if (curves !== null) return `entity ${id} (revolution): ${curves}`;
      break;
    }
    case 'sweep': {
      const problem = sweepProblem(v);
      if (problem !== null) return `entity ${id} (sweep): ${problem}`;
      break;
    }
    case 'mesh': {
      const brep = v['brep'];
      if (brep === undefined) break;
      const problem = validateShapeRecipe(brep, validateEntityValue);
      if (problem !== null) return `entity ${id} (mesh): brep recipe invalid — ${problem}`;
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
