/** design_nozzle: revolve a rocket thrust-chamber nozzle wall (conical or Rao parabolic bell) as a CAD solid. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { briefNumbers, sig } from '../shared/results';
import { execute } from '@core/commands/registry';
import { refuseFluid } from './codes';
import { nozzleContour, wallSection, type ContourSpec } from './nozzleContour';

const RAD = Math.PI / 180;

/** 80 % bell initial angle θn (deg) vs ε, Huzel & Huang (NASA SP-125) Fig. 4-16 as digitised in rocketisp 0.1.13 `huzel_data.py`. */
const RAO_80_ENTRANCE: ReadonlyArray<readonly [number, number]> = [
  [5.06, 22.57],
  [9.93, 25.21],
  [15.09, 27.41],
  [20.14, 29.03],
  [24.97, 30.05],
  [30.02, 30.79],
  [40.05, 31.57],
  [50.18, 32.18],
];

/** 80 % bell exit angle θe (deg) vs ε, same chart and digitisation. */
const RAO_80_EXIT: ReadonlyArray<readonly [number, number]> = [
  [5.16, 13.48],
  [10.22, 10.91],
  [15.19, 9.71],
  [20.07, 9.09],
  [25.0, 8.78],
  [29.97, 8.56],
  [40.0, 8.08],
  [50.2, 7.72],
];

/** Piecewise-linear lookup, held constant beyond the end points. */
function interpolate(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = table[0] as readonly [number, number];
  const last = table[table.length - 1] as readonly [number, number];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  const upper = table.findIndex(([at]) => at >= x);
  const [x1, y1] = table[upper - 1] as readonly [number, number];
  const [x2, y2] = table[upper] as readonly [number, number];
  return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
}

/** 80 % bell angles for ε in 5..50 (chart range), else null. */
export function raoAngles(expansionRatio: number): { entranceDeg: number; exitDeg: number } | null {
  if (expansionRatio < 5 || expansionRatio > 50.2) return null;
  return { entranceDeg: interpolate(RAO_80_ENTRANCE, expansionRatio), exitDeg: interpolate(RAO_80_EXIT, expansionRatio) };
}

/**
 * @affects creates 1 revolution solid (the nozzle wall, axis +Z through `position`, throat at z = position, flow towards +z)
 * @invariant inner exit radius = R_t √ε, chamber radius = R_t √ε_c; throat arcs 1.5 R_t upstream / 0.382 R_t downstream (Rao); composes revolve_profile
 * @failure non-positive sizes, bad angles, wall thicker than the downstream arc radius -> FLD_PARAM_INVALID; contour that cannot close -> FLD_CONTOUR_INVALID
 */
