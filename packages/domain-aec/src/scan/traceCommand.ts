/**
 * trace_pipe_centreline (TECHNICAL_SPEC §4.2, §5.6, FR-SCN-14): the native tracer (`llull-cloud` op `trace`) follows a pipe from a seed through
 * straights and bends; this command converts units, snaps the DN and returns a record ready for commit_asbuilt_extraction (one pipe run
 * through every PI). Read-only: nothing here reads points into the document (TR-SCN-04).
 */

import type { RegionSpec } from '@aec/scan/types';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { isRecord } from '@lib/isRecord';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, numberAt, runOp } from './compute';
import { pendingExtraction, snapDn, unverifiedReasons, type DnSnap } from './extraction';
import { fromM, scanOf, toM, vecFromM, vecToM } from './model';
import { regionSpec, resolveRegion } from './region';
import { cloudIdParam, regionParam, seedParam } from './schemas';

/** The native tracer's default `maxLength` (llull-cloud `TraceSettings::default`). */
const DEFAULT_MAX_LENGTH_M = 50;

type Record3 = Readonly<Record<string, unknown>>;

const records = (value: unknown): Record3[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Document-unit copy of a native record: the named point keys and length keys are converted, everything else is kept. */
function inUnits(doc: CadDocument, source: Record3, points: readonly string[], lengths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  for (const key of points) if (Array.isArray(source[key])) out[key] = vecFromM(doc, source[key] as number[]);
  for (const key of lengths) if (typeof source[key] === 'number') out[key] = fromM(doc, source[key]);
  return out;
}

const warningsOf = (result: Record3): { code: string; message: string }[] =>
  records(result['warnings']).flatMap((w) =>
    typeof w['code'] === 'string' ? [{ code: w['code'], message: String(w['message'] ?? '') }] : [],
  );

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; bad region -> SCN_CROP_*; seed not on a pipe / no cylinder -> SCN_FIT_NO_MODEL; < 30 points
 *   around the seed -> SCN_FIT_TOO_FEW_POINTS; region above the load cap -> SCN_QUERY_LIMIT; non-positive length / angle -> SCN_PARAM_INVALID;
 *   no binary -> NATIVE_TOOL_MISSING
 */
export const tracePipeCentreline = defineCommand({
  name: 'trace_pipe_centreline',
  description:
    'Read-only: trace a pipe through the cloud from a seed point on it. Native: a seeded RANSAC cylinder at the seed, then fixed-radius ' +
    'axis fits in windows along the pipe (step default 2 r); a turn above bendDetectionDeg ends a straight, the next straight is found ' +
    'beyond the bend and the bend radius is fitted on the surface points (torus / arc), its angle and the intersection point (PI) of the two ' +
    'axes computed; a radius step of more than 15 % is a reducer candidate. data: centreline (start, PIs, end: the polyline add_pipe_run ' +
    'takes), straights[] (start, end, radius, rms, inliers), bends[] (intersectionPoint, angleDeg, radius, tubeRadius, centre, ' +
    'tangent points, rms), reducers[], intersectionPoints[], diameter (length-weighted mean OD with its spread) and its DN snap (EN 10220 ' +
    'table, insulationThickness subtracted), rms, ends (why each end stopped), warnings (SCN_TRACE_SKEW when the next straight misses the ' +
    'axis by more than skewTolerance; SCN_TRACE_BEND_RADIUS_UNMEASURED) and extractions[0].extraction for commit_asbuilt_extraction, which ' +
    'creates the as-built run through every PI. The cloud is read inside `region` (default: a sphere of maxLength around the seed). Same ' +
    'seed point and rngSeed = same result.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    seed: z
      .array(z.number())
      .length(3)
      .describe(
        '[x, y, z] a point on the pipe (document units), e.g. nearest_cloud_point on its surface; the trace walks both ways from it.',
      ),
    region: regionParam.optional(),
    sizeTable: z.enum(['en10220', 'none']).optional().describe('Size table for the DN snap (default en10220).'),
    insulationThickness: z
      .number()
      .optional()
      .describe('Insulation thickness in document units, subtracted from the radius (default 0, named).'),
    toleranceMm: z.number().optional().describe('OD snap tolerance in mm (default 1.5, OUTSIDE_DIAMETER_TOLERANCE_MM).'),
    stepLength: z.number().optional().describe('Window spacing along the pipe, document units (default 2 x the radius).'),
    maxLength: z.number().optional().describe('Longest trace and default region radius, document units (default 50 m).'),
    bendDetectionDeg: z.number().optional().describe('Turn between windows that ends a straight, degrees (default 3).'),
    seedRadius: z
      .number()
      .optional()
      .describe('Radius of the sphere around the seed for the first cylinder, document units (default 0.5 m).'),
    skewTolerance: z
      .number()
      .optional()
      .describe('Largest gap between two straight axes meeting at a PI, document units (default max(1 mm, r / 10)).'),
    minRadius: z.number().optional().describe('Smallest pipe radius of the first fit, document units (default 5 mm).'),
    maxRadius: z.number().optional().describe('Largest pipe radius of the first fit, document units (default 2 m).'),
    noiseSigma: z.number().optional().describe('Scanner noise sigma in document units, when known: inlier band 3 sigma.'),
    distanceThreshold: z
      .number()
      .optional()
      .describe('Explicit inlier band in document units (default 3 x noiseSigma, else 2.5 x the median spacing).'),
    normalThresholdDeg: z
      .number()
      .optional()
      .describe('Largest angle between a point normal and the model normal for an inlier, degrees (default 20).'),
    rngSeed: seedParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const command = 'trace_pipe_centreline';
    const { cloudId, seed, sizeTable = 'en10220', insulationThickness = 0, toleranceMm, region, rngSeed } = params;
    const positive: [string, number | undefined][] = [
      ['toleranceMm', toleranceMm],
      ['stepLength', params.stepLength],
      ['maxLength', params.maxLength],
      ['bendDetectionDeg', params.bendDetectionDeg],
      ['seedRadius', params.seedRadius],
      ['skewTolerance', params.skewTolerance],
      ['minRadius', params.minRadius],
      ['maxRadius', params.maxRadius],
      ['noiseSigma', params.noiseSigma],
      ['distanceThreshold', params.distanceThreshold],
      ['normalThresholdDeg', params.normalThresholdDeg],
    ];
    for (const [key, value] of positive)
      if (value !== undefined && !(value > 0)) return refuseScan(doc, command, 'SCN_PARAM_INVALID', `${key} must be > 0`, [cloudId], [key]);
    if (insulationThickness < 0)
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'insulationThickness must be >= 0', [cloudId], ['insulationThickness']);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const resolved = region === undefined ? undefined : resolveRegion(doc, region);
    if (resolved !== undefined && !resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [cloudId], ['region']);
    const length = (value: number | undefined): number | undefined => (value === undefined ? undefined : toM(doc, value));
    const native: Record<string, unknown> = { seedPoint: vecToM(doc, seed), seed: rngSeed ?? 1 };
    for (const [key, value] of [
      ['stepLength', length(params.stepLength)],
      ['maxLength', length(params.maxLength)],
      ['seedRadius', length(params.seedRadius)],
      ['skewTolerance', length(params.skewTolerance)],
      ['minRadius', length(params.minRadius)],
      ['maxRadius', length(params.maxRadius)],
      ['noiseSigma', length(params.noiseSigma)],
      ['distanceThreshold', length(params.distanceThreshold)],
      ['bendDetectionDeg', params.bendDetectionDeg],
      ['normalThresholdDeg', params.normalThresholdDeg],
      ['region', resolved?.ok === true ? resolved.region : undefined],
    ] as const)
      if (value !== undefined) native[key] = value;
    const ran = runOp(doc, command, access.port, 'trace', [access.cloud], native);
    if (!isSuccess(ran)) return ran;
    const result = ran.result;
    const straights = records(result['straights']);
    if (straights.length === 0 || !Array.isArray(result['centreline']))
      return refuseScan(doc, command, 'NATIVE_PROTOCOL', 'the trace answered without a centreline', [cloudId]);
    const warnings = warningsOf(result);
    const codes = warnings.map((w) => w.code);
    const reasons = unverifiedReasons(scanOf(doc), access.cloud, codes);
    const provenance = {
      method: 'ransac+lm centreline trace',
      algorithmVersion: `${ran.provenance.binary}/trace-1`,
      seed: rngSeed ?? 1,
      device: ran.provenance.device,
      deterministic: ran.provenance.deterministic,
    };
    const radius = numberAt(result, 'radius');
    const odMm = 2 * (radius - toM(doc, insulationThickness)) * 1000;
    const snapped: DnSnap | undefined = sizeTable === 'en10220' ? snapDn(odMm, toleranceMm) : undefined;
    if (snapped !== undefined && snapped.dn === null)
      warnings.push({
        code: 'SCN_FIT_NO_STANDARD_SIZE',
        message: `OD ${odMm.toFixed(2)} mm is not within ${snapped.toleranceMm} mm of a table size; the measured OD was kept`,
      });
    const first = straights[0] as Record3;
    const last = straights[straights.length - 1] as Record3;
    const centreline = (result['centreline'] as number[][]).map((p) => vecFromM(doc, p));
    // The stored fit holds every number of the commit in metres (the commit never reads the cloud): the run's polyline, its bends and radius.
    const fit = {
      start: first['start'],
      end: last['end'],
      radius,
      centreline: result['centreline'],
      straights,
      bends: result['bends'],
      reducers: result['reducers'],
      rms: result['rms'],
      inliers: result['inliers'],
      pointsInRegion: result['pointsInRegion'],
      warnings: result['warnings'],
      insulationThicknessM: toM(doc, insulationThickness),
    };
    const stored: RegionSpec =
      region !== undefined
        ? regionSpec(region)
        : { kind: 'seed', point: [seed[0] ?? 0, seed[1] ?? 0, seed[2] ?? 0], radius: params.maxLength ?? fromM(doc, DEFAULT_MAX_LENGTH_M) };
    const extraction = pendingExtraction(access.cloud, stored, fit, snapped, reasons, provenance);
    const bends = records(result['bends']).map((b) =>
      inUnits(doc, b, ['intersectionPoint', 'centre', 'tangentStart', 'tangentEnd'], ['radius', 'tubeRadius', 'skew', 'rms']),
    );
    const diameter = isRecord(result['diameter']) ? inUnits(doc, result['diameter'], [], ['value', 'std']) : null;
    const reducers = records(result['reducers']).map((r) => inUnits(doc, r, ['position'], ['radiusBefore', 'radiusAfter']));
    return report(
      doc,
      `trace_pipe_centreline on ${cloudId}: ${straights.length} straight(s), ${bends.length} bend(s), ${centreline.length} centreline points, ` +
        `${snapped !== undefined && snapped.dn !== null ? `DN${snapped.dn}` : 'no standard size'} (OD ${odMm.toFixed(2)} mm), ends ${String(
          (result['ends'] as Record3 | undefined)?.['start'],
        )} / ${String((result['ends'] as Record3 | undefined)?.['end'])}${codes.length > 0 ? ` [${[...new Set(codes)].join(', ')}]` : ''}. ` +
        'Commit with commit_asbuilt_extraction extraction=<data.extractions[0].extraction>.',
      {
        cloudId,
        unit: doc.units,
        centreline,
        straights: straights.map((s) => inUnits(doc, s, ['start', 'end'], ['radius', 'length', 'rms'])),
        bends,
        intersectionPoints: bends.map((b) => b['intersectionPoint']),
        reducers,
        diameter,
        measuredOdMm: odMm,
        snapped,
        rms: fromM(doc, numberAt(result, 'rms')),
        inliers: result['inliers'],
        ends: result['ends'],
        stepLength: fromM(doc, numberAt(result, 'stepLength')),
        threshold: inUnits(doc, isRecord(result['threshold']) ? result['threshold'] : {}, [], ['value', 'spacing']),
        warnings,
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
        provenance,
        extractions: [{ extraction, snapped, measuredOdMm: odMm, unverified: reasons.length > 0 }],
      },
    );
  },
});
