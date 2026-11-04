/**
 * Open line ends (plant 08 DAT `DAT_OPEN_PORT`): an end of a process line is open when the line names nothing there and the pipe end it draws is attached to nothing:
 * a legacy pipe has no attachments; a routed run end is attached by a nozzle, a tie-in, a run end or a branch (`ref`). A line with no pipe has no end to be open.
 * @invariant pure; a named end (tag, nozzle, battery limit) is never open
 */

import type { CadDocument } from '@core/model/types';
import { getPiping } from '../piping/model';
import type { PlantObject } from './model';
import { polylinesOf } from './plantReports/lineGeometry';

export function isOpenEnd(doc: CadDocument, line: PlantObject, end: 'from' | 'to'): boolean {
  const shapes = polylinesOf(doc, line).filter((poly) => poly.points.length >= 2);
  const edge = end === 'from' ? shapes[0] : shapes.at(-1);
  if (edge === undefined) return false;
  if (edge.runId === undefined) return true;
  const run = getPiping(doc).runs[edge.runId];
  return run !== undefined && (end === 'from' ? run.start.ref : run.end.ref) === undefined;
}
