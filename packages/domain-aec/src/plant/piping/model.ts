/** Access to `doc.plant.piping` and the stable refusal codes of the piping commands (02 RTE §7). */

import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@core/model/plant';
import { tableRejection } from '@core/commands/noop';

export const EMPTY_PIPING: PipingModel = { tieIns: {}, tieInOrder: [], lines: {}, lineOrder: [], runs: {}, runOrder: [] };

export const getPiping = (doc: Pick<CadDocument, 'plant'>): PipingModel => doc.plant?.piping ?? EMPTY_PIPING;

export const withPiping = (doc: CadDocument, piping: PipingModel): CadDocument => ({ ...doc, plant: { ...doc.plant, piping } });

/** Remediation per code (02 RTE §7). */
const REMEDIATION: Readonly<Record<string, string>> = {
  RTE_UNKNOWN_LINE: 'Create the line first with create_pipeline and pass its id (affected[0]).',
  RTE_UNKNOWN_PORT: 'Pass the id of a tie-in point (add_tie_in_point) or { point, direction } for an open end.',
  RTE_PORT_IN_USE: 'Route from a free tie-in point; a tie-in takes one run (branches come with add_branch, 02 M2).',
  RTE_INVALID_PORT: 'Give a non-zero direction pointing from the connection face toward the pipe.',
  RTE_DUPLICATE_TAG: 'Choose another tag; tie-in tags are unique.',
  RTE_DUPLICATE_LINE_NUMBER: 'Choose another sequence or pass an explicit unique lineNumber.',
  RTE_SPEC_NO_COMPONENT: 'Use a tabulated size, or pass the dimension explicitly (elbowCentreToEnd, flangeSetLength).',
  RTE_SIZE_MISMATCH: 'Route between ports of the line size, or change the line DN.',
  RTE_PORT_DIRECTION: 'Auto-routing needs ports facing along +X, -X, +Y, -Y, +Z or -Z.',
  RTE_UNKNOWN_KEEPOUT: 'Pass ids of existing entities in keepOut (find_entities), or boxes in keepOutBoxes.',
  RTE_AUTOROUTE_NO_PATH: 'Widen the grid box (gridMargin), lower the clearance, use a finer grid or move the ports onto a common grid.',
  RTE_AUTOROUTE_BUDGET:
    'Run the native router: llull auto_route with the same params (llull-compute route, 2e6 expansions), or use a coarser grid.',
  RTE_AUTOROUTE_SOLUTION_INVALID: 'Re-run llull auto_route on the current document, or drop solution to route with the TypeScript search.',
};

export const refuse = tableRejection(REMEDIATION);
