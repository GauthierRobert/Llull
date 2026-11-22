import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import { levelIdParam } from '../../../building/levelParams';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { refuse } from '../codes';
import { stringerAndTread, type Fail } from '../stair/steelStairPhases';
import { spiralGeometry } from './radialLayout';
import { commitRadial, riseFor } from './radialCommit';

/**
 * @affects creates 1 radialStair element (form spiral): a centre column and sector treads as entities on layer S-STAR
 * @invariant n = ceil(rise / riserMax) equal risers; treads = n - 1, each a sector of treadAngle from the column surface to outerRadius, tread i tops at i x h; the column runs foot to top of the rise; no rule is checked (none cited)
 * @failure bad rise / riserMax / radii / treadAngle, a column profile that is not a CHS, unknown grating -> STA_INVALID_GEOMETRY / STA_GRATING_TYPE_UNKNOWN
 */
export const addSpiralStair = defineCommand({
  name: 'add_spiral_stair',
  description:
    'Add a steel spiral stair: a vertical centre column and one sector tread per riser round it, each `treadAngle` wide, climbing toward `turn`. Lengths in DOCUMENT UNITS, angles in RADIANS. ' +
    '`start` = [x, y, z] centre of the column at its foot (z relative to the level); the first tread begins at `angle` (0 = +X). n = ceil(rise / riserMax) equal risers, treads = n - 1, tread i tops at i x h; the column spans the whole rise. The treads run from the column surface (CHS outside radius) to `outerRadius`; they are separate sectors (no overlap between treads is modelled). ' +
    'Treads as add_steel_stair (grating or checker_plate). The column profile is a required input (a CHS from list_steel_profiles): no default section is assumed. ' +
    'No spiral going, rise, headroom or walkline rule is cited in the repo sources, so none is checked: the result reports the tread geometry (outer and inner arc, total turn, rise per revolution) without a verdict. ' +
    'Result data: stairId, riserCount, treadCount, columnRadiusMm, walkingWidthMm, treadAngleDeg, totalTurnDeg, risePerTurnMm, outerArcMm, steelKg, rules { evaluated: false }.',
  params: z.object({
    start: vec3('Centre of the column at its foot [x, y, z], DOCUMENT UNITS; z relative to the level elevation.'),
    angle: z.number().optional().describe('Plan angle in RADIANS from +X where the first tread begins. Default 0.'),
    rise: z.number().positive().describe('Total rise from the foot to the top walking surface, DOCUMENT UNITS.'),
    riserMax: z.number().positive().describe('Largest riser height, DOCUMENT UNITS; the riser count is the smallest that respects it.'),
    outerRadius: z
      .number()
      .positive()
      .describe('Radius of the outer edge of the treads from the column axis, DOCUMENT UNITS (greater than the column radius).'),
    treadAngle: z.number().positive().max(Math.PI).describe('Angle each tread sweeps, RADIANS (> 0, at most pi).'),
    turn: z.enum(['left', 'right']).describe('"left" climbs counter-clockwise seen from above, "right" clockwise.'),
    columnProfile: z
      .string()
      .describe(
        'Catalogue name of a CHS for the centre column (list_steel_profiles, e.g. a CHS family entry); its outside diameter sets the inner radius of the treads.',
      ),
    tread: z
      .object({
        kind: z.enum(['grating', 'checker_plate']).describe('"grating" needs gratingType, "checker_plate" needs thickness.'),
        gratingType: z.string().optional().describe('Catalogue key from list_grating_types (kind "grating").'),
        thickness: z.number().positive().optional().describe('Plate thickness, DOCUMENT UNITS (kind "checker_plate").'),
      })
      .optional()
      .describe(
        'Tread surface: { kind: "grating", gratingType } or { kind: "checker_plate", thickness }. Default grating 19-W-4 1-1/4x3/16.',
      ),
    levelId: levelIdParam.describe('Level of the foot. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = [], ids = []) => refuse(doc, 'add_spiral_stair', code, message, ids, paths);
    const invalid = (message: string, paths: string[] = []): CommandResult => fail('STA_INVALID_GEOMETRY', message, paths);
    const profile = findProfile(params.columnProfile);
    if (profile === undefined) return invalid(`unknown column profile '${params.columnProfile}' (list_steel_profiles)`, ['columnProfile']);
    if (profile.family !== 'CHS')
      return invalid(`column profile ${profile.name} is a ${profile.family}: a spiral stair needs a CHS column`, ['columnProfile']);
    const defaulted: string[] = [];
    const parts = stringerAndTread({ tread: params.tread }, fail, defaulted);
    if (!parts.ok) return parts.result;
    const innerRadius = fromMm(doc, profile.h / 2);
    if (!(params.outerRadius > innerRadius))
      return invalid(`outerRadius ${params.outerRadius} must exceed the column radius ${round(innerRadius, 4)} (${profile.name})`, [
        'outerRadius',
      ]);
    const rise = riseFor(doc, params.rise, params.riserMax, 2, invalid);
    if (!rise.ok) return rise.result;
    const { riserCount, riserHeight } = rise;
    const angle = params.angle === undefined ? 0 : params.angle;
    const sign = params.turn === 'left' ? 1 : -1;
    const geometry = spiralGeometry({
      start: params.start,
      angle,
      sign,
      innerRadius,
      outerRadius: params.outerRadius,
      treadAngle: params.treadAngle,
      riserCount,
      riserHeight,
    });
    const treadDeg = (params.treadAngle * 180) / Math.PI;
    const totalDeg = treadDeg * (riserCount - 1);
    return commitRadial(doc, {
      form: 'spiral',
      name: 'add_spiral_stair',
      start: params.start,
      angle,
      rise: params.rise,
      riserCount,
      riserHeight,
      width: params.outerRadius - innerRadius,
      turn: params.turn,
      profile: profile.name,
      tread: parts.value.tread,
      levelId: params.levelId,
      geometry,
      sector: { innerRadius, outerRadius: params.outerRadius, treadAngle: params.treadAngle },
      defaulted,
      extra: {
        columnRadiusMm: round(profile.h / 2, 3),
        walkingWidthMm: round(toMm(doc, params.outerRadius - innerRadius), 3),
        treadAngleDeg: round(treadDeg, 4),
        totalTurnDeg: round(totalDeg, 4),
        risePerTurnMm: round(toMm(doc, riserHeight) * (360 / treadDeg), 3),
        outerArcMm: round(toMm(doc, params.outerRadius) * params.treadAngle, 3),
      },
      extraSummary: `column ${profile.name}, ${round(treadDeg, 2)} deg per tread, ${round(totalDeg, 1)} deg in total, turn ${params.turn}`,
    });
  },
});
