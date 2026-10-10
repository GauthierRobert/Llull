/**
 * Earthworks commands: graded platforms (pads) with cut / fill batters, cut / fill volumes,
 * balancing a pad level and comparing two surfaces.
 * @layer domain-aec/civil
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { PlatformObject } from '@core/model/civil';
import type { CommandDefinition, CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { isValidPolygon, segmentsIntersect, signedArea } from '@lib/polygon';
import {
  civilObject,
  civilObjectsOf,
  getCivil,
  nextCivilId,
  toMetresText,
  withObject,
} from './model';
import { commitCivil } from './evaluate';
import { surfaceTinById } from './surfaceTin';
import { elevationAt, type Tin } from './tin';
import {
  buildSamples,
  compareSurfaceVolumes,
  daylightReach,
  padEarthworks,
  volumesFromSamples,
  type Earthworks,
} from './earthworksMath';
import { daylightPoints } from './platformDaylight';
import { toMetres } from '../model';

const DEFAULT_CUT_SLOPE = 1.5;
const DEFAULT_FILL_SLOPE = 2;
const MAX_BOUNDARY_VERTICES = 2000;
const BALANCE_ITERATIONS = 60;

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const slopeOf = (name: string, value: number): string | null =>
  value > 0 && Number.isFinite(value) ? null : `${name} must be > 0 (horizontal per 1 vertical).`;

function isSimple(polygon: ReadonlyArray<Vec2>): boolean {
  const count = polygon.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 2; j < count; j++) {
      if (i === 0 && j === count - 1) continue;
      if (
        segmentsIntersect(
          polygon[i] as Vec2,
          polygon[(i + 1) % count] as Vec2,
          polygon[j] as Vec2,
          polygon[(j + 1) % count] as Vec2,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Why `platform` cannot be graded into `tin`, or null when it can. */
function platformProblem(platform: PlatformObject, tin: Tin): string | null {
  if (platform.boundary.length > MAX_BOUNDARY_VERTICES) {
    return `boundary has more than ${MAX_BOUNDARY_VERTICES} vertices.`;
  }
  if (!isValidPolygon(platform.boundary) || !isSimple(platform.boundary)) {
    return 'boundary must be a simple (non self-intersecting) polygon of >= 3 [x, y] points.';
  }
  const problem =
    slopeOf('cutSlope', platform.cutSlope) ?? slopeOf('fillSlope', platform.fillSlope);
  if (problem) return problem;
  if (platform.boundary.some((vertex) => elevationAt(tin, vertex) === null)) {
    return 'the boundary lies outside the surface (every vertex must be inside the TIN).';
  }
  return null;
}

const counterClockwise = (points: ReadonlyArray<Vec2>): Vec2[] => {
  const copy = points.map((point): Vec2 => [point[0], point[1]]);
  return signedArea(copy) < 0 ? copy.reverse() : copy;
};

/** Volumes in m³ / areas in m² / depths in m. Net = cut - fill (positive = surplus to export). */
function report(doc: CadDocument, works: Earthworks): Record<string, number> {
  const k = toMetres(doc, 1);
  return {
    cutM3: round(works.cutVolume * k ** 3),
    fillM3: round(works.fillVolume * k ** 3),
    netM3: round((works.cutVolume - works.fillVolume) * k ** 3),
    cutAreaM2: round(works.cutArea * k ** 2),
    fillAreaM2: round(works.fillArea * k ** 2),
    padAreaM2: round(works.padArea * k ** 2),
    maxCutDepthM: round(works.maxCutDepth * k),
    maxFillDepthM: round(works.maxFillDepth * k),
    gridSpacingM: round(works.spacing * k),
    samples: works.samples,
    samplesOutsideTin: works.outsideTin,
  };
}

const volumeText = (data: Record<string, number>): string =>
  `cut ${data['cutM3']} m³, fill ${data['fillM3']} m³, net ${data['netM3']} m³ (cut - fill)` +
  ((data['samplesOutsideTin'] ?? 0) > 0
    ? `; ${data['samplesOutsideTin']} grid sample(s) outside the TIN skipped`
    : '');

