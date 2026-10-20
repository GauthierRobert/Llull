import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { TieInPoint } from '@core/model/plant';
import type { Vec3 } from '@core/model/vectors';
import { nextId } from '@lib/id';
import { getPiping, refuse, withPiping } from '../model';

export const END_TYPES = ['BW', 'FL', 'SW', 'SC', 'PL', 'WAF', 'LUG'] as const;

/**
 * @affects creates 1 tie-in point in plant.piping (no geometry)
 * @invariant direction stored normalised; tags unique
 * @failure zero direction -> RTE_INVALID_PORT; tag already used -> RTE_DUPLICATE_TAG
 */
export const addTieInPoint = defineCommand({
  name: 'add_tie_in_point',
  description:
    'Add a piping connection point (tie-in or battery limit) that runs start or end at: world position, outward face direction (pointing from ' +
    'the connection face toward the pipe), nominal size DN and end type. Lengths in document units (mm in plant documents). Returns the tie-in ' +
    'id (affected[0]) to pass as { portId } to route_problem / auto_route_pipe. Refusals: RTE_INVALID_PORT, RTE_DUPLICATE_TAG. ' +
    'Next: create_pipeline, then auto_route_pipe.',
  params: z.object({
    tag: z.string().min(1).describe('Unique tag, e.g. "TP-1".'),
    position: vec3('World position [x, y, z] of the connection face centre.'),
    direction: vec3('Outward face direction [dx, dy, dz] (toward the pipe); normalised. Auto-routing needs an axis direction.'),
    dn: z.number().int().positive().describe('Nominal size DN (e.g. 100).'),
    endType: z.enum(END_TYPES).describe('End type: BW butt weld, FL flanged, SW socket weld, SC screwed, PL plain, WAF wafer, LUG lug.'),
    rating: z.string().optional().describe("Pressure rating, e.g. 'CL150' or 'PN16'."),
    facing: z.enum(['RF', 'FF', 'RTJ']).optional().describe('Flange facing (flanged ends).'),
    kind: z.enum(['tie_in', 'battery_limit']).optional().describe("Point kind (default 'tie_in')."),
  }),
  run: (doc, { tag, position, direction, dn, endType, rating, facing, kind = 'tie_in' }): CommandResult => {
    const piping = getPiping(doc);
    const length = Math.hypot(...direction);
    if (!(length > 1e-12)) return refuse(doc, 'add_tie_in_point', 'RTE_INVALID_PORT', 'the direction is zero', [], ['direction']);
    const clash = piping.tieInOrder.find((id) => piping.tieIns[id]?.tag === tag);
    if (clash !== undefined)
      return refuse(doc, 'add_tie_in_point', 'RTE_DUPLICATE_TAG', `tag "${tag}" is used by ${clash}`, [clash], ['tag']);
    const id = nextId('tie');
    const unit = direction.map((v) => v / length) as unknown as Vec3;
    const tieIn: TieInPoint = {
      id,
      tag,
      kind,
      port: {
        position,
        direction: unit,
        dn,
        endType,
        ...(rating === undefined ? {} : { rating }),
        ...(facing === undefined ? {} : { facing }),
      },
    };
    const next = withPiping(doc, { ...piping, tieIns: { ...piping.tieIns, [id]: tieIn }, tieInOrder: [...piping.tieInOrder, id] });
    return changed(
      next,
      `add_tie_in_point: ${kind} ${id} "${tag}" DN${dn} ${endType} at [${position.join(', ')}] facing [${unit.map((v) => +v.toFixed(6)).join(', ')}].`,
      [id],
    );
  },
});
