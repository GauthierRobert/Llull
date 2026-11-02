/** Parameters shared by add_pipe_rack and update_pipe_rack, and their resolution into a stored `RackSpec` (explicit values, else the stored ones, else named defaults). */

import { vec2, z } from '@core/commands/schema';
import type { RackProblem } from './rackLayout';
import type { RackSpec } from './rackSpec';

export const DEFAULT_GRID_PREFIX = 'PR';

/** Optional version of every generator field; `add_pipe_rack` makes the required ones mandatory. */
export const rackFieldParams = {
  origin: vec2('Plan point [x, y] of the first bent on the first column line, DOCUMENT UNITS.'),
  direction: vec2(
    'Plan direction [x, y] of the rack (any length, not zero). The width extends to the LEFT of it. Only X or Y aligned racks are analysed as frames by check_steel_members.',
  ),
  length: z.number().positive().describe('Rack length along the direction, DOCUMENT UNITS. Needs bentSpacing; not with stations.'),
  bentSpacing: z
    .number()
    .positive()
    .describe(
      'Largest distance between bents, DOCUMENT UNITS (0 < bentSpacing <= length): n = ceil(length / bentSpacing) equal bays, so 60 m at 6 m gives 11 bents.',
    ),
  stations: z
    .array(z.number().min(0))
    .min(2)
    .describe(
      'Explicit bent positions along the direction from the origin, DOCUMENT UNITS, strictly ascending. Instead of length + bentSpacing.',
    ),
  width: z.number().positive().describe('Distance between the two column lines, DOCUMENT UNITS. Not with baysAcross.'),
  baysAcross: z
    .array(z.number().positive())
    .min(1)
    .describe('Bay widths across the rack, DOCUMENT UNITS; one more column line than bays (at most 8 bays). Instead of width.'),
  tiers: z
    .array(z.number())
    .min(1)
    .describe(
      'Top-of-steel elevations of the tier beams (and struts) above the level elevation, DOCUMENT UNITS, strictly ascending, e.g. [5000, 7000] in mm. Pipes resting on a tier beam have their underside at this elevation. The columns rise to the highest tier.',
    ),
  columnProfile: z
    .string()
    .describe(
      'Steel catalogue name of the columns, e.g. "HEB300" (list_steel_profiles). Their depth lies across the rack (strong axis in the bent).',
    ),
  tierBeamProfile: z
    .string()
    .describe('Steel catalogue name of the tier beams across each bent, e.g. "IPE300". Rigid joints to the columns (moment frame).'),
  strutProfile: z.string().describe('Steel catalogue name of the longitudinal struts (pinned). Default: the tier beam profile.'),
  struts: z
    .enum(['every_tier', 'top', 'none'])
    .describe('Longitudinal struts along every column line between bents: at every tier (default), at the top tier only, or none.'),
  bracingBays: z
    .array(z.number().int().min(1))
    .describe(
      '1-based bay numbers (bay k lies between bent k and k + 1) that get X-bracing in every column-line plane, one X per storey between grade and the tiers. [] removes the bracing.',
    ),
  bracingProfile: z.string().describe('Steel catalogue name of the braces, e.g. "L100x10". Required with bracingBays.'),
  baseFixity: z
    .enum(['pinned', 'fixed'])
    .describe('Column foot in check_steel_members. Default: left unset (pinned unless a base plate fixes it).'),
  gridPrefix: z
    .string()
    .min(1)
    .max(8)
    .describe(`Prefix of the member notes naming bents and column lines ("PRA3" = line A, bent 3). Default ${DEFAULT_GRID_PREFIX}.`),
};

type Fields = { [Key in keyof typeof rackFieldParams]?: z.infer<(typeof rackFieldParams)[Key]> | undefined };

const problem = (code: RackProblem['code'], message: string, ...paths: string[]): RackProblem => ({ code, message, paths });

/**
 * The spec from `fields` over `current` (null on add). Pushes the defaults it used onto `defaults` on add.
 * @failure missing / contradictory fields -> STA_RACK_SPACING (bays), STA_RACK_TIERS, STA_INVALID_GEOMETRY (profiles, origin, direction)
 */
