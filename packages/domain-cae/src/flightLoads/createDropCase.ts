/** create_drop_case (14 FLL-M5, FR-FLL-06): the drop / hard-landing template of an explicit_dynamics case, composed from the explicit set-up commands. */

import { codedRejection } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { entityBoundsInDoc, boundsCorners } from '@core/geometry/bounds';
import { is3D, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { appendAll } from '@lib/appendAll';
import { caseOf } from '../shared/access';
import { refuseFll } from './codes';
import { analysedMassKg } from './rigidBalance';

/** Standard gravity, m/s^2 (ISO 80000-3): the named default of `gravityMps2`. */
const STANDARD_GRAVITY = 9.80665;
/** History samples of the default `historyInterval` (endTime / this). */
const DEFAULT_HISTORY_SAMPLES = 200;
const MAX_PARTS = 64;

const timeSchema = z.object({
  value: z.number().describe('Numeric value.'),
  unit: z.string().describe("Time unit, e.g. 's', 'ms', 'us'."),
});

interface Dropped {
  readonly impactVelocityMps: number;
  readonly normal: Vec3;
  readonly wallPoint: Vec3;
}

/** Unit normal of the ground plane: +Z, or +Z tilted by `tiltDegrees` about the horizontal axis `axis` ([x, y]); null for an invalid tilt. */
function groundNormal(
  orientation: 'level' | 'tilted',
  tiltDegrees: number | undefined,
  axis: readonly [number, number] | undefined,
): Vec3 | null {
  if (orientation === 'level') return tiltDegrees === undefined && axis === undefined ? [0, 0, 1] : null;
  const length = axis === undefined ? 1 : Math.hypot(axis[0], axis[1]);
  if (tiltDegrees === undefined || !(tiltDegrees > 0 && tiltDegrees < 90) || !(length > 0) || !Number.isFinite(length)) return null;
  const [ax, ay] = axis === undefined ? [1, 0] : [axis[0] / length, axis[1] / length];
  const angle = (tiltDegrees * Math.PI) / 180;
  return [ay * Math.sin(angle), -ax * Math.sin(angle), Math.cos(angle)];
}

/** The point of the plane with normal `normal` that touches the lowest bounding-box corner of the parts (document units). */
function touchingPoint(doc: CadDocument, partIds: readonly string[], normal: Vec3): Vec3 | null {
  let lowest: Vec3 | null = null;
  let depth = Infinity;
  for (const id of partIds) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined) return null;
    for (const corner of boundsCorners(entityBoundsInDoc(doc, entity))) {
      const along = corner[0] * normal[0] + corner[1] * normal[1] + corner[2] * normal[2];
      if (along < depth) {
        depth = along;
        lowest = corner;
      }
    }
  }
  return lowest !== null && lowest.every(Number.isFinite) ? lowest : null;
}

/** The 3D solids named, or the reason they cannot form the vehicle. */
function partsProblem(doc: CadDocument, partIds: readonly string[]): string | null {
  if (new Set(partIds).size !== partIds.length) return 'a part is listed twice';
  for (const id of partIds) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined) return `entity '${id}' does not exist`;
    if (!is3D(entity)) return `entity '${id}' is 2D (${entity.kind}); parts must be solids`;
  }
  return null;
}

interface Applied {
  readonly document: CadDocument;
  readonly affected: readonly string[];
}

/** Runs one nested set-up command; a refusal (or an empty change) becomes this command's coded refusal carrying the step's code. */
function step(
  original: CadDocument,
  current: CadDocument,
  name: string,
  params: Record<string, unknown>,
  ctx: ExecutionContext | undefined,
): Applied | CommandResult {
  const result = execute(current, name, params, ctx);
  if (result.rejected !== true && result.error === undefined && result.affected.length > 0)
    return { document: result.document, affected: result.affected };
  const error = result.error;
  return codedRejection(
    original,
    'create_drop_case',
    error?.code ?? 'FLL_DROP_STEP',
    `${name} did not apply - ${result.summary}`,
    error?.remediation ?? 'Fix the step named in the message.',
    error?.ids ?? [],
    error?.paths ?? [],
    error?.detail,
  );
}

const applied = (value: Applied | CommandResult): value is Applied => !('summary' in value);

