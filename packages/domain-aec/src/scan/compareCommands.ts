/**
 * cloud_to_model_deviation and check_asbuilt_clash (TECHNICAL_SPEC §4.2, §5.9, §5.10, FR-SCN-17..19): queries whose numbers come from the
 * Rust-CPU path of `llull-compute cloud op`; `device: "gpu"` (RS-4) changes how the native job gets there, never the recorded numbers.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, numberAt, runOp } from './compute';
import { resolveDesign, type DesignEntity } from './designPrimitives';
import { fromM, scanOf, toM, vecFromM } from './model';
import { cloudIdParam, deviceParam } from './schemas';

/** AF-33: every scan comparison feeding a tie-in is reviewed. */
const DEVIATION_REVIEW = 'tie-in dimensions from a scan — field-verify before fabrication';
const CLASH_REVIEW = 'a "clear" result from a scan is not proof of absence (occlusion, scan gaps): field-verify before fabrication';
/** Named default of the clash noise threshold (AF-31, TECHNICAL_SPEC §5.10). */
export const DEFAULT_MIN_POINTS_IN_VOLUME = 10;
/** Named default reach for the gap of a clear entity (metres). */
export const DEFAULT_CLASH_SEARCH_M = 1.0;

const entityIdsParam = z
  .array(z.string())
  .min(1)
  .describe('Design entity ids: pipe runs (add_pipe_run ids), cylinders, boxes, spheres or any 3D solid.');

function designs(
  doc: CadDocument,
  command: string,
  ids: readonly string[],
  tessellated: boolean,
  segments: number,
): DesignEntity[] | CommandResult {
  const out: DesignEntity[] = [];
  for (const id of ids) {
    const resolved = resolveDesign(doc, id, tessellated, segments);
    if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [id], ['entityIds']);
    out.push(resolved.entity);
  }
  return out;
}

const wire = (entities: readonly DesignEntity[]): Record<string, unknown>[] =>
  entities.map((e) => ({ id: e.id, primitives: e.primitives, ...(e.pipe !== undefined ? { pipe: e.pipe } : {}) }));

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; unknown / 2D entity -> SCN_ENTITY_NOT_FOUND / SCN_ENTITY_UNSUPPORTED; maxDistance or threshold
 *   <= 0, segments < 8 -> SCN_PARAM_INVALID; no binary -> NATIVE_TOOL_MISSING
 */
