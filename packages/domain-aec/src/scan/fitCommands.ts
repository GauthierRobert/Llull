/** fit_primitive and extract_pipes (TECHNICAL_SPEC §4.2, §5.5, §5.6): native RANSAC + LM fits; queries only (TR-SCN-04). */

import type { RegionSpec } from '@core/model/pointCloud';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, numberAt, runOp } from './compute';
import { pendingExtraction, snapDn, unverifiedReasons, type DnSnap } from './extraction';
import { fromM, scanOf, toM, vecFromM } from './model';
import { regionSpec, resolveRegion, type RegionInput } from './region';
import { cloudIdParam, regionParam, seedParam } from './schemas';

/** Lengths of a native fit result in document units (vectors and scalars; directions, angles, counts and covariances unchanged). */
const LENGTH_VECTORS = ['axisPoint', 'start', 'end', 'centre', 'point'];
const LENGTH_SCALARS = ['radius', 'length', 'rms'];

export function fitInDocumentUnits(doc: CadDocument, fit: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fit };
  for (const key of LENGTH_VECTORS) if (Array.isArray(fit[key])) out[key] = vecFromM(doc, fit[key] as number[]);
  for (const key of LENGTH_SCALARS) if (typeof fit[key] === 'number') out[key] = fromM(doc, fit[key]);
  const scaleStd = (std: unknown): unknown =>
    std !== null && typeof std === 'object'
      ? Object.fromEntries(Object.entries(std).map(([k, v]) => [k, typeof v === 'number' && !k.endsWith('Deg') ? fromM(doc, v) : v]))
      : std;
  out['std'] = scaleStd(fit['std']);
  out['crlb'] = scaleStd(fit['crlb']);
  const threshold = fit['threshold'] as { value?: number; spacing?: number; source?: string } | undefined;
  if (threshold !== undefined)
    out['threshold'] = { ...threshold, value: fromM(doc, threshold.value ?? 0), spacing: fromM(doc, threshold.spacing ?? 0) };
  out['covarianceUnits'] = 'SI (metres, radians), parameters as listed in the method';
  out['unit'] = doc.units;
  return out;
}

const warningCodes = (fit: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(fit['warnings'])
    ? (fit['warnings'] as { code?: string }[]).flatMap((w) => (typeof w.code === 'string' ? [w.code] : []))
    : [];

const fitParams = {
  noiseSigma: z
    .number()
    .optional()
    .describe('Scanner noise sigma in document units, when known: inlier band 3 sigma and the CRLB at sigma.'),
  distanceThreshold: z
    .number()
    .optional()
    .describe('Explicit inlier band in document units (default 3 x noiseSigma, else 2.5 x the median point spacing).'),
  normalThresholdDeg: z
    .number()
    .optional()
    .describe('Largest angle between a point normal and the model normal for an inlier, degrees (default 20).'),
  seed: seedParam,
};

interface Prepared {
  readonly region: RegionSpec;
  readonly params: Record<string, unknown>;
}

function prepare(
  doc: CadDocument,
  command: string,
  cloudId: string,
  region: RegionInput,
  options: {
    noiseSigma?: number | undefined;
    distanceThreshold?: number | undefined;
    normalThresholdDeg?: number | undefined;
    seed?: number | undefined;
    minRadius?: number | undefined;
    maxRadius?: number | undefined;
  },
): Prepared | CommandResult {
  const resolved = resolveRegion(doc, region);
  if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [cloudId], ['region']);
  for (const [key, value] of Object.entries(options))
    if (value !== undefined && key !== 'seed' && !(value > 0))
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', `${key} must be > 0`, [cloudId], [key]);
  const length = (value: number | undefined): number | undefined => (value === undefined ? undefined : toM(doc, value));
  const params: Record<string, unknown> = { region: resolved.region, seed: options.seed ?? 1 };
  for (const [key, value] of [
    ['noiseSigma', length(options.noiseSigma)],
    ['distanceThreshold', length(options.distanceThreshold)],
    ['normalThresholdDeg', options.normalThresholdDeg],
    ['minRadius', length(options.minRadius)],
    ['maxRadius', length(options.maxRadius)],
  ] as const)
    if (value !== undefined) params[key] = value;
  return { region: regionSpec(region), params };
}

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; bad region -> SCN_CROP_*; < 30 (cylinder) / 10 points -> SCN_FIT_TOO_FEW_POINTS; no model with
 *   20 % inliers -> SCN_FIT_NO_MODEL; no binary -> NATIVE_TOOL_MISSING
 */