/**
 * @affects doc.analysis.cases (adds 1 explicit_dynamics case: parts, controls, gravity, one initial velocity per part, one rigid wall; affected: [analysisId, wallId])
 * @invariant v0 = sqrt(2 g h) (VC-FLL-05) along -Z for every part; the wall is frictionless, normal = +Z (level) or +Z tilted, through the lowest bounding-box corner of the parts, so the parts touch it at t = 0 with the drop speed; ids `an-` / `rw-` / `iv-<step>.<k>`
 * @invariant composed only of create_analysis, set_part_idealization, set_explicit_controls, set_initial_velocity and add_rigid_wall: a refusal of any step refuses the whole command with that step's code
 * @failure unknown / 2D / duplicate / no parts -> FLL_DROP_PARTS; tilt on level or a bad tilted angle / axis -> FLL_DROP_ORIENTATION; height or gravity not > 0 -> FLL_DROP_PARAM; a nested step refusal (EXP_*, FEA_*) keeps its own code (all refusals, unchanged doc)
 */
export const createDropCase = defineCommand({
  name: 'create_drop_case',
  description:
    'Create the drop / hard-landing case of a vehicle (FR-FLL-06) as an explicit_dynamics analysis (solver llull_explicit) and return its id in ' +
    'affected[0] and the rigid wall id in affected[1]. The vehicle (`partIds`, 3D solids with a material) is released from `heightM` metres: ' +
    'every part starts at the impact speed v0 = sqrt(2 g h) pointing down (-Z; data.impactVelocityMps, e.g. 3.1316 m/s for 0.5 m), gravity g acts ' +
    'during the impact, and a frictionless rigid ground wall touches the lowest point of the parts (bounding-box corner) at t = 0, so the run ' +
    'simulates only the impact, not the fall. orientation level: horizontal ground (the vehicle as modelled, +Z up); tilted: the ground plane ' +
    'is tilted `tiltDegrees` (0..90) about the horizontal axis `tiltAxis` [x, y] (the vehicle lands that much rolled / pitched the other way). ' +
    'The document unit must be mm or m. endTime (time) bounds the simulated impact; historyInterval defaults to endTime / 200. Reports the vehicle ' +
    'mass (kg) and impact kinetic energy (J) when the parts have a material. Next: tune with set_explicit_controls / add_time_history, then the ' +
    'explicit_run transport and analysis_report / explicit_energy_check. Peak accelerations and stresses come from the run, not from this command.',
  params: z.object({
    name: z.string().min(1).optional().describe('Display name of the case. Default "drop <heightM> m <orientation>".'),
    partIds: z
      .array(z.string())
      .min(1)
      .max(MAX_PARTS)
      .describe('Ids of the 3D solid entities that make the vehicle (each with a material); the whole group falls together.'),
    heightM: z.number().positive().describe('Drop height in metres, > 0: the impact speed is sqrt(2 g h).'),
    orientation: z.enum(['level', 'tilted']).describe('level: horizontal ground. tilted: ground tilted by tiltDegrees about tiltAxis.'),
    tiltDegrees: z
      .number()
      .optional()
      .describe('tilted only, REQUIRED there: tilt of the ground plane from horizontal in degrees, in (0, 90).'),
    tiltAxis: z
      .tuple([z.number(), z.number()])
      .optional()
      .describe('tilted only: horizontal axis [x, y] the ground is tilted about (not both zero). Default [1, 0] (the X axis).'),
    gravityMps2: z
      .number()
      .positive()
      .optional()
      .describe('Gravity magnitude in m/s^2, applied along -Z; default 9.80665 (standard gravity) and named as such in the summary.'),
    endTime: timeSchema.describe('Simulated end time {value, unit} counted from first contact, > 0 (a few impact periods, e.g. 10 ms).'),
    historyInterval: timeSchema.optional().describe('Sampling interval of the histories, 0 < interval <= endTime. Default endTime / 200.'),
    mesh: z
      .object({
        kind: z
          .enum(['structured_hex', 'fea_mesh'])
          .describe('structured_hex (llull grid on unrotated boxes) or fea_mesh (the case mesh artifact, tet4).'),
        size: z.number().optional().describe('structured_hex only: element edge in document units, > 0.'),
      })
      .optional()
      .describe('Mesh source of the explicit solver; default fea_mesh.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { partIds, heightM, orientation } = params;
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseFll(doc, 'create_drop_case', code, message, ids, paths);
    const gravity = params.gravityMps2 ?? STANDARD_GRAVITY;
    if (!(heightM > 0) || !Number.isFinite(heightM) || !(gravity > 0) || !Number.isFinite(gravity))
      return fail('FLL_DROP_PARAM', 'heightM and gravityMps2 must be finite and > 0', [], ['heightM']);
    const problem = partsProblem(doc, partIds);
    if (problem !== null) return fail('FLL_DROP_PARTS', problem, partIds, ['partIds']);
    const normal = groundNormal(orientation, params.tiltDegrees, params.tiltAxis);
    if (normal === null)
      return fail('FLL_DROP_ORIENTATION', `tilt does not fit orientation '${orientation}'`, [], ['orientation', 'tiltDegrees', 'tiltAxis']);
    const wallPoint = touchingPoint(doc, partIds, normal);
    if (wallPoint === null) return fail('FLL_DROP_PARTS', 'the parts have no finite bounds', partIds, ['partIds']);
    const dropped: Dropped = { impactVelocityMps: Math.sqrt(2 * gravity * heightM), normal, wallPoint };
    const tiltText = params.tiltDegrees === undefined ? '' : ` ${params.tiltDegrees} deg`;
    const caseName = params.name ?? `drop ${heightM} m ${orientation}`;

    let current = doc;
    const affected: string[] = [];
    const run = (name: string, stepParams: Record<string, unknown>): CommandResult | null => {
      const outcome = step(doc, current, name, stepParams, ctx);
      if (!applied(outcome)) return outcome;
      current = outcome.document;
      appendAll(affected, outcome.affected);
      return null;
    };
    const created = run('create_analysis', { name: caseName, analysisType: 'explicit_dynamics', solver: 'llull_explicit' });
    if (created !== null) return created;
    const analysisId = affected[0] ?? '';
    const history = params.historyInterval ?? { value: params.endTime.value / DEFAULT_HISTORY_SAMPLES, unit: params.endTime.unit };
    const steps: readonly (readonly [string, Record<string, unknown>])[] = [
      ...partIds.map((entityId): readonly [string, Record<string, unknown>] => ['set_part_idealization', { analysisId, entityId }]),
      [
        'set_explicit_controls',
        {
          analysisId,
          endTime: params.endTime,
          historyInterval: history,
          gravity: { vector: [0, 0, -gravity], unit: 'm/s^2' },
          ...(params.mesh !== undefined ? { mesh: params.mesh } : {}),
        },
      ],
      ...partIds.map((entityId): readonly [string, Record<string, unknown>] => [
        'set_initial_velocity',
        { analysisId, entityId, velocity: { vector: [0, 0, -dropped.impactVelocityMps], unit: 'm/s' } },
      ]),
      ['add_rigid_wall', { analysisId, name: 'ground', point: wallPoint, normal }],
    ];
    for (const [name, stepParams] of steps) {
      const refused = run(name, stepParams);
      if (refused !== null) return refused;
    }
    const wallId = affected[affected.length - 1] ?? '';
    const analysis = caseOf(current, analysisId);
    const mass = analysis === undefined ? 'no analysis' : analysedMassKg(current, analysis, ctx);
    const massKg = typeof mass === 'number' ? mass : null;
    const energyJ = massKg === null ? null : 0.5 * massKg * dropped.impactVelocityMps ** 2;
    return {
      document: current,
      summary:
        `create_drop_case: ${analysisId} '${caseName}': ${partIds.length} part(s) drop ${heightM} m ${orientation}${tiltText} onto wall ${wallId}, ` +
        `impact speed ${dropped.impactVelocityMps.toFixed(4)} m/s (sqrt(2 g h), g ${gravity} m/s^2${params.gravityMps2 === undefined ? ', standard gravity default' : ''}), ` +
        `${massKg === null ? `mass unknown (${String(mass)})` : `mass ${massKg.toPrecision(6)} kg, impact energy ${(energyJ ?? 0).toPrecision(6)} J`}` +
        `${params.historyInterval === undefined ? `; history interval endTime / ${DEFAULT_HISTORY_SAMPLES} (default)` : ''}. Next: explicit_run.`,
      affected: [analysisId, wallId],
      data: {
        analysisId,
        wallId,
        impactVelocityMps: dropped.impactVelocityMps,
        gravityMps2: gravity,
        heightM,
        orientation,
        groundNormal: dropped.normal,
        wallPoint: dropped.wallPoint,
        massKg,
        impactEnergyJ: energyJ,
      },
    };
  },
});