export const designNozzle = defineCommand({
  name: 'design_nozzle',
  description:
    'Create a rocket thrust-chamber nozzle as a CAD solid: the wall cross-section is revolved about +Z (throat at `position`, exhaust ' +
    'towards +Z). Contour (Huzel & Huang NASA SP-125 §4; Rao 1958): cylindrical chamber (`chamberLength`, radius R_t √contractionRatio), ' +
    'conical convergent (`convergentHalfAngleDeg`, default 30) into an upstream throat arc 1.5 R_t, a downstream throat arc 0.382 R_t, then ' +
    '`shape` conical (`halfAngleDeg`, default 15) or bell (Rao thrust-optimised parabola: `lengthFraction` of the 15° cone, default 0.8; ' +
    'angles θn / θe from the Huzel & Huang 80 % chart for ε 5-50 unless `entranceAngleDeg` / `exitAngleDeg` are given). Lengths in ' +
    'document units: `throatRadius`, `wallThickness`. Returns the lengths, radii and (with `includeContour`) the inner contour. Pair with ' +
    'nozzle_performance (same ε) for thrust and Isp; mass_properties for the wall mass.',
  params: z.object({
    throatRadius: z.number().describe('Throat radius R_t in document units, > 0.'),
    expansionRatio: z.number().describe('Exit / throat area ratio ε, 1.5..400.'),
    contractionRatio: z.number().optional().describe('Chamber / throat area ratio ε_c, 1.5..20. Default 3 (flagged).'),
    chamberLength: z.number().optional().describe('Cylindrical chamber length before the convergent, document units, >= 0. Default 0.'),
    convergentHalfAngleDeg: z.number().optional().describe('Convergent cone half-angle in degrees, 15..60. Default 30.'),
    shape: z.enum(['conical', 'bell']).optional().describe('Divergent section: bell (default) or conical.'),
    halfAngleDeg: z.number().optional().describe('conical: divergent half-angle in degrees, 5..30. Default 15.'),
    lengthFraction: z.number().optional().describe('bell: length as a fraction of the 15° cone, 0.6..1. Default 0.8.'),
    entranceAngleDeg: z.number().optional().describe('bell: initial wall angle θn in degrees (default from the 80 % chart).'),
    exitAngleDeg: z.number().optional().describe('bell: exit wall angle θe in degrees (default from the 80 % chart).'),
    wallThickness: z.number().describe('Wall thickness in document units, > 0 and < 0.382 R_t.'),
    position: z.array(z.number()).length(3).optional().describe('Throat centre [x, y, z] in document units. Default origin.'),
    segments: z.number().int().optional().describe('Circumferential segments of the revolution, 16..256. Default 96.'),
    includeContour: z.boolean().optional().describe('Return the inner wall contour points (axial, radius, angle) in data. Default false.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseFluid(doc, 'design_nozzle', code, message, [], [path]);
    const { throatRadius: rt, expansionRatio: eps, wallThickness: t } = params;
    const contraction = params.contractionRatio ?? 3;
    const convergent = params.convergentHalfAngleDeg ?? 30;
    const shape = params.shape ?? 'bell';
    const segments = params.segments ?? 96;
    if (!(rt > 0) || !(eps >= 1.5 && eps <= 400) || !(contraction >= 1.5 && contraction <= 20))
      return fail('FLD_PARAM_INVALID', 'throatRadius > 0, expansionRatio 1.5..400, contractionRatio 1.5..20', 'throatRadius');
    if (!(convergent >= 15 && convergent <= 60) || !((params.chamberLength ?? 0) >= 0) || !(segments >= 16 && segments <= 256))
      return fail('FLD_PARAM_INVALID', 'convergentHalfAngleDeg 15..60, chamberLength >= 0, segments 16..256', 'convergentHalfAngleDeg');
    if (!(t > 0 && t < 0.382 * rt))
      return fail(
        'FLD_PARAM_INVALID',
        `wallThickness must be within (0, ${sig(0.382 * rt)}) (the downstream throat arc radius)`,
        'wallThickness',
      );
    const defaulted: string[] = [];
    let divergent: ContourSpec['divergent'];
    if (shape === 'conical') {
      const half = params.halfAngleDeg ?? 15;
      if (params.halfAngleDeg === undefined) defaulted.push('halfAngleDeg 15');
      if (!(half >= 5 && half <= 30)) return fail('FLD_PARAM_INVALID', 'halfAngleDeg must be within 5..30', 'halfAngleDeg');
      divergent = { shape: 'conical', halfAngle: half * RAD };
    } else {
      const fraction = params.lengthFraction ?? 0.8;
      if (!(fraction >= 0.6 && fraction <= 1)) return fail('FLD_PARAM_INVALID', 'lengthFraction must be within 0.6..1', 'lengthFraction');
      const chart = raoAngles(eps);
      if ((params.entranceAngleDeg === undefined || params.exitAngleDeg === undefined) && (chart === null || fraction !== 0.8))
        return fail(
          'FLD_PARAM_INVALID',
          'give entranceAngleDeg and exitAngleDeg: the built-in chart covers only the 80 % bell for ε 5..50',
          'entranceAngleDeg',
        );
      const entrance = params.entranceAngleDeg ?? (chart as NonNullable<typeof chart>).entranceDeg;
      const exit = params.exitAngleDeg ?? (chart as NonNullable<typeof chart>).exitDeg;
      if (params.entranceAngleDeg === undefined) defaulted.push(`θn ${sig(entrance)}° (Huzel & Huang 80 % chart)`);
      if (params.exitAngleDeg === undefined) defaulted.push(`θe ${sig(exit)}° (Huzel & Huang 80 % chart)`);
      if (!(entrance > exit && exit >= 0 && entrance < 60))
        return fail('FLD_PARAM_INVALID', 'need 0 <= exitAngleDeg < entranceAngleDeg < 60', 'entranceAngleDeg');
      divergent = { shape: 'bell', lengthFraction: fraction, entranceAngle: entrance * RAD, exitAngle: exit * RAD };
    }
    if (params.contractionRatio === undefined) defaulted.push('contractionRatio 3');
    const contour = nozzleContour({
      throatRadius: rt,
      expansionRatio: eps,
      contractionRatio: contraction,
      convergentHalfAngle: convergent * RAD,
      chamberLength: params.chamberLength ?? 0,
      upstreamRadiusFactor: 1.5,
      downstreamRadiusFactor: 0.382,
      divergent,
    });
    if (typeof contour === 'string') return fail('FLD_CONTOUR_INVALID', contour, 'expansionRatio');
    const profile = wallSection(contour.points, t);
    const revolved = execute(
      doc,
      'revolve_profile',
      { profile, axis: 'z', segments, ...(params.position ? { position: params.position } : {}) },
      ctx,
    );
    if (revolved.affected.length === 0) return fail('FLD_CONTOUR_INVALID', revolved.summary, 'expansionRatio');
    const id = revolved.affected[0] as string;
    const data = {
      id,
      shape,
      throatRadius: rt,
      exitRadius: sig(contour.exitRadius),
      chamberRadius: sig(contour.chamberRadius),
      expansionRatioCheck: sig((contour.exitRadius / rt) ** 2),
      convergentLength: sig(contour.convergentLength),
      divergentLength: sig(contour.divergentLength),
      referenceConeLength15: sig(contour.referenceConeLength),
      totalLength: sig(contour.convergentLength + (params.chamberLength ?? 0) + contour.divergentLength),
      contourPoints: contour.points.length,
      exitAngleDeg: sig((contour.points[contour.points.length - 1]?.angle ?? 0) / RAD),
      ...(params.includeContour
        ? {
            contour: contour.points.map((point) => ({
              axial: sig(point.axial),
              radius: sig(point.radius),
              angleDeg: sig(point.angle / RAD),
            })),
          }
        : {}),
      defaulted,
      provenance: {
        method: shape === 'bell' ? 'Rao thrust-optimised parabola (quadratic Bézier between θn and θe tangents)' : 'conical divergent',
        throatArcs: 'upstream 1.5 R_t, downstream 0.382 R_t (Rao 1958; Huzel & Huang NASA SP-125 Fig. 4-15)',
        lengthReference: 'L_15 = (R_t(√ε - 1) + R_d(sec 15° - 1)) / tan 15°',
      },
    };
    const summary = revolved.summary;
    return {
      ...changed(
        revolved.document,
        briefNumbers(
          `design_nozzle ${shape} ${id}: R_t ${rt}, ε ${eps} (R_e ${data.exitRadius}), ε_c ${contraction}, divergent length ${data.divergentLength}` +
            ` (${sig(contour.divergentLength / contour.referenceConeLength)} of the 15° cone), wall ${t}${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')}` : ''}. ${summary}`,
        ),
        revolved.affected,
      ),
      data,
    };
  },
});