export const fitPrimitive = defineCommand({
  name: 'fit_primitive',
  description:
    'Read-only: fit a plane, cylinder or sphere to the cloud points of a region (native seeded RANSAC on PCA-oriented points, then ' +
    'Levenberg-Marquardt on the orthogonal distance, inliers re-selected until stable). data: the parameters in document units and frame, ' +
    'inliers, rms, coverageDeg (cylinder / sphere; below 60 deg: SCN_FIT_LOW_COVERAGE, unverified), covariance (SI), std and crlb, the named ' +
    'threshold, warnings, and for a cylinder an `extraction` ready for commit_asbuilt_extraction. Same seed = same result. For circles in a ' +
    'section use slice_cloud fit=circle.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    kind: z.enum(['plane', 'cylinder', 'sphere']).describe('Primitive to fit.'),
    region: regionParam,
    ...fitParams,
  }),
  run: (doc, { cloudId, kind, region, ...options }, ctx): CommandResult => {
    const command = 'fit_primitive';
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const prepared = prepare(doc, command, cloudId, region, options);
    if (!('params' in prepared)) return prepared;
    const ran = runOp(doc, command, access.port, 'fit', [access.cloud], { ...prepared.params, kind });
    if (!isSuccess(ran)) return ran;
    const fit = ran.result;
    const codes = warningCodes(fit);
    const reasons = unverifiedReasons(scanOf(doc), access.cloud, codes);
    const provenance = {
      method: `ransac+lm ${kind}`,
      algorithmVersion: `${ran.provenance.binary}/fit-1`,
      seed: options.seed ?? 1,
      device: ran.provenance.device,
      deterministic: ran.provenance.deterministic,
    };
    const data = {
      ...fitInDocumentUnits(doc, fit),
      cloudId,
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
      provenance,
      ...(kind === 'cylinder' ? { extraction: pendingExtraction(access.cloud, prepared.region, fit, undefined, reasons, provenance) } : {}),
    };
    const size = kind === 'cylinder' || kind === 'sphere' ? ` r ${fromM(doc, numberAt(fit, 'radius')).toPrecision(6)} ${doc.units}` : '';
    return report(
      doc,
      `fit_primitive ${kind} on ${cloudId}:${size}, ${numberAt(fit, 'inliers')} inliers, rms ${fromM(doc, numberAt(fit, 'rms')).toPrecision(4)} ${doc.units}${codes.length > 0 ? ` [${codes.join(', ')}]` : ''}.`,
      data,
    );
  },
});

/**
 * @failure as fit_primitive; insulationThickness < 0 or toleranceMm <= 0 -> SCN_PARAM_INVALID
 */
