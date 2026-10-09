/**
 * Drainage analysis commands: network hydraulic check, schedules and automatic pipe sizing.
 * @layer domain-aec/civil
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { fromMm, toMetres } from '../model';
import { civilAffected, civilObject, civilObjectsOf, getCivil, withObject } from './model';
import { regenerateCivil } from './evaluate';
import {
  analyseNetwork,
  DEFAULT_CRITERIA,
  pipeDesignFlows,
  pipePlanLength,
  pipeSlope,
  toCsv,
  type DrainageCriteria,
} from './drainageNetwork';
import { solvePartialFlow } from './hydraulics';

export const COMMERCIAL_DIAMETERS_MM = [150, 225, 300, 375, 450, 525, 600, 750, 900, 1050, 1200];

const intensityField = z
  .number()
  .optional()
  .describe('Design rainfall intensity in mm/h (> 0). Default 50.');

type CriteriaInput = { [K in keyof DrainageCriteria]?: number | undefined };

function criteriaFrom(params: CriteriaInput): DrainageCriteria | string {
  const criteria: DrainageCriteria = {
    rainfallIntensityMmH: params.rainfallIntensityMmH ?? DEFAULT_CRITERIA.rainfallIntensityMmH,
    minVelocity: params.minVelocity ?? DEFAULT_CRITERIA.minVelocity,
    maxVelocity: params.maxVelocity ?? DEFAULT_CRITERIA.maxVelocity,
    minCoverM: params.minCoverM ?? DEFAULT_CRITERIA.minCoverM,
    maxDepthRatio: params.maxDepthRatio ?? DEFAULT_CRITERIA.maxDepthRatio,
  };
  if (!(criteria.rainfallIntensityMmH > 0)) return 'rainfallIntensityMmH must be > 0.';
  if (!(criteria.maxDepthRatio > 0 && criteria.maxDepthRatio <= 1)) {
    return 'maxDepthRatio must be in (0, 1].';
  }
  if (criteria.minVelocity < 0 || criteria.maxVelocity < criteria.minVelocity) {
    return 'velocity limits must satisfy 0 <= minVelocity <= maxVelocity.';
  }
  return criteria;
}

/**
 * @command check_drainage_network
 * @pure
 * @affects none (read-only)
 * @failure bad criteria -> no-op
 */
export const checkDrainageNetwork = defineCommand({
  name: 'check_drainage_network',
  description:
    'Hydraulic check of the whole gravity network. Rational-method flows (catchments) and point ' +
    'inflows are accumulated downstream through the pipes; each pipe reports length, slope, design ' +
    'and full-bore (Manning) flow, utilisation, depth ratio, velocity and cover at both ends, and ' +
    'passes or fails against the limits. Manholes report depth and drop. Returns data { pipes, ' +
    'manholes, failures, csv }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    rainfallIntensityMmH: intensityField,
    minVelocity: z
      .number()
      .optional()
      .describe('Minimum self-cleansing velocity, m/s. Default 0.6.'),
    maxVelocity: z.number().optional().describe('Maximum velocity, m/s. Default 3.0.'),
    minCoverM: z
      .number()
      .optional()
      .describe('Minimum cover over the pipe crown, metres. Default 0.9.'),
    maxDepthRatio: z
      .number()
      .optional()
      .describe('Maximum design flow depth / diameter, 0 to 1. Default 0.8.'),
  }),
  run: (doc, params): CommandResult => {
    const criteria = criteriaFrom(params);
    if (typeof criteria === 'string')
      return noop(doc, `check_drainage_network failed: ${criteria}`);
    const civil = getCivil(doc);
    if (civilObjectsOf(civil, 'pipe').length === 0) {
      return noop(doc, 'check_drainage_network: the document has no drainage pipes.');
    }
    const { pipes, manholes } = analyseNetwork(doc, civil, criteria);
    const failures = [
      ...pipes
        .filter((row) => row.status === 'fail')
        .map((r) => `${r.id} ${r.name}: ${r.reasons.join('; ')}`),
      ...manholes
        .filter((row) => row.status === 'fail')
        .map((r) => `${r.id} ${r.name}: ${r.reasons.join('; ')}`),
    ];
    const csv = toCsv(
      [
        'pipe',
        'name',
        'from',
        'to',
        'length_m',
        'slope_pct',
        'diameter_mm',
        'design_Lps',
        'full_Lps',
        'utilisation',
        'depth_ratio',
        'velocity_ms',
        'cover_from_m',
        'cover_to_m',
        'status',
      ],
      pipes.map((r) => [
        r.id,
        r.name,
        r.fromId,
        r.toId,
        r.lengthM,
        r.slopePct,
        r.diameterMm,
        r.designLps,
        r.fullLps,
        r.utilisation,
        r.depthRatio,
        r.velocity,
        r.coverFromM,
        r.coverToM,
        r.status,
      ]),
    );
    const worst = failures.slice(0, 5).join(' | ');
    return {
      document: doc,
      summary:
        `Drainage check at ${criteria.rainfallIntensityMmH} mm/h: ${pipes.length} pipes ` +
        `(${pipes.filter((r) => r.status === 'pass').length} pass), ${manholes.length} manholes; ` +
        (failures.length === 0 ? 'no failures.' : `${failures.length} failure(s): ${worst}`),
      affected: [],
      data: { pipes, manholes, failures, csv },
    };
  },
});

/**
 * @command drainage_schedule
 * @pure
 * @affects none (read-only)
 * @failure no manholes -> no-op
 */