function worksOf(platform: PlatformObject, tin: Tin, spacing?: number): Earthworks {
  return padEarthworks(
    tin,
    platform.boundary,
    platform.elevation,
    platform.cutSlope,
    platform.fillSlope,
    spacing,
  );
}

/**
 * @command add_platform
 * @pure
 * @affects creates 1 platform (pad + outline + daylight line + batters + label)
 * @invariant boundary is stored counter-clockwise; every vertex lies inside the surface TIN
 * @failure unknown surface / invalid polygon / bad slope / boundary outside surface -> no-op
 */
export const addPlatform = defineCommand({
  name: 'add_platform',
  description:
    'Grade a flat building pad (platform) into an existing-ground surface. Give the pad outline ' +
    '`boundary` (plan polygon, >= 3 simple [x, y] vertices inside the surface) and the finished ' +
    'level `elevation`, both in document units. Cut and fill batters (side slopes, horizontal per ' +
    '1 vertical; defaults 1.5 cut, 2 fill) are projected to the ground, producing the pad, its ' +
    'daylight line and cut / fill volumes. Returns data { platformId, cutM3, fillM3, netM3 }. ' +
    'Edit later with update_platform; find the balancing level with balance_platform.',
  params: z.object({
    surfaceId: z.string().describe('Existing-ground surface id, e.g. "surface-1".'),
    boundary: z
      .array(vec2('Pad outline vertex [x, y].'))
      .min(3)
      .describe('Closed pad outline in plan (>= 3 vertices, simple polygon; any winding).'),
    elevation: z.number().describe('Finished pad level (document units).'),
    cutSlope: z.number().optional().describe('Cut batter, horizontal per 1 vertical. Default 1.5.'),
    fillSlope: z.number().optional().describe('Fill batter, horizontal per 1 vertical. Default 2.'),
    name: z.string().optional().describe('Pad name. Default "Platform <n>".'),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const surface = civilObject(civil, params.surfaceId, 'surface');
    const tin = surface ? surfaceTinById(civil, surface.id) : null;
    if (!surface || !tin) return noop(doc, `add_platform failed: no surface ${params.surfaceId}.`);
    const id = nextCivilId(civil, 'platform');
    const platform: PlatformObject = {
      id,
      category: 'platform',
      name: params.name?.trim() || `Platform ${civilObjectsOf(civil, 'platform').length + 1}`,
      entityIds: [],
      surfaceId: surface.id,
      boundary: counterClockwise(params.boundary),
      elevation: params.elevation,
      cutSlope: params.cutSlope ?? DEFAULT_CUT_SLOPE,
      fillSlope: params.fillSlope ?? DEFAULT_FILL_SLOPE,
    };
    const problem = platformProblem(platform, tin);
    if (problem) return noop(doc, `add_platform failed: ${problem}`);
    const data = report(doc, worksOf(platform, tin));
    return commitCivil(
      doc,
      withObject(civil, platform),
      [id],
      `Created platform ${platform.name} (${id}) at ${toMetresText(doc, platform.elevation)} m on ` +
        `${surface.name}: ${volumeText(data)}.`,
      { platformId: id, ...data },
    );
  },
});

/**
 * @command update_platform
 * @pure
 * @affects regenerates 1 platform
 * @failure unknown platform / invalid value / boundary outside surface / no change -> no-op
 */
export const updatePlatform = defineCommand({
  name: 'update_platform',
  description:
    'Edit a graded platform: change its finished level, outline, batter slopes or name. Geometry ' +
    'and volumes are regenerated; returns data { platformId, cutM3, fillM3, netM3 }. Only the given ' +
    'fields change; the call is a no-op when nothing differs.',
  params: z.object({
    platformId: z.string().describe('Platform id, e.g. "platform-1".'),
    elevation: z.number().optional().describe('New finished level (document units).'),
    boundary: z
      .array(vec2('Pad outline vertex [x, y].'))
      .min(3)
      .optional()
      .describe('New pad outline (>= 3 vertices, simple polygon, inside the surface).'),
    cutSlope: z.number().optional().describe('Cut batter, horizontal per 1 vertical (> 0).'),
    fillSlope: z.number().optional().describe('Fill batter, horizontal per 1 vertical (> 0).'),
    name: z.string().optional().describe('New name.'),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const platform = civilObject(civil, params.platformId, 'platform');
    if (!platform) return noop(doc, `update_platform failed: no platform ${params.platformId}.`);
    const tin = surfaceTinById(civil, platform.surfaceId);
    if (!tin) {
      return noop(doc, `update_platform failed: surface ${platform.surfaceId} no longer exists.`);
    }
    const updated: PlatformObject = {
      ...platform,
      name: params.name?.trim() || platform.name,
      boundary: params.boundary ? counterClockwise(params.boundary) : platform.boundary,
      elevation: params.elevation ?? platform.elevation,
      cutSlope: params.cutSlope ?? platform.cutSlope,
      fillSlope: params.fillSlope ?? platform.fillSlope,
    };
    if (JSON.stringify(updated) === JSON.stringify(platform)) {
      return noop(doc, `update_platform: nothing to change on ${platform.id}.`);
    }
    const problem = platformProblem(updated, tin);
    if (problem) return noop(doc, `update_platform failed: ${problem}`);
    const data = report(doc, worksOf(updated, tin));
    return commitCivil(
      doc,
      withObject(civil, updated),
      [updated.id],
      `Updated platform ${updated.name} (${updated.id}) at ${toMetresText(doc, updated.elevation)} m: ${volumeText(data)}.`,
      { platformId: updated.id, ...data },
    );
  },
});

/**
 * @command platform_earthworks
 * @pure
 * @affects none (read-only)
 * @failure unknown platform / missing surface / bad spacing -> no-op
 */
export const platformEarthworks = defineCommand({
  name: 'platform_earthworks',
  description:
    'Earthworks report of a graded platform by the grid method: cut and fill volumes (m³), net ' +
    '(cut - fill, positive = surplus to export), cut / fill plan areas (m²), pad area, maximum ' +
    'cut / fill depth, grid spacing and the number of samples outside the TIN, plus the daylight ' +
    'line vertices. Read-only; data { platformId, cutM3, fillM3, netM3, cutAreaM2, fillAreaM2, ' +
    'padAreaM2, maxCutDepthM, maxFillDepthM, gridSpacingM, samples, samplesOutsideTin, daylight }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    platformId: z.string().describe('Platform id, e.g. "platform-1".'),
    gridSpacing: z
      .number()
      .optional()
      .describe('Grid cell size (document units). Default: about 2500 cells over the pad.'),
  }),
  run: (doc, { platformId, gridSpacing }): CommandResult => {
    const civil = getCivil(doc);
    const platform = civilObject(civil, platformId, 'platform');
    if (!platform) return noop(doc, `platform_earthworks failed: no platform ${platformId}.`);
    const tin = surfaceTinById(civil, platform.surfaceId);
    if (!tin) {
      return noop(
        doc,
        `platform_earthworks failed: surface ${platform.surfaceId} no longer exists.`,
      );
    }
    if (gridSpacing !== undefined && !(gridSpacing > 0)) {
      return noop(doc, 'platform_earthworks failed: gridSpacing must be > 0.');
    }
    const data = report(doc, worksOf(platform, tin, gridSpacing));
    const daylight = daylightPoints(
      tin,
      platform.boundary,
      platform.elevation,
      platform.cutSlope,
      platform.fillSlope,
    );
    return {
      document: doc,
      summary:
        `${platform.name} (${platform.id}) at ${toMetresText(doc, platform.elevation)} m: ` +
        `${volumeText(data)}; cut area ${data['cutAreaM2']} m², fill area ${data['fillAreaM2']} m², ` +
        `max cut ${data['maxCutDepthM']} m, max fill ${data['maxFillDepthM']} m; ` +
        `grid ${data['gridSpacingM']} m.`,
      affected: [],
      data: {
        platformId,
        ...data,
        daylight: daylight.map((point) => point.daylight),
        daylightClipped: daylight.filter((point) => point.clipped).length,
      },
    };
  },
});

