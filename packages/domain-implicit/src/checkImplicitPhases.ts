/** Phases of check_implicit: findings per concern (mesh, resolution, components, process limits, overhang) and the report. */

import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { CadDocument, MeshData, Vec3 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { isClosedManifold } from '@lib/isosurface/measures';
import { fullBodyMesh } from './bodyMesh';
import { refuseImplicit } from './codes';
import type { Compiled } from './compile';
import type { signComponentsOf } from './measure';
import { type ImplicitBody, bodyOf, fieldOf } from './model';
import { overhang } from './overhang';
import type { measureWalls } from './wallChecks';

type Severity = 'fail' | 'warn';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: readonly string[];
  readonly value: number | null;
  readonly limit: number | null;
  readonly unit: string;
  readonly location: Vec3 | null;
  readonly message: string;
  readonly remediation: string;
}

type NewFinding = Omit<Finding, 'unit'> & { unit?: string };

export interface Findings {
  readonly list: Finding[];
  readonly add: (finding: NewFinding) => void;
}

/** An empty finding list whose `add` defaults the unit of a finding to the document unit. */
export function newFindings(unit: string): Findings {
  const list: Finding[] = [];
  return { list, add: (finding) => void list.push({ unit, ...finding }) };
}

const MAX_LISTED = 20;
/** Half-width of the band (in voxels) in which a measured thickness cannot be told from the limit. */
const RESOLUTION_BAND = 2.5;

export const isRefusal = (value: object): value is CommandResult => 'document' in value;

/** The implicit body `id`, or the refusal of an unknown / unrealised body. */
export function resolveBody(doc: CadDocument, id: string): ImplicitBody | CommandResult {
  const body = bodyOf(doc, id);
  if (body === undefined)
    return refuseImplicit(
      doc,
      'check_implicit',
      'IMP_FIELD_NOT_FOUND',
      `no implicit body '${id}' (use the id returned by create_implicit_body)`,
      [id],
      ['params.id'],
    );
  if (!Object.hasOwn(doc.entities, id))
    return refuseImplicit(
      doc,
      'check_implicit',
      'IMP_BODY_STALE',
      `body '${id}' is not realised on this machine (it reads a stored body whose mesh asset is missing)`,
      [id],
      ['params.id'],
    );
  return body;
}

/** The full mesh of the body (null for a field-only body), or the refusal when its asset is missing. */
export function fullMeshOf(doc: CadDocument, id: string, ctx: ExecutionContext | undefined): MeshData | null | CommandResult {
  const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
  const full = entity?.kind === 'mesh' ? fullBodyMesh(entity, ctx?.meshAssets) : null;
  if (entity?.kind === 'mesh' && full === null)
    return refuseImplicit(
      doc,
      'check_implicit',
      'IMP_ASSET_MISSING',
      `the full mesh of body '${id}' is not in this machine's mesh asset store`,
      [id],
      ['params.id'],
    );
  return full;
}

/** Smallest wall, strut diameter and sheet thickness declared by the recipe nodes a field depends on (document units). */
export function recipeFeatures(doc: Parameters<typeof fieldOf>[0], ids: readonly string[]): { wall: number | null; strut: number | null } {
  let wall: number | null = null;
  let strut: number | null = null;
  const smaller = (current: number | null, value: number): number => (current === null ? value : Math.min(current, value));
  for (const id of ids) {
    const node = fieldOf(doc, id);
    if (node === undefined) continue;
    if (node.op === 'shell' && typeof node.thickness === 'number') wall = smaller(wall, node.thickness);
    else if (node.op === 'tpms' && node.form === 'sheet' && node.normalize === 'gradient' && typeof node.control.value === 'number')
      wall = smaller(wall, node.control.value);
    else if (node.op === 'struts' && typeof node.radius === 'number') strut = smaller(strut, 2 * node.radius);
  }
  return { wall, strut };
}