export const extractPipes = defineCommand({
  name: 'extract_pipes',
  description:
    "Read-only: extract the pipe in a region (one per call in this version): native cylinder fit, ends from the inliers' axial extent, and " +
    "the DN snap of OD = 2 (r - insulationThickness) on llull's EN 10220 / ASME B36.10M table within toleranceMm (named default 1.5 mm). " +
    'No table row within the tolerance: SCN_FIT_NO_STANDARD_SIZE and the measured OD is kept. data.extractions[] carry an `extraction` ' +
    'record ready for commit_asbuilt_extraction (which creates the as-built pipe run); data.rejected[] lists fits outside [minRadius, maxRadius].',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    region: regionParam,
    sizeTable: z.enum(['en10220', 'none']).optional().describe('Size table for the DN snap (default en10220).'),
    insulationThickness: z
      .number()
      .optional()
      .describe('Insulation thickness in document units, subtracted from the fitted radius (default 0, named).'),
    toleranceMm: z.number().optional().describe('OD snap tolerance in mm (default 1.5, OUTSIDE_DIAMETER_TOLERANCE_MM).'),
    minRadius: z.number().optional().describe('Smallest accepted pipe radius in document units (default 5 mm).'),
    maxRadius: z.number().optional().describe('Largest accepted pipe radius in document units (default 2 m).'),
    ...fitParams,
  }),
  run: (doc, { cloudId, region, sizeTable = 'en10220', insulationThickness = 0, toleranceMm, ...options }, ctx): CommandResult => {
    const command = 'extract_pipes';
    if (insulationThickness < 0)
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'insulationThickness must be >= 0', [cloudId], ['insulationThickness']);
    if (toleranceMm !== undefined && !(toleranceMm > 0))
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'toleranceMm must be > 0', [cloudId], ['toleranceMm']);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const prepared = prepare(doc, command, cloudId, region, options);
    if (!('params' in prepared)) return prepared;
    const ran = runOp(doc, command, access.port, 'extract_pipes', [access.cloud], prepared.params);
    if (!isSuccess(ran)) return ran;
    const provenance = {
      method: 'ransac+lm cylinder',
      algorithmVersion: `${ran.provenance.binary}/extract-1`,
      seed: options.seed ?? 1,
      device: ran.provenance.device,
      deterministic: ran.provenance.deterministic,
    };
    const warnings: { code: string; message: string }[] = [];
    const extractions = ((ran.result['extractions'] as Record<string, unknown>[] | undefined) ?? []).map((fit) => {
      const odMm = 2 * (numberAt(fit, 'radius') - toM(doc, insulationThickness)) * 1000;
      const snapped: DnSnap | undefined = sizeTable === 'en10220' ? snapDn(odMm, toleranceMm) : undefined;
      if (snapped !== undefined && snapped.dn === null)
        warnings.push({
          code: 'SCN_FIT_NO_STANDARD_SIZE',
          message: `OD ${odMm.toFixed(2)} mm is not within ${snapped.toleranceMm} mm of a table size; the measured OD was kept`,
        });
      const codes = warningCodes(fit);
      const reasons = unverifiedReasons(scanOf(doc), access.cloud, codes);
      const fitWithInsulation = { ...fit, insulationThicknessM: toM(doc, insulationThickness) };
      return {
        ...fitInDocumentUnits(doc, fit),
        measuredOdMm: odMm,
        snapped,
        insulationThickness: {
          value: insulationThickness,
          source: insulationThickness === 0 ? 'named default 0 (TECHNICAL_SPEC §5.6)' : 'parameter',
          defaulted: insulationThickness === 0,
        },
        unverified: reasons.length > 0,
        extraction: pendingExtraction(access.cloud, prepared.region, fitWithInsulation, snapped, reasons, provenance),
      };
    });
    const rejected = (ran.result['rejected'] as unknown[] | undefined) ?? [];
    const first = extractions[0];
    const text =
      first === undefined
        ? `no pipe extracted (${rejected.length} rejected)`
        : `${first.snapped !== undefined && first.snapped.dn !== null ? `DN${first.snapped.dn}` : 'no standard size'}, measured OD ${first.measuredOdMm.toFixed(2)} mm`;
    return report(
      doc,
      `extract_pipes on ${cloudId}: ${text}. Commit with commit_asbuilt_extraction extraction=<data.extractions[0].extraction>.`,
      {
        cloudId,
        unit: doc.units,
        extractions,
        rejected,
        warnings,
        tolerance: {
          value: toleranceMm ?? 1.5,
          source: 'OUTSIDE_DIAMETER_TOLERANCE_MM (pipeSizes.ts)',
          defaulted: toleranceMm === undefined,
        },
      },
    );
  },
});
