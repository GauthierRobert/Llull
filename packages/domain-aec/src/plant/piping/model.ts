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
    'Route from a free port; delete_pipe_run frees the ports of a run (a port takes one run; branches come with add_branch, 02 M2).',
  RTE_HAS_BRANCHES:
    'Delete the dependent runs first (delete_pipe_run on the ids listed); a run that continues from another run end depends on it.',
  RTE_INVALID_PORT: 'Give a non-zero direction pointing from the connection face toward the pipe.',
  RTE_DUPLICATE_TAG: 'Choose another tag; tie-in tags are unique.',
  RTE_DUPLICATE_LINE_NUMBER: 'Choose another sequence or pass an explicit unique lineNumber.',
  RTE_SPEC_UNKNOWN:
    'Import the spec (import_pipe_spec) and every catalogue it names (import_piping_catalog), or create the line with a loaded spec id (list_pipe_specs).',
  RTE_SPEC_NO_COMPONENT:
    'Add the missing component or dimension to the spec or its catalogue (import_piping_catalog, edit_pipe_spec), or change the size / rating. detail names the row.',
  RTE_SPEC_AMBIGUOUS: 'Give one of the matching spec components a lower priority (edit_pipe_spec).',
  RTE_NO_CONNECTION_RULE: 'The spec joins only BW-BW and FL-FL ends in this version: use a port of end type BW or FL, or change the spec.',
  RTE_NO_FITTING_FOR_ANGLE:
    'Turn by an angle the spec lists (data.anglesDeg, 90 / 45) within the tolerance, or pass angleToleranceDeg; a reversal needs two turns.',
  RTE_SEGMENT_TOO_SHORT:
    'Lengthen the leg to at least the sum of its fitting centre-to-ends and flange sets (detail.cutLengthMm is negative).',
  RTE_ZERO_LEG: 'Remove the leg, or give every leg a direction and a positive length (only the last leg may omit it when `to` is a port).',
  RTE_CLOSING_LEG_IMPOSSIBLE:
    'Add legs until the remaining offset (detail.offset) is along the target port axis, then the closing leg is added automatically.',
  RTE_STRETCH_FAILED:
    'The port moved away from the routed end (equipment or tie-in edit): delete_pipe_run and route_pipe again; orthogonal stretch comes with 02 M3. The run is marked broken and its parts are not drawn.',
  RTE_SIZE_MISMATCH:
    'Route between ports of the line size (create a line of the port DN), or change the line DN; a reducer transition between sizes comes with 02 M2.',
  RTE_RATING_MISMATCH: 'Use a spec whose flange rating equals the port rating (CL150, PN16 ...), or fix the nozzle / tie-in rating.',
  RTE_FACING_MISMATCH: 'Use a spec whose flange facing equals the port facing (RF, FF, RTJ), or fix the nozzle / tie-in facing.',
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
