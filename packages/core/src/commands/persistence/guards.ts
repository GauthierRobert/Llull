import { type Layer, type CameraState, type Vec2, type Vec3, SHAPE2D_KINDS, SOLID_KINDS, FINISH_PATTERNS } from '../../model/types';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { isHexColor } from '../../lib/isHexColor';
import { validateShapeRecipe } from '../../geometry/shapeRecipe';
import { chainIssue } from '../../geometry/curveSegments';
import { MAX_SUBDIVISION_LEVELS, type Cage, cageProblem } from '../../geometry/subdivision';
import type { CurveSegment } from '../../model/curve';
import { isVec2 } from '../../lib/vec2';
import { MAX_IMAGE_DATA_URL_LENGTH } from '../limits';
import { POSITIVE_FIELDS } from '../../model/positiveFields';

/** First problem of a saved image underlay's raster fields, or null (the payload is not decoded). */
function imageProblem(v: Record<string, unknown>): string | null {
  const dataUrl = v['dataUrl'];
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|jpg);base64,/.test(dataUrl))
    return 'dataUrl must be a base64 data:image/png or data:image/jpeg URL';
  if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return `dataUrl exceeds ${MAX_IMAGE_DATA_URL_LENGTH} characters`;
  const opacity = v['opacity'];
  if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) return `opacity must be in [0, 1], got ${String(opacity)}`;
  if (typeof v['locked'] !== 'boolean') return 'locked must be a boolean';
  return null;
}

/** First structural problem of a saved sweep (path chain + section), or null. */
function sweepProblem(v: Record<string, unknown>): string | null {
  const path = v['path'];
  if (!Array.isArray(path) || path.length === 0 || !path.every((s) => isCurveSegment(s, 3)))
    return 'path must be a non-empty array of line/arc/bezier segments with [x, y, z] points';
  const pathIssue = chainIssue(path as CurveSegment<Vec3>[], false);
  if (pathIssue !== null) return `path invalid — ${pathIssue}`;
  const stations = stationsProblem(v['stations']);
  if (stations !== null) return stations;
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
  if (section['shape'] !== 'profile' || !Array.isArray(profile) || profile.length < 3 || !profile.every(isVec2))
    return "section must be { shape: 'circle', radius } or { shape: 'profile', profile (>= 3 points) }";
  return curvesProblem(section['curves']);
}

/** Optional text decals of an entity, or null when absent / valid. */
function decalsProblem(decals: unknown): string | null {
  if (decals === undefined) return null;
  if (!Array.isArray(decals)) return 'decals must be an array';
  for (const decal of decals) {
    if (!isRecord(decal) || typeof decal['id'] !== 'string' || typeof decal['text'] !== 'string')
      return 'each decal needs an id and a text';
    if (decal['text'].trim() === '') return `decal ${decal['id']}: text must not be empty`;
    if (!isVec3(decal['center']) || !isVec3(decal['normal'])) return `decal ${String(decal['id'])}: center and normal must be finite Vec3`;
    if (Math.hypot(...(decal['normal'] as readonly number[])) < 1e-12) return `decal ${String(decal['id'])}: normal must be non-zero`;
    if (!isFiniteNumber(decal['angle']) || !['width', 'height', 'depth'].every((k) => isPositiveNumber(decal[k])))
      return `decal ${String(decal['id'])}: angle must be finite and width / height / depth > 0`;
    if (!isHexColor(decal['color']) || (decal['background'] !== undefined && !isHexColor(decal['background'])))
      return `decal ${String(decal['id'])}: color / background must be #rrggbb`;
  }
  return null;
}

/** Rings: >= `minRings` arrays of equal length >= 3 holding finite points of `dims` numbers. */
function ringsProblem(rings: unknown, dims: number, minRings: number): string | null {
  const isPoint = (p: unknown): boolean => Array.isArray(p) && p.length === dims && p.every(isFiniteNumber);
  if (!Array.isArray(rings) || rings.length < minRings) return `needs >= ${minRings} rings`;
  const size = Array.isArray(rings[0]) ? rings[0].length : 0;
  const ok = rings.every((ring) => Array.isArray(ring) && ring.length === size && size >= 3 && ring.every(isPoint));
  return ok ? null : `rings must share one length >= 3 and hold finite ${dims}D points`;
}

/** A subdivision entity's cage + levels, or null when valid. */
function subdivisionProblem(v: Record<string, unknown>): string | null {
  const { vertices, faces, creases, levels } = v;
  const isIndexList = (list: unknown): boolean => Array.isArray(list) && list.every((n) => Number.isInteger(n));
  if (!Array.isArray(vertices) || !vertices.every(isVec3)) return 'vertices must be finite [x, y, z] points';
  if (!Array.isArray(faces) || !faces.every(isIndexList)) return 'faces must be arrays of vertex indices';
  if (!Array.isArray(creases) || !creases.every((c) => isIndexList(c) && c.length === 2))
    return 'creases must be [a, b] vertex index pairs';
  if (!Number.isInteger(levels) || (levels as number) < 0 || (levels as number) > MAX_SUBDIVISION_LEVELS)
    return `levels must be an integer 0..${MAX_SUBDIVISION_LEVELS}`;
  return cageProblem({ vertices, faces, creases } as Cage);
}