/** Findings of the realised mesh (not a closed manifold) and of recipe sizes the voxel does not resolve. */
export function meshFindings(
  sink: Findings,
  id: string,
  unit: string,
  full: MeshData | null,
  body: ImplicitBody,
  features: { wall: number | null; strut: number | null },
): void {
  const { add } = sink;
  if (full !== null && !isClosedManifold({ positions: [...full.positions], indices: [...full.indices] }))
    add({
      code: 'IMP_CHECK_MESH_NOT_MANIFOLD',
      severity: 'fail',
      ids: [id],
      value: null,
      limit: null,
      location: null,
      message: 'the realised mesh is not a closed edge-manifold surface',
      remediation: 'report a bug; re-realise with create_implicit_body',
    });
  const smallest = [features.wall, features.strut].filter((v): v is number => v !== null);
  if (smallest.length > 0 && Math.min(...smallest) < 2 * body.voxel)
    add({
      code: 'IMP_CHECK_RESOLUTION_COARSE',
      severity: 'warn',
      ids: [id],
      value: Math.min(...smallest),
      limit: 2 * body.voxel,
      location: null,
      message: `the smallest wall / strut ${Math.min(...smallest)} ${unit} is under 2 voxels (${2 * body.voxel} ${unit}): the mesh does not resolve it`,
      remediation: 'halve the voxel',
    });
}

/** Findings of enclosed voids and disconnected components; the note when the sign grid could not be evaluated. */
export function componentFindings(sink: Findings, id: string, unit: string, parts: ReturnType<typeof signComponentsOf>): string | null {
  const { add } = sink;
  if ('code' in parts) return `components and voids not evaluated: ${parts.message}`;
  parts.voids
    .slice(0, MAX_LISTED)
    .forEach((hole) =>
      add({
        code: 'IMP_TRAPPED_VOID',
        severity: 'fail',
        ids: [id],
        value: hole.volume,
        limit: 0,
        unit: `${unit}^3`,
        location: hole.point,
        message: `enclosed void of ${hole.volume.toPrecision(5)} ${unit}^3 near [${hole.point.map((c) => c.toFixed(3)).join(', ')}]: powder / resin cannot drain`,
        remediation: 'add drain holes (subtract a cylinder field) or open the shell',
      }),
    );
  if (parts.solids.length > 1)
    add({
      code: 'IMP_DISCONNECTED',
      severity: 'fail',
      ids: [id],
      value: parts.solids.length,
      limit: 1,
      unit: 'components',
      location: parts.solids[1]?.point ?? null,
      message: `${parts.solids.length} separate solid components (volumes ${parts.solids
        .slice(0, 5)
        .map((s) => s.volume.toPrecision(4))
        .join(', ')} ${unit}^3)`,
      remediation: 'connect the islands or delete them',
    });
  return null;
}

export interface ProcessLimits {
  readonly minWallMm?: number | undefined;
  readonly minPoreMm?: number | undefined;
  readonly buildDirection?: Vec3 | undefined;
  readonly criticalAngleDeg?: number | undefined;
  readonly minStrutMm?: number | undefined;
  readonly source: string;
}

export interface ProcessOutcome {
  readonly limits: Array<Record<string, unknown>>;
  readonly notEvaluated: string[];
  overhangResult: ReturnType<typeof overhang> | null;
}

interface ProcessInputs {
  readonly doc: CadDocument;
  readonly id: string;
  readonly unit: string;
  readonly sink: Findings;
  readonly process: ProcessLimits;
  readonly outcome: ProcessOutcome;
}

type Walls = ReturnType<typeof measureWalls>;

/** A recipe-declared size below its process limit. */
function declaredSizeTest(inputs: ProcessInputs, code: string, label: string, size: number | null, limit: number | undefined): void {
  const { doc, id, sink, process } = inputs;
  if (size === null || limit === undefined || toMm(doc, size) >= limit) return;
  sink.add({
    code,
    severity: 'fail',
    ids: [id],
    value: toMm(doc, size),
    limit,
    unit: 'mm',
    location: null,
    message: `${label} ${toMm(doc, size).toPrecision(4)} mm is below the process limit ${limit} mm (${process.source})`,
    remediation: 'thicken it or enlarge the cells',
  });
}

