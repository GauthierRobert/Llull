/**
 * Drainage analysis commands: network hydraulic check, schedules and automatic pipe sizing.
 * @layer domain-aec/civil
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { toMetres } from '../model';
import { civilAffected, civilObjectsOf, getCivil } from './model';
import { regenerateCivil } from './evaluate';
import { analyseNetwork, toCsv } from './drainageNetwork';
import { pipePlanLength, pipeSlope } from './drainageTopology';
import { DEFAULT_CRITERIA, idfError, type DrainageCriteria, type Idf } from './drainageCriteria';
import { sizeNetwork } from './drainageSizing';

export const COMMERCIAL_DIAMETERS_MM = [150, 225, 300, 375, 450, 525, 600, 750, 900, 1050, 1200];

export const intensityField = z
  .number()
  .optional()
  .describe(
    'Constant design rainfall intensity in mm/h (> 0). Default 50. Do not combine with `idf`.',
  );

export const idfField = z
  .object({
    a: z.number().describe('IDF coefficient a (> 0): i = a / (t + b)^c in mm/h.'),
    b: z.number().describe('IDF offset b in minutes (>= 0).'),
    c: z.number().describe('IDF exponent c (> 0).'),
  })
  .optional()
  .describe(
    'Intensity-duration-frequency curve i = a / (t + b)^c (mm/h, t = time of concentration in ' +
      'minutes) replacing the constant intensity: each pipe uses i at its own Tc (modified rational ' +
      'method). Do not combine with `rainfallIntensityMmH`.',
  );

type CriteriaInput = {
  [K in keyof Omit<DrainageCriteria, 'idf' | 'outfallLevel'>]?: number | undefined;
} & { idf?: Idf | undefined; outfallLevel?: number | undefined };

export function criteriaFrom(params: CriteriaInput): DrainageCriteria | string {
  const criteria: DrainageCriteria = {
    rainfallIntensityMmH: params.rainfallIntensityMmH ?? DEFAULT_CRITERIA.rainfallIntensityMmH,
    idf: params.idf ? { a: params.idf.a, b: params.idf.b, c: params.idf.c } : null,
    minVelocity: params.minVelocity ?? DEFAULT_CRITERIA.minVelocity,
    maxVelocity: params.maxVelocity ?? DEFAULT_CRITERIA.maxVelocity,
    minCoverM: params.minCoverM ?? DEFAULT_CRITERIA.minCoverM,
    maxDepthRatio: params.maxDepthRatio ?? DEFAULT_CRITERIA.maxDepthRatio,
    manholeLossK: params.manholeLossK ?? DEFAULT_CRITERIA.manholeLossK,
    freeboardM: params.freeboardM ?? DEFAULT_CRITERIA.freeboardM,
    outfallLevel: params.outfallLevel ?? null,
  };
  if (criteria.idf && params.rainfallIntensityMmH !== undefined) {
    return 'give either rainfallIntensityMmH or idf, not both.';
  }
  if (criteria.idf) {
    const problem = idfError(criteria.idf);
    if (problem !== null) return problem;
  }
  if (!(criteria.rainfallIntensityMmH > 0)) return 'rainfallIntensityMmH must be > 0.';
  if (!(criteria.maxDepthRatio > 0 && criteria.maxDepthRatio <= 1)) {
    return 'maxDepthRatio must be in (0, 1].';
  }
  if (criteria.minVelocity < 0 || criteria.maxVelocity < criteria.minVelocity) {
    return 'velocity limits must satisfy 0 <= minVelocity <= maxVelocity.';
  }
  if (criteria.manholeLossK < 0) return 'manholeLossK must be >= 0.';
  if (criteria.freeboardM < 0) return 'freeboardM must be >= 0.';
  return criteria;
}

function rainfallText(criteria: DrainageCriteria): string {
  const idf = criteria.idf;
  return idf
    ? `IDF i=${idf.a}/(t+${idf.b})^${idf.c} mm/h`
    : `${criteria.rainfallIntensityMmH} mm/h`;
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
    'passes or fails against the limits. Modified rational method: Tc at each pipe = max over upstream ' +
    'paths of (manhole `entryTimeMin`, default 5 min, + pipe travel times L/v, v = part-full velocity), ' +
    'intensity from `idf` (i = a/(t+b)^c) or the constant intensity, flow = i * sum(C A) + inflows. A ' +
    'manhole with several outgoing pipes splits its flow by full-bore capacity share. The hydraulic grade ' +
    'line runs upstream from the outfall (most downstream manhole; tailwater `outfallLevel`, default the ' +
    'outlet pipe normal depth): friction slope (Q n / (A R^(2/3)))^2 or normal depth, whichever is higher, ' +
    'plus K v^2/2g at manholes where the pipe is pressurised; pipes get hglUpM / hglDownM / surcharged ' +
    '(HGL above obvert) / flooding (HGL above rim - freeboard); manholes get hglM / flooding. Each pipe ' +
    'row reports tcMin, intensityMmH, sumCAHa, designLps. Returns data { pipes, manholes, failures, ' +
    'diverging, csv }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    rainfallIntensityMmH: intensityField,
    idf: idfField,
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
    outfallLevel: z
      .number()
      .optional()
      .describe(
        'Tailwater elevation at the outfall(s) in document units, same datum as invert levels. ' +
          'Default: normal-depth water level of the outlet pipe.',
      ),
    manholeLossK: z
      .number()
      .optional()
      .describe('Manhole head-loss coefficient K in K v^2/2g (>= 0). Default 0.5.'),
    freeboardM: z
      .number()
      .optional()
      .describe(
        'Required freeboard below the rim in metres (>= 0) before flooding is flagged. Default 0.3.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const criteria = criteriaFrom(params);
    if (typeof criteria === 'string')
      return noop(doc, `check_drainage_network failed: ${criteria}`);
    const civil = getCivil(doc);
    if (civilObjectsOf(civil, 'pipe').length === 0) {
      return noop(doc, 'check_drainage_network: the document has no drainage pipes.');
    }
    const { pipes, manholes, diverging } = analyseNetwork(doc, civil, criteria);
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
        'tc_min',
        'intensity_mmh',
        'sum_CA_ha',
        'hgl_up_m',
        'hgl_down_m',
        'surcharged',
        'flooding',
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
        r.tcMin,
        r.intensityMmH,
        r.sumCAHa,
        r.hglUpM,
        r.hglDownM,
        r.surcharged,
        r.flooding,
        r.status,
      ]),
    );
    const worst = failures.slice(0, 5).join(' | ');
    const tcs = pipes.map((r) => r.tcMin);
    const flooded = manholes.filter((r) => r.flooding).length;
    const surcharged = pipes.filter((r) => r.surcharged).length;
    const split =
      diverging.length > 0
        ? ` Diverging at ${diverging.join(', ')}: flow split by full-bore capacity share.`
        : '';
    return {
      document: doc,
      summary:
        `Drainage check at ${rainfallText(criteria)}: ${pipes.length} pipes ` +
        `(${pipes.filter((r) => r.status === 'pass').length} pass), ${manholes.length} manholes; ` +
        `Tc ${Math.min(...tcs)}-${Math.max(...tcs)} min; HGL: ${surcharged} surcharged pipe(s), ` +
        `${flooded} flooding manhole(s). ` +
        (failures.length === 0 ? 'No failures.' : `${failures.length} failure(s): ${worst}`) +
        split,
      affected: [],
      data: { pipes, manholes, failures, diverging, csv },
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
    'given). Flows follow the modified rational method of check_drainage_network (entry times, travel ' +
    'times, optional `idf` curve, diverging manholes split by capacity share); sizing and velocities ' +
    'are iterated to convergence (max 10 passes). Pipes that fail even at the largest size, or have no ' +
    'downhill slope, are reported and left unchanged.',
  params: z.object({
    rainfallIntensityMmH: intensityField,
    idf: idfField,
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
      idf: params.idf,
      maxDepthRatio: params.maxDepthRatio,
      minVelocity: params.minVelocity ?? 0,
    });
    if (typeof criteria === 'string') return noop(doc, `size_drainage_pipes failed: ${criteria}`);
    const candidates = [...(params.diameters ?? COMMERCIAL_DIAMETERS_MM)].sort((a, b) => a - b);
    if (candidates.length === 0 || candidates.some((d) => !(d > 0))) {
      return noop(doc, 'size_drainage_pipes failed: diameters must be positive millimetres.');
    }
    const civil = getCivil(doc);
    if (civilObjectsOf(civil, 'pipe').length === 0) {
      return noop(doc, 'size_drainage_pipes: the document has no pipes.');
    }
    const sized = sizeNetwork(doc, civil, criteria, candidates);
    const note =
      sized.unsized.length > 0
        ? ` Cannot size ${sized.unsized.join(', ')} (adverse slope or flow exceeds the largest size); left unchanged.`
        : '';
    const passes = `${sized.iterations} pass(es)${sized.converged ? '' : ', NOT converged'}`;
    if (sized.changed.length === 0) {
      return noop(doc, `size_drainage_pipes: no diameter change needed.${note}`);
    }
    const document = regenerateCivil(doc, sized.civil);
    return {
      document,
      summary:
        `Resized ${sized.changed.length} pipe(s) at ${rainfallText(criteria)} (${passes}): ` +
        `${sized.changed.join(', ')}.${note}`,
      affected: civilAffected(
        document,
        sized.changed.map((entry) => entry.split(' ')[0] ?? ''),
      ),
      data: {
        resized: sized.changed,
        unsized: sized.unsized,
        iterations: sized.iterations,
        converged: sized.converged,
      },
    };
  },
});

export const drainageAnalysisCommands = [checkDrainageNetwork, drainageSchedule, sizeDrainagePipes];
