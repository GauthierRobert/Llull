import { storedMaterialModelsProblem } from '../document/materialModelStored';
import { storedModelsProblem } from '../document/propertyModelSchema';
import { formHash } from '../document/propertyModels';
import { recordProblem } from './materialRecordValidation';
import {
  type Layer,
  type CameraState,
  type EntityKind,
  type Vec2,
  type Vec3,
  SHAPE2D_KINDS,
  SOLID_KINDS,
  FINISH_PATTERNS,
} from '../../model/types';
import { nurbsCurveProblem } from './nurbsGuard';
import { CURVE_KINDS } from '../../model/curveKinds';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { isHexColor } from '../../lib/isHexColor';
import { validateShapeRecipe } from '../../geometry/shapeRecipe';
import { chainIssue } from '../../geometry/curveSegments';
import { MAX_SUBDIVISION_LEVELS, type Cage, cageProblem } from '../../geometry/subdivision';
import type { CurveSegment } from '../../model/curve';
import { isVec2 } from '../../lib/vec2';
import {
  MAX_DISPLAY_PRECISION,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_IMPORT_TRIANGLES,
  MAX_STORED_PROFILE_POINTS,
  MAX_REVOLVE_SEGMENTS,
  MAX_SPLINE_CONTROL_POINTS,
} from '../limits';
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
  // sweep_profile accepts closed loops (no end caps) unless the section varies along the path
  const chain = path as CurveSegment<Vec3>[];
  const closed = chainIssue(chain, true) === null;
  if (closed && v['stations'] !== undefined) return 'path invalid — stations need an open path';
  const pathIssue = chainIssue(chain, closed);
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

const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set([...SOLID_KINDS, ...SHAPE2D_KINDS, ...CURVE_KINDS, 'instance']);

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

/** First problem of an entity's base fields, then its kind-specific fields, or null. */
export function validateEntityValue(v: unknown): string | null {
  if (!isRecord(v)) return 'entity is not an object';
  const { id, kind, position, rotation, layerId, color } = v;
  if (typeof id !== 'string') return 'entity.id is not a string';
  if (typeof kind !== 'string') return `entity ${id}: kind is not a string`;
  if (!VALID_ENTITY_KINDS.has(kind)) return `entity ${id}: unknown kind '${kind}'`;
  if (!isVec3(position)) return `entity ${id}: position must be a Vec3 of finite numbers`;
  if (!isVec3(rotation)) return `entity ${id}: rotation must be a Vec3 of finite numbers`;
  if (typeof layerId !== 'string') return `entity ${id}: layerId is not a string`;
  if (!isHexColor(color)) return `entity ${id}: color '${String(color)}' is not a valid hex color (#rrggbb)`;
  const decals = decalsProblem(v['decals']);
  if (decals !== null) return `entity ${id}: ${decals}`;
  for (const field of POSITIVE_FIELDS[kind] ?? []) {
    const value = v[field];
    if (!isPositiveNumber(value)) return `entity ${id} (${kind}): ${field} must be finite and > 0, got ${String(value)}`;
  }
  const optional = baseOptionalProblem(v);
  if (optional !== null) return `entity ${id} (${kind}): ${optional}`;
  const problem = KIND_PROBLEMS[kind as EntityKind](v);
  return problem === null ? null : `entity ${id} (${kind}): ${problem}`;
}

/** First problem of `v[key]` as a `length`-component array whose items pass `ok`, or null. */
function tupleProblem(v: Record<string, unknown>, key: string, ok: (c: unknown) => boolean, what: string): string | null {
  const value = v[key];
  if (!Array.isArray(value) || value.length !== 3) return `${key} must be a 3-element array`;
  const bad = value.findIndex((c: unknown) => !ok(c));
  return bad < 0 ? null : `${key}[${bad}] must be ${what}, got ${String(value[bad])}`;
}

const sizeProblem = (v: Record<string, unknown>): string | null => tupleProblem(v, 'size', isPositiveNumber, 'finite and > 0');

const noProblem = (): null => null;

function loftProblem(v: Record<string, unknown>): string | null {
  const base = ringsProblem(v['rings'], 3, 2) ?? (typeof v['ruled'] === 'boolean' ? null : 'ruled must be a boolean');
  const sections = v['sections'];
  if (base !== null || sections === undefined) return base;
  if (!Array.isArray(sections) || sections.length !== (v['rings'] as unknown[]).length) return 'sections must list one curve per ring';
  for (let i = 0; i < sections.length; i++) {
    const problem = nurbsCurveProblem(sections[i], `sections.${i}`);
    if (problem !== null) return problem;
  }
  return null;
}