export function resolveRack(fields: Fields, current: RackSpec | null, defaults: string[]): RackSpec | RackProblem {
  const origin = fields.origin ?? current?.origin;
  const direction = fields.direction ?? current?.direction;
  if (origin === undefined || direction === undefined)
    return problem('STA_INVALID_GEOMETRY', 'give origin and direction', 'origin', 'direction');
  const norm = Math.hypot(direction[0], direction[1]);
  if (!(norm > 0) || ![...origin, ...direction].every(Number.isFinite))
    return problem('STA_INVALID_GEOMETRY', 'origin must be finite and direction a non-zero plan vector', 'origin', 'direction');

  let along: RackSpec['along'] | undefined = current?.along;
  if (fields.stations !== undefined) {
    if (fields.length !== undefined || fields.bentSpacing !== undefined)
      return problem('STA_RACK_SPACING', 'give stations or length + bentSpacing, not both', 'stations', 'length', 'bentSpacing');
    along = { stations: fields.stations };
  } else if (fields.length !== undefined || fields.bentSpacing !== undefined) {
    const regular = along !== undefined && 'length' in along ? along : undefined;
    const length = fields.length ?? regular?.length;
    const bentSpacing = fields.bentSpacing ?? regular?.bentSpacing;
    if (length === undefined || bentSpacing === undefined)
      return problem('STA_RACK_SPACING', 'length and bentSpacing go together (or give stations)', 'length', 'bentSpacing');
    along = { length, bentSpacing };
  }
  if (along === undefined)
    return problem('STA_RACK_SPACING', 'give length with bentSpacing, or stations', 'length', 'bentSpacing', 'stations');

  let across: RackSpec['across'] | undefined = current?.across;
  if (fields.width !== undefined && fields.baysAcross !== undefined)
    return problem('STA_RACK_SPACING', 'give width or baysAcross, not both', 'width', 'baysAcross');
  if (fields.width !== undefined) across = { width: fields.width };
  else if (fields.baysAcross !== undefined) across = { baysAcross: fields.baysAcross };
  if (across === undefined) return problem('STA_RACK_SPACING', 'give width or baysAcross', 'width', 'baysAcross');

  const tiers = fields.tiers ?? current?.tiers;
  if (tiers === undefined) return problem('STA_RACK_TIERS', 'give tiers', 'tiers');
  const columnProfile = fields.columnProfile ?? current?.columnProfile;
  const tierBeamProfile = fields.tierBeamProfile ?? current?.tierBeamProfile;
  if (columnProfile === undefined || tierBeamProfile === undefined)
    return problem('STA_INVALID_GEOMETRY', 'give columnProfile and tierBeamProfile', 'columnProfile', 'tierBeamProfile');
  const strutProfile = fields.strutProfile ?? current?.strutProfile ?? tierBeamProfile;
  if (current === null && fields.strutProfile === undefined) defaults.push(`strutProfile ${tierBeamProfile} (the tier beam profile)`);
  const struts = fields.struts ?? current?.struts ?? 'every_tier';
  if (current === null && fields.struts === undefined) defaults.push('struts every_tier');
  const bracingBays = fields.bracingBays ?? current?.bracingBays ?? [];
  const bracingProfile = bracingBays.length === 0 ? undefined : (fields.bracingProfile ?? current?.bracingProfile);
  const baseFixity = fields.baseFixity ?? current?.baseFixity;
  if (current === null && baseFixity === undefined) defaults.push('baseFixity unset (pinned unless a base plate fixes it)');
  const gridPrefix = fields.gridPrefix ?? current?.gridPrefix ?? DEFAULT_GRID_PREFIX;
  if (current === null && fields.gridPrefix === undefined) defaults.push(`gridPrefix ${DEFAULT_GRID_PREFIX}`);
  return {
    kind: 'pipe_rack',
    origin,
    direction: [direction[0] / norm, direction[1] / norm],
    along,
    across,
    tiers,
    columnProfile,
    tierBeamProfile,
    strutProfile,
    struts,
    bracingBays,
    ...(bracingProfile === undefined ? {} : { bracingProfile }),
    ...(baseFixity === undefined ? {} : { baseFixity }),
    gridPrefix,
  };
}
