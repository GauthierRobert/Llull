/**
 * Material take-off items of the process lines (plant 08 DAT §5.9, M5): the centreline of a legacy pipe (pipe metres, bends), and for a routed run of 02 RTE the
 * pieces its spec derives: straight pipe by cut length (the take-outs of the 01 PSC catalogue are already deducted) and every fitting, flange, gasket, bolt set
 * and valve counted in `ea` by its takeoff key. A run that no longer derives falls back to its centreline and says so.
 */

import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { routeLength } from '@aec/industrial/piping/routeSupport';
import { deriveRun } from '../../piping/routeParts';
import { getPiping } from '../../piping/model';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject, type PlantValue } from '../model';
import { membersByLine, polylinesOf, type LinePolyline } from './lineGeometry';
import { round6 } from './types';

export type MtoBasis = 'centreline' | 'cutLength' | 'catalogue';

export interface MtoItem {
  readonly spec: PlantValue;
  readonly itemType: string;
  readonly nominalSize: PlantValue;
  readonly line: string;
  readonly hierarchy: string;
  readonly quantity: number;
  readonly unit: 'm' | 'ea';
  readonly basis: MtoBasis;
  /** The spec is not approved or a catalogue row is not grade A (AF-32), or the run fell back to its centreline. */
  readonly flagged: boolean;
}

type Common = Pick<MtoItem, 'spec' | 'line' | 'hierarchy'> & { readonly nominalSize: PlantValue };

function centrelineItems(doc: CadDocument, polylines: readonly LinePolyline[], common: Common, flagged: boolean): MtoItem[] {
  const usable = polylines.filter((poly) => poly.points.length >= 2);
  if (usable.length === 0) return [];
  const metres = round6(
    toMetres(
      doc,
      usable.reduce((sum, poly) => sum + routeLength(poly.points), 0),
    ),
  );
  const bends = usable.reduce((sum, poly) => sum + poly.points.length - 2, 0);
  const items: MtoItem[] = [{ ...common, itemType: 'pipe', quantity: metres, unit: 'm', basis: 'centreline', flagged }];
  if (bends > 0) items.push({ ...common, itemType: 'bend', quantity: bends, unit: 'ea', basis: 'centreline', flagged });
  return items;
}

function routedItems(doc: CadDocument, runId: string, poly: LinePolyline, common: Common): MtoItem[] {
  const run = getPiping(doc).runs[runId];
  const derived = run === undefined ? undefined : deriveRun(doc, run);
  if (derived === undefined || !derived.ok)
    return centrelineItems(doc, [poly], { ...common, nominalSize: common.nominalSize ?? poly.dn ?? null }, true);
  const items: MtoItem[] = [];
  for (const part of derived.parts) {
    const flagged = part.unverified || derived.unverified;
    if (part.kind === 'pipe')
      items.push({
        ...common,
        itemType: 'pipe',
        nominalSize: part.dn,
        quantity: (part.cutLength ?? 0) / 1000,
        unit: 'm',
        basis: 'cutLength',
        flagged,
      });
    else items.push({ ...common, itemType: part.typeKey, nominalSize: part.dn, quantity: 1, unit: 'ea', basis: 'catalogue', flagged });
  }
  return items;
}

/** Items of the given process lines, in line order. */
export function mtoItems(doc: CadDocument, lines: readonly PlantObject[]): MtoItem[] {
  const data = getPlantData(doc);
  const members = membersByLine(data);
  return lines.flatMap((line) => {
    const polylines = [line, ...(members.get(line.id) ?? [])].flatMap((object) => polylinesOf(doc, object));
    const dn = polylines.find((poly) => poly.dn !== undefined)?.dn;
    const common: Common = {
      spec: line.properties['spec'] ?? null,
      nominalSize: line.properties['nominalSize'] ?? dn ?? null,
      line: line.tag,
      hierarchy: pathOf(data, line.hierarchyId),
    };
    return [
      ...centrelineItems(
        doc,
        polylines.filter((poly) => poly.runId === undefined),
        common,
        false,
      ),
      ...polylines.flatMap((poly) => (poly.runId === undefined ? [] : routedItems(doc, poly.runId, poly, common))),
    ];
  });
}
