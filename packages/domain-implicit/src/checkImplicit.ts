/** check_implicit: manufacturability findings of an implicit body (05 IMP 4.4, FR-IMP-40..45; MVP set). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { Vec3 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { isClosedManifold } from '@lib/isosurface/measures';
import { fullBodyMesh } from './bodyMesh';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { measureVoxel, signComponentsOf } from './measure';
import { bodyOf, fieldOf } from './model';
import { overhang } from './overhang';
import { measureWalls } from './wallChecks';

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

const MAX_LISTED = 20;
/** Half-width of the band (in voxels) in which a measured thickness cannot be told from the limit. */
const RESOLUTION_BAND = 2.5;

/** Smallest wall, strut diameter and sheet thickness declared by the recipe nodes a field depends on (document units). */
function recipeFeatures(doc: Parameters<typeof fieldOf>[0], ids: readonly string[]): { wall: number | null; strut: number | null } {
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

/**
 * @affects none (read-only); data = status (pass / warn / fail), findings[] {code, severity, ids, value, limit, unit, location, remediation}, limits (named, with source), reviewRequired, reviewReason
 * @invariant no printer table is shipped: process limits come from the caller (with a source) and are echoed; without them IMP_CHECK_NO_PROCESS_LIMITS is always reported; unverified inputs always add IMP_CHECK_INPUT_UNVERIFIED; wall / strut sizes are the recipe's declared sizes (shell thickness, sheet thickness, strut diameter)
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown body -> IMP_FIELD_NOT_FOUND
 */
export const checkImplicit = defineCommand({
  name: 'check_implicit',
  description:
    'Check an implicit body (id from create_implicit_body) for printing / release: mesh closed and edge-manifold, enclosed voids that powder or resin cannot leave (IMP_TRAPPED_VOID, with void volume and a point inside), ' +
    'more than one solid component (IMP_DISCONNECTED), features thinner than 2 voxels (IMP_CHECK_RESOLUTION_COARSE: halve the voxel), and walls / struts below the process limits you give. ' +
    'llull ships NO printer table: pass process {minWallMm, minStrutMm, source} from your machine data sheet, otherwise IMP_CHECK_NO_PROCESS_LIMITS is always reported. ' +
    'purpose "release" marks the result reviewRequired: computed by llull, not approved, a qualified engineer must review. Returns status pass / warn / fail and a findings list.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    id: z.string().describe('Id of the implicit body (the entity id returned by create_implicit_body).'),
    process: z
      .object({
        minWallMm: z.number().optional().describe('Smallest printable wall in millimetres.'),
        minPoreMm: z
          .number()
          .optional()
          .describe('Smallest printable pore / channel in millimetres (measured by the distance transform, +-2.5 voxels).'),
        buildDirection: vec3(
          'Build direction [x, y, z] pointing away from the plate; with criticalAngleDeg it enables the overhang analysis.',
        ).optional(),
        criticalAngleDeg: z
          .number()
          .optional()
          .describe(
            'Smallest self-supporting inclination of a face to the build plate in degrees (0..90), from your process data; required with buildDirection (never defaulted).',
          ),
        minStrutMm: z.number().optional().describe('Smallest printable strut diameter in millimetres.'),
        source: z
          .string()
          .describe(
            'Where the limits come from (machine data sheet, owner-supplied...). Required: limits without a source are not accepted.',
          ),
      })
      .optional()
      .describe('Process limits in millimetres, from your machine data. Never defaulted.'),
    purpose: z.enum(['design', 'release']).optional().describe('design (default) or release; release adds the review-required statement.'),
  }),
  run: (doc, { id, process, purpose = 'design' }, ctx): CommandResult => {
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
    const compiled = compileField(doc, body.field);
    if (!compiled.ok) return refuseImplicit(doc, 'check_implicit', compiled.code, compiled.message, compiled.ids);
    const unit = doc.units;
    const findings: Finding[] = [];
    const add = (finding: Omit<Finding, 'unit'> & { unit?: string }): void => void findings.push({ unit, ...finding });
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
    const { wall, strut } = recipeFeatures(doc, compiled.nodes);
    const smallest = [wall, strut].filter((v): v is number => v !== null);
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
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const voxel = measureVoxel(body.bounds, undefined, body.voxel);
    const parts = signComponentsOf(engine, compiled.program, body.bounds, voxel);
    let componentNote: string | null = null;
    if ('code' in parts) componentNote = `components and voids not evaluated: ${parts.message}`;
    else {
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
    }
    const walls = measureWalls(engine, compiled.program, body.bounds, body.voxel);
    let overhangResult: ReturnType<typeof overhang> | null = null;
    const limits: Array<Record<string, unknown>> = [];
    const notEvaluated: string[] = [];
    if (process === undefined)
      add({
        code: 'IMP_CHECK_NO_PROCESS_LIMITS',
        severity: 'warn',
        ids: [id],
        value: null,
        limit: null,
        location: null,
        message: 'no process limits were given: wall, strut and pore limits were not checked',
        remediation: 'pass process {minWallMm, minStrutMm, source}',
      });
    else {
      const named = (name: string, value: number | undefined): void => {
        if (value !== undefined) limits.push({ name, value, unit: 'mm', source: process.source, defaulted: false });
      };
      named('minWallMm', process.minWallMm);
      named('minPoreMm', process.minPoreMm);
      named('minStrutMm', process.minStrutMm);
      const test = (code: string, label: string, size: number | null, limit: number | undefined): void => {
        if (size === null || limit === undefined || toMm(doc, size) >= limit) return;
        add({
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
      };
      const measuredTest = (
        code: string,
        label: string,
        size: number,
        at: Vec3 | null,
        limit: number | undefined,
        resolution: number,
      ): void => {
        if (limit === undefined || toMm(doc, size) >= limit) return;
        const definite = toMm(doc, size) + toMm(doc, RESOLUTION_BAND * resolution) < limit;
        add({
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
      };
      if (typeof walls === 'string') {
        if (process.minPoreMm !== undefined) notEvaluated.push('minPoreMm');
      } else {
        if (process.minWallMm !== undefined && walls.wall.min !== null)
          measuredTest('IMP_CHECK_MIN_WALL', 'measured smallest wall', walls.wall.min, walls.wallAt, process.minWallMm, walls.voxel);
        if (process.minPoreMm !== undefined && walls.pore.min !== null)
          measuredTest('IMP_CHECK_MIN_PORE', 'measured smallest pore', walls.pore.min, walls.poreAt, process.minPoreMm, walls.voxel);
      }
      const measuredWall = typeof walls === 'string' ? null : walls.wall.min;
      if (process.buildDirection !== undefined) {
        if (
          process.criticalAngleDeg === undefined ||
          !(process.criticalAngleDeg > 0 && process.criticalAngleDeg <= 90) ||
          Math.hypot(...process.buildDirection) === 0
        )
          notEvaluated.push('overhang');
        else if (full !== null) {
          limits.push({ name: 'criticalAngleDeg', value: process.criticalAngleDeg, unit: 'deg', source: process.source, defaulted: false });
          const found = overhang(full, process.buildDirection, process.criticalAngleDeg);
          overhangResult = found;
          if (found.area > 0)
            add({
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
      }
      if (process.minWallMm !== undefined && wall === null && measuredWall === null) notEvaluated.push('minWallMm');
      if (process.minStrutMm !== undefined && strut === null) notEvaluated.push('minStrutMm');
      if (measuredWall === null) test('IMP_CHECK_MIN_WALL', 'smallest wall', wall, process.minWallMm);
      test('IMP_CHECK_MIN_STRUT', 'smallest strut diameter', strut, process.minStrutMm);
    }
    if (compiled.unverified)
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
    if (componentNote !== null) notEvaluated.push('components');
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
          smallestWall: wall,
          smallestStrutDiameter: strut,
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
  },
});