function surfaceRange(tin: Tin, boundary: ReadonlyArray<Vec2>): [number, number] {
  let [low, high] = [Infinity, -Infinity];
  const include = (z: number): void => {
    low = Math.min(low, z);
    high = Math.max(high, z);
  };
  for (const vertex of boundary) include(elevationAt(tin, vertex) ?? low);
  const xs = boundary.map((point) => point[0]);
  const ys = boundary.map((point) => point[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const z = elevationAt(tin, [
        minX + ((maxX - minX) * i) / steps,
        minY + ((maxY - minY) * j) / steps,
      ]);
      if (z !== null) include(z);
    }
  }
  return [low, high];
}

/**
 * @command balance_platform
 * @pure
 * @affects regenerates 1 platform (new elevation)
 * @failure unknown platform / bad swell / no balancing level inside the ground range -> no-op
 */
export const balancePlatform = defineCommand({
  name: 'balance_platform',
  description:
    'Set a platform to the finished level where earthworks balance: cut volume x swellFactor = fill ' +
    'volume (bisection between the lowest and highest existing ground in the pad). Mutates the ' +
    'platform elevation (undoable). Summary and data { platformId, elevationM, cutM3, fillM3, ' +
    'residualM3 } report the new level and the remaining imbalance.',
  params: z.object({
    platformId: z.string().describe('Platform id, e.g. "platform-1".'),
    swellFactor: z
      .number()
      .optional()
      .describe('Bulking factor: fill needed = cut x swellFactor (> 0). Default 1.0.'),
  }),
  run: (doc, { platformId, swellFactor = 1 }): CommandResult => {
    const civil = getCivil(doc);
    const platform = civilObject(civil, platformId, 'platform');
    if (!platform) return noop(doc, `balance_platform failed: no platform ${platformId}.`);
    const tin = surfaceTinById(civil, platform.surfaceId);
    if (!tin) {
      return noop(doc, `balance_platform failed: surface ${platform.surfaceId} no longer exists.`);
    }
    if (!(swellFactor > 0) || !Number.isFinite(swellFactor)) {
      return noop(doc, 'balance_platform failed: swellFactor must be > 0.');
    }
    const [low, high] = surfaceRange(tin, platform.boundary);
    const reach = Math.max(
      daylightReach(tin, low, platform.cutSlope, platform.fillSlope),
      daylightReach(tin, high, platform.cutSlope, platform.fillSlope),
    );
    const samples = buildSamples(tin, platform.boundary, reach);
    const imbalance = (elevation: number): number => {
      const works = volumesFromSamples(
        samples,
        platform.boundary,
        elevation,
        platform.cutSlope,
        platform.fillSlope,
      );
      return works.cutVolume * swellFactor - works.fillVolume;
    };
    if (imbalance(low) < 0 || imbalance(high) > 0) {
      return noop(
        doc,
        `balance_platform: no balancing level between ${toMetresText(doc, low)} m and ${toMetresText(doc, high)} m ` +
          `(ground in the pad); the batters outside the pad dominate. Try another outline or swellFactor.`,
      );
    }
    let [lower, upper] = [low, high];
    for (let i = 0; i < BALANCE_ITERATIONS; i++) {
      const middle = (lower + upper) / 2;
      if (imbalance(middle) > 0) lower = middle;
      else upper = middle;
    }
    const elevation = (lower + upper) / 2;
    if (Math.abs(elevation - platform.elevation) < 1e-9) {
      return noop(
        doc,
        `balance_platform: ${platform.name} is already balanced at ${toMetresText(doc, elevation)} m.`,
      );
    }
    const updated: PlatformObject = { ...platform, elevation };
    const works = volumesFromSamples(
      samples,
      platform.boundary,
      elevation,
      platform.cutSlope,
      platform.fillSlope,
    );
    const data = report(doc, works);
    const residual = round(
      (works.cutVolume * swellFactor - works.fillVolume) * toMetres(doc, 1) ** 3,
    );
    return commitCivil(
      doc,
      withObject(civil, updated),
      [platform.id],
      `Balanced ${platform.name} (${platform.id}): elevation ${toMetresText(doc, platform.elevation)} m -> ` +
        `${round(toMetres(doc, elevation), 3)} m; ${volumeText(data)}; residual ${residual} m³ ` +
        `(cut x ${swellFactor} - fill).`,
      {
        platformId: platform.id,
        elevationM: round(toMetres(doc, elevation), 4),
        cutM3: data['cutM3'],
        fillM3: data['fillM3'],
        residualM3: residual,
      },
    );
  },
});