export const drainageSchedule = defineCommand({
  name: 'drainage_schedule',
  description:
    'Manhole and pipe schedules as CSV: ids, names, coordinates, rim and invert levels, depth, ' +
    'diameter, length, slope and material (metres). Returns data { manholeCsv, pipeCsv, csv }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({}),
  run: (doc): CommandResult => {
    const civil = getCivil(doc);
    const manholes = civilObjectsOf(civil, 'manhole');
    if (manholes.length === 0) return noop(doc, 'drainage_schedule: the document has no manholes.');
    const metres = (value: number): number => Number(toMetres(doc, value).toFixed(3));
    const manholeCsv = toCsv(
      ['id', 'name', 'x_m', 'y_m', 'rim_m', 'invert_m', 'depth_m', 'diameter_mm'],
      manholes.map((m) => [
        m.id,
        m.name,
        metres(m.position[0]),
        metres(m.position[1]),
        metres(m.rimElevation),
        metres(m.invertElevation),
        metres(m.rimElevation - m.invertElevation),
        Number((metres(m.diameter) * 1000).toFixed(1)),
      ]),
    );
    const pipes = civilObjectsOf(civil, 'pipe');
    const pipeCsv = toCsv(
      [
        'id',
        'name',
        'from',
        'to',
        'diameter_mm',
        'material',
        'length_m',
        'slope_pct',
        'invert_from_m',
        'invert_to_m',
      ],
      pipes.map((p) => [
        p.id,
        p.name,
        p.fromId,
        p.toId,
        Number((metres(p.diameter) * 1000).toFixed(1)),
        p.material,
        metres(pipePlanLength(civil, p) ?? 0),
        Number((pipeSlope(civil, p) * 100).toFixed(3)),
        metres(p.invertFrom),
        metres(p.invertTo),
      ]),
    );
    return {
      document: doc,
      summary: `Drainage schedule: ${manholes.length} manholes, ${pipes.length} pipes.`,
      affected: [],
      data: { manholeCsv, pipeCsv, csv: `${manholeCsv}\n\n${pipeCsv}` },
    };
  },
});

/**
 * @command size_drainage_pipes
 * @pure
 * @affects modifies the diameter of every pipe that needs a different commercial size
 * @failure no pipes / bad criteria -> no-op
 */
export const sizeDrainagePipes = defineCommand({
  name: 'size_drainage_pipes',
  description:
    'Automatic pipe sizing: sets each pipe diameter to the smallest commercial size that carries ' +
    'its accumulated design flow at its current slope within `maxDepthRatio` (and `minVelocity` when ' +
    'given). Pipes that fail even at the largest size, or have no downhill slope, are reported and left unchanged.',
  params: z.object({
    rainfallIntensityMmH: intensityField,
    diameters: z
      .array(z.number())
      .optional()
      .describe(
        'Candidate diameters in millimetres. Default 150,225,300,375,450,525,600,750,900,1050,1200.',
      ),
    maxDepthRatio: z
      .number()
      .optional()
      .describe('Maximum flow depth / diameter, 0 to 1. Default 0.8.'),
    minVelocity: z.number().optional().describe('Minimum velocity in m/s. Default: not enforced.'),
  }),
  run: (doc, params): CommandResult => {
    const criteria = criteriaFrom({
      rainfallIntensityMmH: params.rainfallIntensityMmH,
      maxDepthRatio: params.maxDepthRatio,
      minVelocity: params.minVelocity ?? 0,
    });
    if (typeof criteria === 'string') return noop(doc, `size_drainage_pipes failed: ${criteria}`);
    const candidates = [...(params.diameters ?? COMMERCIAL_DIAMETERS_MM)].sort((a, b) => a - b);
    if (candidates.length === 0 || candidates.some((d) => !(d > 0))) {
      return noop(doc, 'size_drainage_pipes failed: diameters must be positive millimetres.');
    }
    let civil = getCivil(doc);
    const pipes = civilObjectsOf(civil, 'pipe');
    if (pipes.length === 0) return noop(doc, 'size_drainage_pipes: the document has no pipes.');
    const flows = pipeDesignFlows(civil, criteria.rainfallIntensityMmH);
    const changed: string[] = [];
    const unsized: string[] = [];
    for (const pipe of pipes) {
      const slope = pipeSlope(civil, pipe);
      const flow = (flows.get(pipe.id) ?? 0) / 1000;
      const pick = candidates.find((mm) => {
        const result = solvePartialFlow(mm / 1000, slope, pipe.manningN, flow);
        return (
          slope > 0 &&
          !result.surcharged &&
          result.depthRatio <= criteria.maxDepthRatio &&
          (flow === 0 || result.velocity >= criteria.minVelocity)
        );
      });
      if (pick === undefined) {
        unsized.push(pipe.id);
        continue;
      }
      const diameter = fromMm(doc, pick);
      if (Math.abs(diameter - pipe.diameter) < 1e-9) continue;
      const current = civilObject(civil, pipe.id, 'pipe') ?? pipe;
      civil = withObject(civil, { ...current, diameter });
      changed.push(`${pipe.id} -> Ø${pick}`);
    }
    const note =
      unsized.length > 0
        ? ` Cannot size ${unsized.join(', ')} (adverse slope or flow exceeds the largest size); left unchanged.`
        : '';
    if (changed.length === 0) {
      return noop(doc, `size_drainage_pipes: no diameter change needed.${note}`);
    }
    const document = regenerateCivil(doc, civil);
    return {
      document,
      summary: `Resized ${changed.length} pipe(s) at ${criteria.rainfallIntensityMmH} mm/h: ${changed.join(', ')}.${note}`,
      affected: civilAffected(
        document,
        changed.map((entry) => entry.split(' ')[0] ?? ''),
      ),
      data: { resized: changed, unsized },
    };
  },
});

export const drainageAnalysisCommands = [checkDrainageNetwork, drainageSchedule, sizeDrainagePipes];
