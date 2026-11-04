/**
 * The stored markers of one pipe (plant 09 VIS §5.7): placement from `markerPlan`, legend size from `markerLegend`, letters from the profile rule the pipe's service selects,
 * a both-ways arrow when the plant data object standing for the pipe's line is flagged `bidirectional`.
 * @invariant pure; ids are `<pipe id>:<k>`, k from 1 along the pipe, so a rerun replaces the markers of a pipe exactly
 */

import type { CadDocument } from '@core/model/types';
import type { CompiledProfile } from '@core/geometry/colourRules';
import type { PipeMarker } from '@core/model/display';
import { getPlantData } from '../data/model';
import { objectRegistry } from '../data/registry';
import { ruleOf, type Entry } from './markerEntries';
import { legendFor, type Legend } from './markerLegend';
import { lengthOf, planMarkers, pointAt, requirements } from './markerPlan';

/** The plant data object that stands for the pipe's line: the drawn pipe itself, or the routed line of a run. */
function lineObject(doc: CadDocument, entry: Entry): { properties: Readonly<Record<string, unknown>> } | undefined {
  const data = getPlantData(doc);
  const key = entry.kind === 'pipe' ? `buildingElement:${entry.id}` : `pipeLine:${entry.lineId ?? ''}`;
  const id = objectRegistry(data).byTarget.get(key);
  return id === undefined ? undefined : data.objects[id];
}

export function markerRecords(
  doc: CadDocument,
  entry: Entry,
  spacingMm: number,
  insulationMm: number,
  compiled: CompiledProfile | undefined,
): { readonly legend: Legend; readonly markers: PipeMarker[] } {
  const legend = legendFor(entry.source.odMm, insulationMm);
  const rule = ruleOf(compiled, entry);
  const bidirectional = lineObject(doc, entry)?.properties['bidirectional'] === true;
  const points = entry.source.points;
  const markers = planMarkers(requirements(doc, entry.source), lengthOf(points), spacingMm).map((planned, index): PipeMarker => {
    const { positionMm, tangent } = pointAt(points, planned.atMm);
    return {
      id: `${entry.id}:${index + 1}`,
      pipeId: entry.id,
      positionMm,
      tangent,
      atMm: planned.atMm,
      reason: planned.reason,
      fieldLengthMm: legend.fieldLengthMm,
      letterHeightMm: legend.letterHeightMm,
      bandInterpolated: legend.bandInterpolated,
      ...(rule?.marker === undefined ? {} : { letters: rule.marker.letters }),
      ...(rule?.marker?.letterHex === undefined ? {} : { letterHex: rule.marker.letterHex }),
      bidirectional,
    };
  });
  return { legend, markers };
}