/**
 * @command compare_surfaces
 * @pure
 * @affects none (read-only)
 * @failure unknown surface / bad spacing / no shared extent -> no-op
 */
export const compareSurfaces = defineCommand({
  name: 'compare_surfaces',
  description:
    'Volume difference between two TIN surfaces by the grid method over their shared extent: cut ' +
    'where the comparison surface lies below the base (e.g. base = existing ground, comparison = ' +
    'design ground), fill where above. Read-only; data { cutM3, fillM3, netM3 (cut - fill), ' +
    'cutAreaM2, fillAreaM2, areaM2, gridSpacingM, samples, samplesOutsideTin }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    baseSurfaceId: z.string().describe('Base surface id (usually existing ground).'),
    comparisonSurfaceId: z.string().describe('Comparison surface id (usually design ground).'),
    gridSpacing: z
      .number()
      .optional()
      .describe('Grid cell size (document units). Default ~40000 cells.'),
  }),
  run: (doc, { baseSurfaceId, comparisonSurfaceId, gridSpacing }): CommandResult => {
    const civil = getCivil(doc);
    const base = surfaceTinById(civil, baseSurfaceId);
    const comparison = surfaceTinById(civil, comparisonSurfaceId);
    if (!base) return noop(doc, `compare_surfaces failed: no surface ${baseSurfaceId}.`);
    if (!comparison)
      return noop(doc, `compare_surfaces failed: no surface ${comparisonSurfaceId}.`);
    if (gridSpacing !== undefined && !(gridSpacing > 0)) {
      return noop(doc, 'compare_surfaces failed: gridSpacing must be > 0.');
    }
    const result = compareSurfaceVolumes(base, comparison, gridSpacing);
    if (result.samples === 0) {
      return noop(doc, 'compare_surfaces failed: the surfaces share no plan extent.');
    }
    const k = toMetres(doc, 1);
    const data = {
      baseSurfaceId,
      comparisonSurfaceId,
      cutM3: round(result.cutVolume * k ** 3),
      fillM3: round(result.fillVolume * k ** 3),
      netM3: round((result.cutVolume - result.fillVolume) * k ** 3),
      cutAreaM2: round(result.cutArea * k ** 2),
      fillAreaM2: round(result.fillArea * k ** 2),
      areaM2: round(result.area * k ** 2),
      gridSpacingM: round(result.spacing * k),
      samples: result.samples,
      samplesOutsideTin: result.outsideTin,
    };
    return {
      document: doc,
      summary:
        `${comparisonSurfaceId} vs ${baseSurfaceId}: cut ${data.cutM3} m³, fill ${data.fillM3} m³, ` +
        `net ${data.netM3} m³ (cut - fill) over ${data.areaM2} m²; grid ${data.gridSpacingM} m` +
        (data.samplesOutsideTin > 0
          ? `; ${data.samplesOutsideTin} sample(s) outside a TIN skipped.`
          : '.'),
      affected: [],
      data,
    };
  },
});

export const earthworksCommands = [
  addPlatform,
  updatePlatform,
  platformEarthworks,
  balancePlatform,
  compareSurfaces,
] as ReadonlyArray<CommandDefinition<unknown>>;