export const cloudToModelDeviation = defineCommand({
  name: 'cloud_to_model_deviation',
  description:
    'Read-only: as-built vs design. For each entity, the signed distance of every scan point within maxDistance of it (each point to its ' +
    'nearest entity): min / max / mean / rms, fraction beyond threshold, histogram, points used, and the model error bound (0 for the ' +
    'analytic primitives - pipe runs, cylinders, boxes, spheres; the sagitta r(1 - cos(pi/segments)) in "tessellated" mode). A straight pipe ' +
    'also gets its fitted axis offset ("the line is 25 mm low") and radius delta. Distances in document units. reviewRequired is always true. ' +
    'device "gpu" (RS-4): a picture of the per-point distances on the GPU (deterministic false); the numbers stay those of the Rust CPU path.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    entityIds: entityIdsParam,
    model: z.enum(['analytic', 'tessellated']).optional().describe('analytic (default, exact) or tessellated (facetted at `segments`).'),
    segments: z
      .number()
      .int()
      .optional()
      .describe('Facets around a circle in tessellated mode (default 24, the display tessellation; >= 8).'),
    maxDistance: z.number().describe('Only points within this distance of an entity count (document units), e.g. 100.'),
    threshold: z.number().describe('Deviation threshold for fractionBeyondThreshold (document units), e.g. 10.'),
    signed: z.boolean().optional().describe('Signed distances (negative inside; default true).'),
    histogramBins: z.number().int().min(1).max(200).optional().describe('Histogram bins (default 20).'),
    device: deviceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const {
      cloudId,
      entityIds,
      model = 'analytic',
      segments = 24,
      maxDistance,
      threshold,
      signed = true,
      histogramBins = 20,
      device = 'cpu',
    } = params;
    const command = 'cloud_to_model_deviation';
    if (!(maxDistance > 0) || !(threshold > 0))
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'maxDistance and threshold must be > 0', [cloudId], ['maxDistance']);
    if (segments < 8) return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'segments must be >= 8', [cloudId], ['segments']);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const entities = designs(doc, command, entityIds, model === 'tessellated', segments);
    if (!Array.isArray(entities)) return entities;
    const ran = runOp(doc, command, access.port, 'deviation', [access.cloud], {
      entities: wire(entities),
      maxDistance: toM(doc, maxDistance),
      threshold: toM(doc, threshold),
      signed,
      histogramBins,
      device,
    });
    if (!isSuccess(ran)) return ran;
    const rows = (ran.result['entities'] as Record<string, unknown>[] | undefined) ?? [];
    const length = (value: unknown): number | null => (typeof value === 'number' ? fromM(doc, value) : null);
    const results = rows.map((row, i) => {
      const pipe = row['pipe'] as Record<string, unknown> | undefined;
      const bound = entities[i]?.modelErrorBound ?? null;
      return {
        entityId: row['id'],
        pointsUsed: row['pointsUsed'],
        min: length(row['min']),
        max: length(row['max']),
        mean: length(row['mean']),
        rms: length(row['rms']),
        fractionBeyondThreshold: row['fractionBeyondThreshold'] ?? null,
        histogram: { low: signed ? -maxDistance : 0, high: maxDistance, counts: row['histogram'] },
        modelErrorBound: bound === null ? null : fromM(doc, bound),
        ...(bound === null ? { modelErrorBoundReason: 'not derived for this tessellation (display triangles of a general solid)' } : {}),
        ...(pipe !== undefined
          ? {
              fittedAxisOffset: length(pipe['fittedAxisOffset']),
              offsetVector: vecFromM(doc, pipe['offsetVector'] as number[]),
              radiusDelta: length(pipe['radiusDelta']),
            }
          : {}),
      };
    });
    const gpu = ran.result['gpu'];
    const data = {
      cloudId,
      unit: doc.units,
      model,
      ...(model === 'tessellated' ? { segments } : {}),
      results,
      pointsInRange: ran.result['pointsInRange'],
      threshold,
      reviewRequired: { value: true, reason: DEVIATION_REVIEW },
      provenance: { ...ran.provenance, numbers: 'Rust CPU (deterministic)' },
      ...(ran.warnings !== undefined ? { nativeWarnings: ran.warnings } : {}),
      ...(gpu !== undefined ? { gpu } : {}),
    };
    const worst = results.reduce((m, r) => Math.max(m, Math.abs(r.max ?? 0), Math.abs(r.min ?? 0)), 0);
    return report(
      doc,
      `Deviation of ${results.length} entit${results.length === 1 ? 'y' : 'ies'} from ${cloudId}: largest |d| ${worst.toPrecision(4)} ${doc.units}. ${DEVIATION_REVIEW}.`,
      data,
    );
  },
});

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; unknown / 2D entity -> SCN_ENTITY_*; clearance < 0, minPointsInVolume < 1 -> SCN_PARAM_INVALID
 */
