/** Access to `doc.plant.piping` and the stable refusal codes of the piping commands (02 RTE §7). */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { tableRejection } from '@core/commands/noop';

export const EMPTY_PIPING: PipingModel = { tieIns: {}, tieInOrder: [], lines: {}, lineOrder: [], runs: {}, runOrder: [], entityIds: {} };

export const getPiping = (doc: Pick<CadDocument, 'plant'>): PipingModel => doc.plant?.piping ?? EMPTY_PIPING;

export const withPiping = (doc: CadDocument, piping: PipingModel): CadDocument => ({ ...doc, plant: { ...doc.plant, piping } });

/** The points of a run: start, interior points of intersection, end. */
export const runPoints = (run: PipeRun): Vec3[] => [run.start.point, ...run.pis, run.end.point];

/** Remediation per code (02 RTE §7). */
const REMEDIATION: Readonly<Record<string, string>> = {
  RTE_UNKNOWN_LINE: 'Create the line first with create_pipeline and pass its id (affected[0]).',
  RTE_UNKNOWN_PORT:
    'Pass a tie-in id (add_tie_in_point), "<tag>:<mark>" of an equipment nozzle (equipment_ports), "<runId>:start|end", or { point, direction } for an open end.',
  RTE_UNKNOWN_RUN: 'Pass the id of a routed run (affected[0] of route_pipe / auto_route_pipe; plant.piping.runOrder).',
  RTE_PORT_IN_USE:
    'Route from a free port; delete_pipe_run frees the ports of a run (a port takes one run; take a branch off a run with add_branch).',
  RTE_HAS_BRANCHES:
    'Delete the dependent runs first (delete_pipe_run on the ids listed), or pass cascade: true to delete them with it; branch runs and runs that continue from a run end depend on it.',
  RTE_INVALID_PORT: 'Give a non-zero direction pointing from the connection face toward the pipe.',
  RTE_DUPLICATE_TAG: 'Choose another tag; tie-in tags are unique.',
  RTE_DUPLICATE_LINE_NUMBER: 'Choose another sequence or pass an explicit unique lineNumber.',
  RTE_SPEC_UNKNOWN:
    'Import the spec (import_pipe_spec) and every catalogue it names (import_piping_catalog), or create the line with a loaded spec id (list_pipe_specs).',
  RTE_SPEC_NO_COMPONENT:
    'Add the missing component or dimension to the spec or its catalogue (import_piping_catalog, edit_pipe_spec), or change the size / rating. detail names the row.',
  RTE_SPEC_AMBIGUOUS: 'Give one of the matching spec components a lower priority (edit_pipe_spec).',
  RTE_NO_CONNECTION_RULE:
    'The spec joins BW-BW (butt weld), SW to plain-end pipe (socket weld), SC-SC (threaded) and FL-FL ends: use a port or fitting whose end type the pipe of the spec takes (BE pipe: BW; PE pipe: SW; THD pipe: SC), or change the spec.',
  RTE_NO_FITTING_FOR_ANGLE:
    'Turn by an angle the spec lists (data.anglesDeg, 90 / 45) within the tolerance, or pass angleToleranceDeg; a reversal needs two turns.',
  RTE_SEGMENT_TOO_SHORT:
    'Lengthen the leg to at least the sum of its fitting centre-to-ends and flange sets (detail.cutLengthMm is negative).',
  RTE_ZERO_LEG: 'Remove the leg, or give every leg a direction and a positive length (only the last leg may omit it when `to` is a port).',
  RTE_CLOSING_LEG_IMPOSSIBLE:
    'Add legs until the remaining offset (detail.offset) is along the target port axis, then the closing leg is added automatically.',
  RTE_STRETCH_FAILED:
    'The legs cannot follow the move orthogonally (the part no leg is parallel to is named, or a leg / component would vanish): move the equipment back, re-route the run with edit_route (its ends then follow their ports), or delete_pipe_run and route_pipe again. A broken run is kept as routed and its parts are not drawn.',
  RTE_PIPE_HAS_SUPPORTS:
    'Keep the legacy pipe (omit replace), or delete its pipe supports first (delete_building_element), convert with replace, then place supports on the new run with add_pipe_support runId.',
  RTE_SLOPE_INVALID:
    'Give planLength (horizontal length, > 0) and slope { value > 0 and at most 45 degrees (100 %), unit percent | ratio | deg, fall } on a leg with a horizontal direction; omit length.',
  RTE_EDIT_INVALID:
    'Check the op parameters: move_pi needs delta or point, stretch_leg a length, insert_pi points, delete_pi an index and count within run.pis; move an inline component or branch off a leg the edit removes first.',
  RTE_TEMPLATE_INVALID:
    'Use only {dn} {service} {sequence} {spec} {insulationCode} {insulationThickness}, each at most once, keep {sequence}, and write optional parts as [...] without nesting.',
  RTE_SIZE_MISMATCH:
    'Route between ports of the line size (create a line of the port DN), or put a reducer in the run: pass inline [{ type: "reducerConcentric", dn2 }] to route_pipe, or insert_inline_component a reducer whose dn2 is the size the end port has.',
  RTE_RATING_MISMATCH: 'Use a spec whose flange rating equals the port rating (CL150, PN16 ...), or fix the nozzle / tie-in rating.',
  RTE_FACING_MISMATCH: 'Use a spec whose flange facing equals the port facing (RF, FF, RTJ), or fix the nozzle / tie-in facing.',
  RTE_ECCENTRIC_INVALID:
    'Give an eccentric reducer exactly one of flat ("top" for flat on top = +Z, "bottom" for flat on bottom = -Z; horizontal or sloped pipes) and flatDirection [dx, dy, dz] (the side of the pipe the flat is on, needed on vertical pipes); concentric reducers and valves have no flat side.',
  RTE_ECCENTRIC_OFFSET:
    'The smaller pipe of an eccentric reducer sits (OD big - OD small) / 2 off the axis of the bigger one, and the leg after the reducer must take that offset up along its own axis: turn the flat side to the direction of the next leg (flat / flatDirection), move the reducer to a leg followed by a turn along the flat, or cancel it with a second reducer (expander) on the same leg.',
  RTE_NO_RUNS: 'Route the line first with route_pipe (or auto_route_pipe), or pass the id of a line that has a run.',
  RTE_TRACING_INVALID:
    'The first set_heat_tracing on a line needs type (electric | steam | hot_water | thermal_fluid) and tracers (1 to 6); later calls may change single fields.',
  RTE_HEAT_LOSS_INPUT:
    'Give film coefficients and conductivities > 0, and a line whose spec pipe row has an outside diameter and a wall thinner than the radius (list_pipe_specs, edit_pipe_spec).',
  RTE_UNKNOWN_PIPE:
    'Pass the building element id of a legacy pipe (affected[0] of add_pipe_run, e.g. "pipe-3"; building_schedule kind "pipe" lists them).',
  RTE_UNKNOWN_COMPONENT:
    'Pass the id of an inline component of that run (affected[0] of insert_inline_component; piping_takeoff lists them as data.inline).',
  RTE_INLINE_DOES_NOT_FIT:
    'Move the component (centreDistance on the leg), lengthen the leg, or pick another leg: it needs face-to-face + both flange sets (valve) or its length (reducer) between its neighbours.',
  RTE_BRANCH_ON_FITTING:
    'Move the branch point onto a straight pipe piece: clear of elbows, flange sets, valves and other tees (an olet needs the branch radius to each pipe end).',
  RTE_BRANCH_NO_TABLE_ROW:
    'Extend the spec branch table for this header x branch size (edit_pipe_spec), or pick a branch size the table has (resolve_branch lists them).',
  RTE_UNITS_UNSUPPORTED: 'Route in a mm document (plant lengths, ODs and the lattice are in mm until unit conversion lands): set_units mm.',
  RTE_PORT_DIRECTION:
    'Start the first leg along the start port direction and arrive along the end port direction (within the angle tolerance); auto-routing needs ports facing +X, -X, +Y, -Y, +Z or -Z.',
  RTE_UNKNOWN_KEEPOUT: 'Pass ids of existing entities in keepOut (find_entities), or boxes in keepOutBoxes.',
  RTE_AUTOROUTE_NO_PATH: 'Widen the grid box (gridMargin), lower the clearance, use a finer grid or move the ports onto a common grid.',
  RTE_AUTOROUTE_BUDGET:
    'Run the native router: llull auto_route with the same params (llull-compute route, 2e6 expansions), or use a coarser grid.',
  RTE_AUTOROUTE_SOLUTION_INVALID: 'Re-run llull auto_route on the current document, or drop solution to route with the TypeScript search.',
};

export const refuse = tableRejection(REMEDIATION);

/**
 * Where `point` lies on the centreline of `run`: the first leg whose axis passes within `toleranceMm` of it (between the two points of
 * intersection), with the distance from that leg's start. Null when the point is not on the run.
 */
export function locateOnRun(run: PipeRun, point: Vec3, toleranceMm = 0.01): { leg: number; distance: number } | null {
  const points = runPoints(run);
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const [a, b] = [points[leg] as Vec3, points[leg + 1] as Vec3];
    const axis: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(...axis);
    if (!(length > 0)) continue;
    const offset: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const distance = (offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]) / length;
    const sideways = Math.hypot(
      offset[0] - (axis[0] / length) * distance,
      offset[1] - (axis[1] / length) * distance,
      offset[2] - (axis[2] / length) * distance,
    );
    if (sideways <= toleranceMm && distance >= -toleranceMm && distance <= length + toleranceMm) return { leg, distance };
  }
  return null;
}
