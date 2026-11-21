/**
 * Nozzle rating against its line (plant 08 DAT J4): for each end of a ROUTED process line that names a modelled nozzle (`<equipment tag>:<nozzle mark>`) the
 * nozzle's pressure class is compared with the flange class of the line's pipe spec, and the rating of that class AT THE LINE DESIGN TEMPERATURE (01 PSC
 * pressure-temperature table: the spec's imported / grouped table, else the bundled ASME B16.5 group 1.1) with the line design pressure.
 * @invariant pure; reads only the bundled / imported rating tables, never guesses a rating: a value that cannot be compared is reported `DAT_NOZZLE_RATING_UNCHECKED` (info) with the reason
 * @failure no routed line, no named nozzle, or no parsable rating -> no finding about class / pressure
 */

import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding } from '@aec/building/model';
import { parseRating } from '../equipment/geometry/nozzleHardware';
import { BUNDLED_RATING_TABLE_ID } from '../catalog/bundled';
import { findRatingTable, ratingAt, ratingTableById } from '../catalog/ptRating';
import type { RatingTable } from '../catalog/types';
import { getPiping } from '../piping/model';
import { latestSpec } from '../spec/store';
import type { PipeSpec } from '../spec/types';
import { datFinding, type DataFinding } from './codes';
import { lineEnds } from './lines';
import type { PlantObject } from './model';
import { elementOf } from './providers';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function tableOf(doc: CadDocument, spec: PipeSpec | undefined): RatingTable | undefined {
  const rating = spec?.rating;
  if (rating?.ratingTableId !== undefined) return ratingTableById(doc, rating.ratingTableId);
  if (rating?.materialGroup !== undefined) return findRatingTable(doc, rating.system, rating.materialGroup);
  return ratingTableById(doc, BUNDLED_RATING_TABLE_ID);
}

export function nozzleRatingFindings(doc: CadDocument, line: PlantObject): DataFinding[] {
  const model = elementOf(doc, line.target);
  const routed = model?.provider.id === 'pipeLine' ? getPiping(doc).lines[model.element.id] : undefined;
  if (model === null || routed === undefined) return [];
  const spec = latestSpec(doc, routed.spec);
  const ends = lineEnds(doc, line);
  const findings: DataFinding[] = [];
  for (const end of ['from', 'to'] as const) {
    const split = /^(.+):([^:]+)$/.exec(ends[end] ?? '');
    const equipment = split === null ? undefined : elementsOf(getBuilding(doc), 'equipment').find((item) => item.mark === split[1]);
    const nozzle = equipment?.plant?.nozzles.find((item) => item.mark === split?.[2]);
    if (equipment === undefined || nozzle === undefined) continue;
    const where = `${line.tag}.${end}`;
    const ids = [line.id, model.element.id, equipment.id];
    const unchecked = (reason: string): void => {
      findings.push(
        datFinding(
          'DAT_NOZZLE_RATING_UNCHECKED',
          'info',
          `line ${line.tag} ${end} nozzle ${ends[end] ?? ''}: ${reason}; the rating was NOT checked`,
          ids,
          [where],
        ),
      );
    };
    const parsed = parseRating(nozzle.rating);
    if (parsed === null) {
      unchecked(`the nozzle rating "${nozzle.rating}" is not CL<class> or PN<n>`);
      continue;
    }
    const specNumber = spec?.rating.class ?? spec?.rating.pn;
    const nozzleNumber = parsed.class ?? parsed.pn;
    const sameSystem = (spec?.rating.class !== undefined) === (parsed.class !== undefined);
    if (spec !== undefined && specNumber !== undefined && (!sameSystem || specNumber !== nozzleNumber))
      findings.push(
        datFinding(
          'DAT_NOZZLE_RATING_CLASS',
          'warn',
          `line ${line.tag} ${end}: nozzle ${ends[end] ?? ''} is ${nozzle.rating} but spec ${routed.spec} is ${spec.rating.class !== undefined ? `CL${spec.rating.class}` : `PN${spec.rating.pn ?? ''}`}`,
          ids,
          [where],
        ),
      );
    if (routed.designTempC === undefined || routed.designPressureBarG === undefined) {
      unchecked(`line ${routed.lineNumber} has no ${routed.designTempC === undefined ? 'designTempC' : 'designPressureBarG'}`);
      continue;
    }
    const table = tableOf(doc, spec);
    const number = table?.ratingKey === 'pn' ? parsed.pn : parsed.class;
    if (table === undefined || number === undefined) {
      unchecked(
        table === undefined
          ? 'no rating table for the spec material group'
          : `table ${table.id} rates by ${table.ratingKey ?? 'class'}, not ${nozzle.rating}`,
      );
      continue;
    }
    const answer = ratingAt(table, number, routed.designTempC);
    if (!answer.ok) {
      unchecked(`${answer.code}: ${answer.message}`);
      continue;
    }
    if (routed.designPressureBarG > answer.ratingBar)
      findings.push(
        datFinding(
          'DAT_NOZZLE_RATING_LOW',
          'fail',
          `line ${line.tag} ${end}: design ${routed.designPressureBarG} bar g at ${routed.designTempC} degC exceeds the ${nozzle.rating} rating ${round3(answer.ratingBar)} bar of nozzle ${ends[end] ?? ''} (${table.id}, ${answer.method}${answer.verified ? '' : ', unverified rows'})`,
          ids,
          [where],
        ),
      );
  }
  return findings;
}