/** Optional BaseEntity fields (`name`, `tags`, `materialId`) must have their declared types, or null. */
function baseOptionalProblem(v: Record<string, unknown>): string | null {
  if (v['name'] !== undefined && typeof v['name'] !== 'string') return 'name must be a string';
  if (v['materialId'] !== undefined && typeof v['materialId'] !== 'string') return 'materialId must be a string';
  const tags = v['tags'];
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) return 'tags must be an array of strings';
  return null;
}

/** `v[key]` must be a Vec2 of finite numbers, or null. */
function vec2Problem(v: Record<string, unknown>, key: string): string | null {
  return isVec2(v[key]) ? null : `${key} must be [x, y] of finite numbers`;
}

/** `v[key]` must be a list of `min..max` finite Vec2, or null. */
function pointListProblem(v: Record<string, unknown>, key: string, min: number, max: number): string | null {
  const list = v[key];
  if (!Array.isArray(list) || list.length < min || list.length > max || !list.every(isVec2))
    return `${key} must be ${min}..${max} [x, y] points of finite numbers`;
  return null;
}

/** First problem among the checks (stops at the first non-null). */
function firstProblem(...checks: ReadonlyArray<string | null>): string | null {
  return checks.find((problem) => problem !== null) ?? null;
}

const finiteField =
  (key: string) =>
  (v: Record<string, unknown>): string | null =>
    isFiniteNumber(v[key]) ? null : `${key} must be a finite number, got ${String(v[key])}`;

const closedFlagProblem = (v: Record<string, unknown>): string | null =>
  v['closed'] === undefined || typeof v['closed'] === 'boolean' ? null : 'closed must be a boolean';

function revolutionProblem(v: Record<string, unknown>): string | null {
  const { segments, axis, angle } = v;
  if (!Number.isInteger(segments) || (segments as number) < 3 || (segments as number) > MAX_REVOLVE_SEGMENTS)
    return `segments must be an integer 3..${MAX_REVOLVE_SEGMENTS}, got ${String(segments)}`;
  if (!isVec3(axis) || Math.hypot(...axis) < 1e-12) return 'axis must be a non-zero [x, y, z] of finite numbers';
  if (!isFiniteNumber(angle) || angle <= 0 || angle > 2 * Math.PI + 1e-9) return `angle must be in (0, 2π], got ${String(angle)}`;
  return firstProblem(pointListProblem(v, 'profile', 3, MAX_STORED_PROFILE_POINTS), curvesProblem(v['curves']));
}

function meshProblem(v: Record<string, unknown>): string | null {
  const mesh = v['mesh'];
  if (!isRecord(mesh)) return 'mesh must be { positions, indices }';
  const { positions, indices } = mesh;
  if (!Array.isArray(positions) || positions.length % 3 !== 0 || !positions.every(isFiniteNumber))
    return 'mesh.positions must be a flat array of finite numbers (length divisible by 3)';
  const vertexCount = positions.length / 3;
  if (!Array.isArray(indices) || indices.length % 3 !== 0 || indices.length / 3 > MAX_IMPORT_TRIANGLES)
    return `mesh.indices must be a flat array of triangle indices (at most ${MAX_IMPORT_TRIANGLES} triangles)`;
  if (!indices.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < vertexCount))
    return `mesh.indices must be integers in [0, ${vertexCount})`;
  const problem = v['brep'] === undefined ? null : validateShapeRecipe(v['brep'], validateEntityValue);
  return problem === null ? null : `brep recipe invalid — ${problem}`;
}

function textProblem(v: Record<string, unknown>): string | null {
  if (typeof v['content'] !== 'string' || v['content'] === '') return 'content must be a non-empty string';
  const anchor = v['anchor'];
  return anchor === undefined || anchor === 'left' || anchor === 'center' || anchor === 'right'
    ? null
    : "anchor must be 'left' | 'center' | 'right'";
}

const DIMENSION_KINDS: ReadonlySet<unknown> = new Set(['linear', 'aligned', 'radial', 'diameter', 'angular']);

function dimensionProblem(v: Record<string, unknown>): string | null {
  if (!DIMENSION_KINDS.has(v['dimensionKind'])) return "dimensionKind must be 'linear' | 'aligned' | 'radial' | 'diameter' | 'angular'";
  const ids = v['entityIds'];
  if (!Array.isArray(ids) || ids.length > 3 || !ids.every((x) => typeof x === 'string'))
    return 'entityIds must be up to 3 entity id strings';
  if (v['offset'] !== undefined && !isFiniteNumber(v['offset'])) return 'offset must be a finite number';
  const precision = v['precision'];
  if (
    precision !== undefined &&
    !(Number.isInteger(precision) && (precision as number) >= 0 && (precision as number) <= MAX_DISPLAY_PRECISION)
  )
    return `precision must be an integer 0..${MAX_DISPLAY_PRECISION}`;
  if (v['tolerance'] !== undefined && typeof v['tolerance'] !== 'string') return 'tolerance must be a string';
  return v['label'] === undefined || typeof v['label'] === 'string' ? null : 'label must be a string';
}