/** A distance-transform size below (or within the resolution of) its process limit. */
function measuredSizeTest(
  inputs: ProcessInputs,
  code: string,
  label: string,
  size: number,
  at: Vec3 | null,
  limit: number | undefined,
  resolution: number,
): void {
  const { doc, id, sink, process } = inputs;
  if (limit === undefined || toMm(doc, size) >= limit) return;
  const definite = toMm(doc, size) + toMm(doc, RESOLUTION_BAND * resolution) < limit;
  sink.add({
    code,
    severity: definite ? 'fail' : 'warn',
    ids: [id],
    value: toMm(doc, size),
    limit,
    unit: 'mm',
    location: at,
    message: `${label} ${toMm(doc, size).toPrecision(4)} mm (distance transform, +-${toMm(doc, RESOLUTION_BAND * resolution).toPrecision(2)} mm) is ${definite ? 'below' : 'within the resolution of'} the process limit ${limit} mm (${process.source})`,
    remediation: definite ? 'thicken it or enlarge the cells' : 'halve the voxel to settle it, or thicken it',
  });
}

function overhangFinding(inputs: ProcessInputs, full: MeshData | null, buildDirection: Vec3): void {
  const { id, unit, sink, process, outcome } = inputs;
  if (
    process.criticalAngleDeg === undefined ||
    !(process.criticalAngleDeg > 0 && process.criticalAngleDeg <= 90) ||
    Math.hypot(...buildDirection) === 0
  ) {
    outcome.notEvaluated.push('overhang');
    return;
  }
  if (full === null) return;
  outcome.limits.push({ name: 'criticalAngleDeg', value: process.criticalAngleDeg, unit: 'deg', source: process.source, defaulted: false });
  const found = overhang(full, buildDirection, process.criticalAngleDeg);
  outcome.overhangResult = found;
  if (found.area > 0)
    sink.add({
      code: 'IMP_CHECK_OVERHANG',
      severity: 'warn',
      ids: [id],
      value: found.area,
      limit: process.criticalAngleDeg,
      unit: `${unit}^2`,
      location: found.centroid,
      message: `${found.area.toPrecision(5)} ${unit}^2 (${(100 * found.fraction).toFixed(1)} % of the surface) looks downward and is flatter than ${process.criticalAngleDeg} degrees to the build plate (flattest ${found.flattestDeg?.toFixed(1)} degrees)`,
      remediation: 'reorient the part, or use self-supporting cells and a lower overhang angle',
    });
}

/** Findings against the process limits the caller gave: measured wall / pore, overhang, declared wall / strut sizes. */
export function processFindings(
  doc: CadDocument,
  id: string,
  sink: Findings,
  process: ProcessLimits,
  walls: Walls,
  full: MeshData | null,
  features: { wall: number | null; strut: number | null },
  outcome: ProcessOutcome,
): void {
  const { wall, strut } = features;
  const inputs: ProcessInputs = { doc, id, unit: doc.units, sink, process, outcome };
  const named = (name: string, value: number | undefined): void => {
    if (value !== undefined) outcome.limits.push({ name, value, unit: 'mm', source: process.source, defaulted: false });
  };
  named('minWallMm', process.minWallMm);
  named('minPoreMm', process.minPoreMm);
  named('minStrutMm', process.minStrutMm);
  if (typeof walls === 'string') {
    if (process.minPoreMm !== undefined) outcome.notEvaluated.push('minPoreMm');
  } else {
    if (process.minWallMm !== undefined && walls.wall.min !== null)
      measuredSizeTest(
        inputs,
        'IMP_CHECK_MIN_WALL',
        'measured smallest wall',
        walls.wall.min,
        walls.wallAt,
        process.minWallMm,
        walls.voxel,
      );
    if (process.minPoreMm !== undefined && walls.pore.min !== null)
      measuredSizeTest(
        inputs,
        'IMP_CHECK_MIN_PORE',
        'measured smallest pore',
        walls.pore.min,
        walls.poreAt,
        process.minPoreMm,
        walls.voxel,
      );
  }
  const measuredWall = typeof walls === 'string' ? null : walls.wall.min;
  if (process.buildDirection !== undefined) overhangFinding(inputs, full, process.buildDirection);
  if (process.minWallMm !== undefined && wall === null && measuredWall === null) outcome.notEvaluated.push('minWallMm');
  if (process.minStrutMm !== undefined && strut === null) outcome.notEvaluated.push('minStrutMm');
  if (measuredWall === null) declaredSizeTest(inputs, 'IMP_CHECK_MIN_WALL', 'smallest wall', wall, process.minWallMm);
  declaredSizeTest(inputs, 'IMP_CHECK_MIN_STRUT', 'smallest strut diameter', strut, process.minStrutMm);
}

