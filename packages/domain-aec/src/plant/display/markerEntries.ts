/**
 * Pipes and runs the marker commands work on (plant 09 VIS-M7): the building pipe or 02 RTE run behind an id with its line, service and centreline, the
 * colour-profile rule its service selects, and the list of every pipe id.
 */

import type { CadDocument } from '@core/model/types';
import type { ColourRule } from '@core/model/display';
import type { CompiledProfile } from '@core/geometry/colourRules';
import { getBuilding } from '../../building/model';
import { getPiping } from '../piping/model';
import { pipeCentreline, type SourcePipe } from '../common/pipeCentrelines';

export interface Entry {
  readonly id: string;
  readonly kind: 'pipe' | 'run';
  /** 02 RTE line id of a run, null for a building pipe. */
  readonly lineId: string | null;
  readonly line: string | null;
  readonly service: string | null;
  readonly source: SourcePipe;
}

export function entryOf(doc: CadDocument, id: string): Entry | null {
  const building = getBuilding(doc);
  const element = Object.hasOwn(building.elements, id) ? building.elements[id] : undefined;
  if (element?.category === 'pipe') {
    const source = pipeCentreline(doc, 'pipes', id);
    return typeof source === 'string'
      ? null
      : { id, kind: 'pipe', lineId: null, line: element.line ?? null, service: element.service, source };
  }
  const piping = getPiping(doc);
  const run = Object.hasOwn(piping.runs, id) ? piping.runs[id] : undefined;
  if (run === undefined) return null;
  const source = pipeCentreline(doc, 'runs', id);
  const line = piping.lines[run.lineId];
  return typeof source === 'string'
    ? null
    : { id, kind: 'run', lineId: run.lineId, line: line?.lineNumber ?? null, service: line?.service ?? null, source };
}

/** The first rule of the profile the pipe's service / line selects (the core evaluator, so every predicate form works). */
export const ruleOf = (compiled: CompiledProfile | undefined, entry: Entry): ColourRule | null =>
  compiled === undefined
    ? null
    : compiled.select({
        ...(entry.service === null ? {} : { service: entry.service }),
        ...(entry.line === null ? {} : { line: entry.line }),
        category: 'pipe',
      });

/** Every building pipe id, then every routed run id. */
export const allPipeIds = (doc: CadDocument): string[] => [
  ...Object.values(getBuilding(doc).elements)
    .filter((element) => element.category === 'pipe')
    .map((element) => element.id),
  ...getPiping(doc).runOrder,
];