/** Kind-specific structural checks (message tail after `entity <id> (<kind>): `); exhaustive over `EntityKind`. */
const KIND_PROBLEMS: Readonly<Record<EntityKind, (v: Record<string, unknown>) => string | null>> = {
  box: sizeProblem,
  wedge: sizeProblem,
  cylinder: noProblem,
  sphere: noProblem,
  cone: noProblem,
  torus: noProblem,
  pyramid: noProblem,
  extrusion: (v) =>
    firstProblem(finiteField('depth')(v), pointListProblem(v, 'profile', 3, MAX_STORED_PROFILE_POINTS), curvesProblem(v['curves'])),
  revolution: revolutionProblem,
  sweep: sweepProblem,
  loft: loftProblem,
  nurbs_curve: (v) => nurbsCurveProblem(v['curve'], 'curve'),
  subdivision: subdivisionProblem,
  image: imageProblem,
  mesh: meshProblem,
  line: (v) => firstProblem(vec2Problem(v, 'start'), vec2Problem(v, 'end')),
  // uncapped: DXF import and offset_2d write polylines of any length (the file size already bounds a document)
  polyline: (v) => firstProblem(pointListProblem(v, 'points', 2, Number.POSITIVE_INFINITY), closedFlagProblem(v)),
  spline: (v) => firstProblem(pointListProblem(v, 'points', 2, MAX_SPLINE_CONTROL_POINTS), closedFlagProblem(v)),
  arc: (v) => firstProblem(vec2Problem(v, 'center'), finiteField('startAngle')(v), finiteField('endAngle')(v)),
  circle: (v) => vec2Problem(v, 'center'),
  ellipse: (v) => vec2Problem(v, 'center'),
  rectangle: noProblem,
  point: noProblem,
  text: textProblem,
  dimension: dimensionProblem,
  instance: (v) => {
    const componentId = v['componentId'];
    if (typeof componentId !== 'string' || componentId.length === 0)
      return `componentId must be a non-empty string, got ${String(componentId)}`;
    if (v['scale'] === undefined) return null;
    const problem = tupleProblem(v, 'scale', isFiniteNumber, 'a finite number');
    return problem?.startsWith('scale must') ? `${problem} when present` : problem;
  },
};

/** First problem of a Material entry, or null. */
export function validateMaterialValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `material '${name}' is not an object`;
  const { density, color, metalness, roughness } = v;
  const record = v['record'];
  if (record !== undefined) {
    const recordIssue = recordProblem(name, record);
    if (recordIssue !== null) return recordIssue;
  }
  // a record may have no density value yet (0); a legacy material always has one
  if (!isPositiveNumber(density) && !(record !== undefined && density === 0))
    return `material '${name}': density must be finite and > 0, got ${String(density)}`;
  if (!isHexColor(color)) return `material '${name}': color '${String(color)}' is not a valid hex color (#rrggbb)`;
  const isUnit = (x: unknown): boolean => isFiniteNumber(x) && x >= 0 && x <= 1;
  if (!isUnit(metalness)) return `material '${name}': metalness must be a finite number in [0, 1], got ${String(metalness)}`;
  if (!isUnit(roughness)) return `material '${name}': roughness must be a finite number in [0, 1], got ${String(roughness)}`;
  if (v['propertyModels'] !== undefined) {
    const models = storedModelsProblem(name, v['propertyModels'], formHash);
    if (models !== null) return models;
  }
  if (v['materialModels'] !== undefined || v['constitutiveSets'] !== undefined || v['defaultConstitutiveSet'] !== undefined) {
    const laws = storedMaterialModelsProblem(
      name,
      v['materialModels'],
      v['constitutiveSets'],
      v['defaultConstitutiveSet'],
      v['propertyModels'],
    );
    if (laws !== null) return laws;
  }
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

/** First problem of a Parameter entry, or null. */
export function validateParameterValue(name: string, v: unknown): string | null {
  if (!isRecord(v)) return `parameter '${name}' is not an object`;
  if (typeof v['name'] !== 'string') return `parameter '${name}': name field must be a string`;
  if (typeof v['expression'] !== 'string') return `parameter '${name}': expression must be a string`;
  if (typeof v['value'] !== 'number') return `parameter '${name}': value must be a number`;
  return null;
}