/** Findings that do not depend on the process: no limits given, unverified inputs, checks not evaluated. */
export function noProcessFinding(sink: Findings, id: string): void {
  sink.add({
    code: 'IMP_CHECK_NO_PROCESS_LIMITS',
    severity: 'warn',
    ids: [id],
    value: null,
    limit: null,
    location: null,
    message: 'no process limits were given: wall, strut and pore limits were not checked',
    remediation: 'pass process {minWallMm, minStrutMm, source}',
  });
}

export function closingFindings(sink: Findings, id: string, unverified: boolean, notEvaluated: readonly string[]): void {
  const { add } = sink;
  if (unverified)
    add({
      code: 'IMP_CHECK_INPUT_UNVERIFIED',
      severity: 'warn',
      ids: [id],
      value: null,
      limit: null,
      location: null,
      message: 'an input mesh has no pinned source hash: every number here inherits that',
      remediation: 'import the mesh with its sha256 pin',
    });
  if (notEvaluated.length > 0)
    add({
      code: 'IMP_CHECK_NOT_EVALUATED',
      severity: 'warn',
      ids: [id],
      value: notEvaluated.length,
      limit: 0,
      unit: 'checks',
      location: null,
      message: `not evaluated, so not passed: ${notEvaluated.join(', ')} (no declared size for the body's recipe, or the measure was refused)`,
      remediation: 'measure it another way (lattice_properties, implicit_properties) or give a recipe with a declared wall / strut size',
    });
}

export interface CheckOutcome {
  readonly id: string;
  readonly purpose: 'design' | 'release';
  readonly findings: readonly Finding[];
  readonly limits: Array<Record<string, unknown>>;
  readonly features: { wall: number | null; strut: number | null };
  readonly walls: Walls;
  readonly overhangResult: ReturnType<typeof overhang> | null;
  readonly notEvaluated: readonly string[];
  readonly componentNote: string | null;
  readonly compiled: Compiled;
  readonly engine: FieldEngine;
  readonly voxel: number;
}

/** The report of a finished check: status, findings and the data payload. */
export function checkReport(doc: CadDocument, outcome: CheckOutcome): CommandResult {
  const { id, purpose, findings, limits, features, walls, overhangResult, notEvaluated, componentNote, compiled, engine, voxel } = outcome;
  const unit = doc.units;
  const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';
  const reviewRequired = purpose === 'release';
  const codes = [...new Set(findings.map((f) => f.code))];
  return report(
    doc,
    `check_implicit purpose=${purpose}: ${status.toUpperCase()} for ${id}${codes.length > 0 ? ` — ${codes.join(', ')}` : ''}${reviewRequired ? '; computed by llull, not approved: needs a qualified engineer' : ''}.`,
    {
      id,
      purpose,
      status,
      findings,
      limits,
      features: {
        smallestWall: features.wall,
        smallestStrutDiameter: features.strut,
        unit,
        source: 'recipe (declared shell / sheet thickness, strut diameter)',
      },
      measured:
        typeof walls === 'string'
          ? { available: false, reason: walls }
          : {
              available: true,
              wallMin: walls.wall.min,
              wallMax: walls.wall.max,
              wallAt: walls.wallAt,
              poreMin: walls.pore.min,
              poreAt: walls.poreAt,
              voxel: walls.voxel,
              accuracy: '+-2.5 voxels (curved walls); walls under 3 voxels are not resolved (halve the voxel)',
              unit,
            },
      overhang: overhangResult,
      notEvaluated,
      componentNote,
      reviewRequired,
      reviewReason: reviewRequired ? 'release use: computed by llull, not approved; a qualified engineer must review' : null,
      unverified: compiled.unverified,
      unit,
      provenance: {
        method: 'sign-grid components and distance transform, recipe sizes, mesh edge check, overhang',
        engine: engine.name,
        voxel,
        deterministic: true,
      },
    },
  );
}