/** Optional variable-section stations of a sweep, or null when absent / valid. */
function stationsProblem(stations: unknown): string | null {
  if (stations === undefined) return null;
  if (!Array.isArray(stations) || !stations.every((s) => isRecord(s) && isFiniteNumber(s['at'])))
    return 'stations must be { at, ring } entries';
  const ats = stations.map((s) => (s as Record<string, unknown>)['at'] as number);
  if (ats[0] !== 0 || ats[ats.length - 1] !== 1 || ats.some((at, i) => i > 0 && !(at > (ats[i - 1] as number))))
    return 'station at values must rise strictly from 0 to 1';
  const problem = ringsProblem(
    stations.map((s) => (s as Record<string, unknown>)['ring']),
    2,
    2,
  );
  return problem === null ? null : `stations ${problem}`;
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
    s['points'].every((p: unknown) => Array.isArray(p) && p.length === dims && p.every(isFiniteNumber))
  );
}

/** Points per curve segment type (`CurveSegment`). */
const SEGMENT_POINT_COUNT: Readonly<Record<string, number>> = { line: 2, arc: 3, bezier: 4 };

const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set([...SOLID_KINDS, ...SHAPE2D_KINDS, 'instance']);

export function validateCamera(v: unknown): v is CameraState {
  if (!isRecord(v)) return false;
  return isVec3(v['target']) && isFiniteNumber(v['azimuth']) && isFiniteNumber(v['polar']) && isFiniteNumber(v['distance']);
}

export function validateLayer(v: unknown): v is Layer {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' && typeof v['name'] === 'string' && typeof v['visible'] === 'boolean' && typeof v['locked'] === 'boolean'
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
  if (!isVec3(position)) return `entity ${id}: position must be a Vec3 of finite numbers`;
  if (!isVec3(rotation)) return `entity ${id}: rotation must be a Vec3 of finite numbers`;
  if (typeof layerId !== 'string') return `entity ${id}: layerId is not a string`;
  if (!isHexColor(color)) return `entity ${id}: color '${String(color)}' is not a valid hex color (#rrggbb)`;

  const decals = decalsProblem(v['decals']);
  if (decals !== null) return `entity ${id}: ${decals}`;

  // Kind-specific numeric invariants.
  for (const field of POSITIVE_FIELDS[kind] ?? []) {
    const value = v[field];
    if (!isPositiveNumber(value)) return `entity ${id} (${kind}): ${field} must be finite and > 0, got ${String(value)}`;
  }
  switch (kind) {
    case 'box':
    case 'wedge': {
      const size = v['size'];
      if (!Array.isArray(size) || size.length !== 3) return `entity ${id} (${kind}): size must be a 3-element array`;
      for (let i = 0; i < 3; i++) {
        const c = size[i] as unknown;
        if (!isPositiveNumber(c)) return `entity ${id} (${kind}): size[${i}] must be finite and > 0, got ${String(c)}`;
      }
      break;
    }
    case 'extrusion': {
      const depth = v['depth'];
      if (!isFiniteNumber(depth)) return `entity ${id} (extrusion): depth must be a finite number, got ${String(depth)}`;
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
    case 'loft': {
      const problem = ringsProblem(v['rings'], 3, 2);
      if (problem !== null) return `entity ${id} (loft): ${problem}`;
      if (typeof v['ruled'] !== 'boolean') return `entity ${id} (loft): ruled must be a boolean`;
      break;
    }
    case 'subdivision': {
      const problem = subdivisionProblem(v);
      if (problem !== null) return `entity ${id} (subdivision): ${problem}`;
      break;
    }
    case 'image': {
      const problem = imageProblem(v);
      if (problem !== null) return `entity ${id} (image): ${problem}`;
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
        if (!Array.isArray(scale) || scale.length !== 3) return `entity ${id} (instance): scale must be a 3-element array when present`;
        for (let i = 0; i < 3; i++) {
          const c = scale[i] as unknown;
          if (!isFiniteNumber(c)) return `entity ${id} (instance): scale[${i}] must be a finite number, got ${String(c)}`;
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
  if (!isPositiveNumber(density)) return `material '${name}': density must be finite and > 0, got ${String(density)}`;
  if (!isHexColor(color)) return `material '${name}': color '${String(color)}' is not a valid hex color (#rrggbb)`;
  const isUnit = (x: unknown): boolean => isFiniteNumber(x) && x >= 0 && x <= 1;
  if (!isUnit(metalness)) return `material '${name}': metalness must be a finite number in [0, 1], got ${String(metalness)}`;
  if (!isUnit(roughness)) return `material '${name}': roughness must be a finite number in [0, 1], got ${String(roughness)}`;
  const finish = v['finish'];
  if (finish === undefined) return null;
  if (!isRecord(finish) || !(FINISH_PATTERNS as readonly unknown[]).includes(finish['pattern']))
    return `material '${name}': finish.pattern must be one of ${FINISH_PATTERNS.join(', ')}`;
  if (!isPositiveNumber(finish['scale'])) return `material '${name}': finish.scale must be finite and > 0`;
  if (finish['color2'] !== undefined && !isHexColor(finish['color2'])) return `material '${name}': finish.color2 must be a #rrggbb colour`;
  const inRange = (x: unknown, max: number): boolean => x === undefined || (isFiniteNumber(x) && x >= 0 && x <= max);
  if (!inRange(finish['normalStrength'], 2) || !inRange(finish['clearcoat'], 1))
    return `material '${name}': finish normalStrength must be in [0, 2] and clearcoat in [0, 1]`;
  return null;
}

/**
 * Validate a Parameter entry. Returns a descriptive error string or `null`.
 */
export function validateParameterValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `parameter '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `parameter '${name}': name field must be a string`;
  if (typeof v['expression'] !== 'string') return `parameter '${name}': expression must be a string`;
  if (typeof v['value'] !== 'number') return `parameter '${name}': value must be a number`;
  return null;
}