export const checkAsbuiltClash = defineCommand({
  name: 'check_asbuilt_clash',
  description:
    'Read-only design-vs-scan clash: for each design entity, scan points inside it (hard) or within `clearance` of it, grouped in clusters ' +
    '(voxels of 2 x the point spacing, 26-connected); a cluster counts only with >= minPointsInVolume points (named default 10, so rain or ' +
    'people in the scan are noise). Per entity: status hard | clearance | clear, minGap (negative = penetration), location, points, ' +
    'clusters, and the sampling bound (spacing / 2). An as-built run committed from this cloud ignores its own surface points. ' +
    'reviewRequired is always true: a clear result from a scan is not proof of absence. device "gpu" (RS-4) prunes far points on the GPU ' +
    'with a conservative bound and re-checks the rest in f64 on the CPU: same result.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    entityIds: entityIdsParam,
    clearance: z.number().describe('Required clearance in document units, e.g. 75 (mm).'),
    minPointsInVolume: z
      .number()
      .int()
      .optional()
      .describe(`Noise threshold: points a cluster needs (default ${DEFAULT_MIN_POINTS_IN_VOLUME}, named).`),
    searchDistance: z.number().optional().describe('Reach for the gap of a clear entity in document units (default 1 m).'),
    excludeExtractionsOf: z.boolean().optional().describe("Ignore an as-built run's own scan points (default true)."),
    device: deviceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { cloudId, entityIds, clearance, minPointsInVolume, searchDistance, excludeExtractionsOf = true, device = 'cpu' } = params;
    const command = 'check_asbuilt_clash';
    if (!(clearance >= 0)) return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'clearance must be >= 0', [cloudId], ['clearance']);
    if (minPointsInVolume !== undefined && minPointsInVolume < 1)
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'minPointsInVolume must be >= 1', [cloudId], ['minPointsInVolume']);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const entities = designs(doc, command, entityIds, false, 24);
    if (!Array.isArray(entities)) return entities;
    const extractions = scanOf(doc).extractions;
    const exclude = entities.map((e) => {
      const source =
        e.asBuilt !== undefined && Object.hasOwn(extractions, e.asBuilt.extractionId) ? extractions[e.asBuilt.extractionId] : undefined;
      if (!excludeExtractionsOf || source === undefined || source.cloudId !== cloudId) return null;
      const spacing = numberAt((source.fit['threshold'] as Record<string, unknown> | undefined) ?? {}, 'spacing');
      return 3 * (Number.isFinite(spacing) && spacing > 0 ? spacing : 0.01);
    });
    const minPoints = minPointsInVolume ?? DEFAULT_MIN_POINTS_IN_VOLUME;
    const ran = runOp(doc, command, access.port, 'clash', [access.cloud], {
      entities: wire(entities),
      clearance: toM(doc, clearance),
      minPointsInVolume: minPoints,
      searchDistance: searchDistance !== undefined ? toM(doc, searchDistance) : DEFAULT_CLASH_SEARCH_M,
      exclude,
      device,
    });
    if (!isSuccess(ran)) return ran;
    const length = (value: unknown): number | null => (typeof value === 'number' ? fromM(doc, value) : null);
    const rows = (ran.result['results'] as Record<string, unknown>[] | undefined) ?? [];
    const results = rows.map((row) => ({
      entityId: row['id'],
      status: row['status'],
      minGap: length(row['minGap']),
      location: Array.isArray(row['location']) ? vecFromM(doc, row['location'] as number[]) : null,
      points: row['points'],
      noisePoints: row['noisePoints'],
      excludedPoints: row['excludedPoints'],
      clusters: ((row['clusters'] as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
        points: c['points'],
        status: c['status'],
        minGap: length(c['minGap']),
        location: vecFromM(doc, c['location'] as number[]),
        bboxMin: vecFromM(doc, c['bboxMin'] as number[]),
        bboxMax: vecFromM(doc, c['bboxMax'] as number[]),
      })),
    }));
    const warnings = results.flatMap((r) =>
      r.status === 'hard'
        ? [{ severity: 'fail', code: 'SCN_CLASH_FOUND', ids: [r.entityId], message: `hard clash, gap ${String(r.minGap)} ${doc.units}` }]
        : r.status === 'clearance'
          ? [
              {
                severity: 'warn',
                code: 'SCN_CLEARANCE_VIOLATION',
                ids: [r.entityId],
                message: `gap ${String(r.minGap)} ${doc.units} below ${clearance}`,
              },
            ]
          : [],
    );
    const data = {
      cloudId,
      unit: doc.units,
      clearance,
      results,
      minPointsInVolume: {
        value: minPoints,
        source: 'TECHNICAL_SPEC §5.10 named default (AF-31)',
        defaulted: minPointsInVolume === undefined,
      },
      samplingBound: length(ran.result['samplingBound']),
      warnings,
      reviewRequired: { value: true, reason: CLASH_REVIEW },
      provenance: ran.provenance,
      ...(ran.warnings !== undefined ? { nativeWarnings: ran.warnings } : {}),
      ...(ran.result['gpu'] !== undefined ? { gpu: ran.result['gpu'] } : {}),
    };
    const counts = ['hard', 'clearance', 'clear'].map((s) => `${results.filter((r) => r.status === s).length} ${s}`).join(', ');
    return report(doc, `As-built clash on ${cloudId}: ${counts}. ${CLASH_REVIEW}.`, data);
  },
});
