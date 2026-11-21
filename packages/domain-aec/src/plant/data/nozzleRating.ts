/**
 * Nozzle rating against its line (plant 08 DAT J4): for each end of a ROUTED process line that names a modelled nozzle (`<equipment tag>:<nozzle mark>`) the
 * nozzle's pressure class is compared with the flange class of the line's pipe spec, and the rating of that class AT THE LINE DESIGN TEMPERATURE (01 PSC
 * pressure-temperature table of the spec: its `ratingTableId`, else the table of its system and material group) with the line design pressure.
 * @invariant pure; never assumes a material group: a value that cannot be compared is reported `DAT_NOZZLE_RATING_UNCHECKED` with the reason (info for missing inputs, warn for a missing / mismatched table or a design temperature outside the table)
 * @failure no routed line, no named nozzle, or an equipment tag held by several equipment -> no class / pressure finding (the last is UNCHECKED)
 */

import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding } from '@aec/building/model';
import { parseRating } from '../equipment/geometry/nozzleHardware';
import { findRatingTable, ratingAt, ratingTableById } from '../catalog/ptRating';
import type { RatingTable } from '../catalog/types';
import { getPiping } from '../piping/model';
import { latestSpec } from '../spec/store';
import type { PipeSpec } from '../spec/types';
import { datFinding, type FindingSeverity, type DataFinding } from './codes';
import { lineEnds } from './lines';
import type { PlantObject } from './model';
import { elementOf } from './providers';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const squash = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

/** The rating table of the spec, or why there is none. Material group 1.1 is never assumed. */
function tableOf(doc: CadDocument, spec: PipeSpec | undefined): RatingTable | string {
  if (spec === undefined) return 'the line spec is not in the document';
  const { system, materialGroup, ratingTableId } = spec.rating;
  if (ratingTableId !== undefined) {
    const table = ratingTableById(doc, ratingTableId);
    if (table === undefined) return `rating table ${ratingTableId} of spec ${spec.id} is not in the document`;
    if (squash(table.standard) !== squash(system) || (materialGroup !== undefined && squash(table.materialGroup) !== squash(materialGroup)))
      return `rating table ${table.id} is ${table.standard} group ${table.materialGroup} but spec ${spec.id} rates ${system} group ${materialGroup ?? '(none)'}`;
    return table;
  }
  if (materialGroup === undefined) return `spec ${spec.id} has no material group; group 1.1 is not assumed`;
  return findRatingTable(doc, system, materialGroup) ?? `no rating table for ${system} group ${materialGroup}`;
}

const specClass = (spec: PipeSpec): string => (spec.rating.class !== undefined ? `CL${spec.rating.class}` : `PN${spec.rating.pn ?? ''}`);

export function nozzleRatingFindings(doc: CadDocument, line: PlantObject): DataFinding[] {
  const model = elementOf(doc, line.target);
  const routed = model?.provider.id === 'pipeLine' ? getPiping(doc).lines[model.element.id] : undefined;
  if (model === null || routed === undefined) return [];
  const spec = latestSpec(doc, routed.spec);
  const ends = lineEnds(doc, line);
  const findings: DataFinding[] = [];
  for (const end of ['from', 'to'] as const) {
    const split = /^(.+):([^:]+)$/.exec(ends[end] ?? '');
    const holders = split === null ? [] : elementsOf(getBuilding(doc), 'equipment').filter((item) => item.mark === split[1]);
    const equipment = holders[0];
    const nozzle = equipment?.plant?.nozzles.find((item) => item.mark === split?.[2]);
    if (equipment === undefined || nozzle === undefined) continue;
    const where = `${line.tag}.${end}`;
    const ids = [line.id, model.element.id, ...holders.map((item) => item.id)];
    const unchecked = (reason: string, severity: FindingSeverity = 'info'): void => {
      findings.push(
        datFinding(
          'DAT_NOZZLE_RATING_UNCHECKED',
          severity,
          `line ${line.tag} ${end} nozzle ${ends[end] ?? ''}: ${reason}; the rating was NOT checked`,
          ids,
          [where],
        ),
      );
    };
    if (holders.length > 1) {
      unchecked(`ambiguous equipment tag "${split?.[1] ?? ''}" (${holders.length} equipment hold it)`, 'warn');
      continue;
    }
    const parsed = parseRating(nozzle.rating);
    if (parsed === null) {
      unchecked(`the nozzle rating "${nozzle.rating}" is not CL<class> or PN<n>`);
      continue;
    }
    const specNumber = spec?.rating.class ?? spec?.rating.pn;
    const sameSystem = (spec?.rating.class !== undefined) === (parsed.class !== undefined);
    if (spec !== undefined && specNumber !== undefined && (!sameSystem || specNumber !== (parsed.class ?? parsed.pn)))
      findings.push(
        datFinding(
          'DAT_NOZZLE_RATING_CLASS',
          'warn',
          `line ${line.tag} ${end}: nozzle ${ends[end] ?? ''} is ${nozzle.rating} but spec ${routed.spec} is ${specClass(spec)}`,
          ids,
          [where],
        ),
      );
    if (routed.designTempC === undefined || routed.designPressureBarG === undefined) {
      unchecked(`line ${routed.lineNumber} has no ${routed.designTempC === undefined ? 'designTempC' : 'designPressureBarG'}`);
      continue;
    }
    const table = tableOf(doc, spec);
    if (typeof table === 'string') {
      unchecked(table, 'warn');
      continue;
    }
    const number = table.ratingKey === 'pn' ? parsed.pn : parsed.class;
    if (number === undefined) {
      unchecked(`table ${table.id} rates by ${table.ratingKey ?? 'class'}, not ${nozzle.rating}`, 'warn');
      continue;
    }
    const answer = ratingAt(table, number, routed.designTempC);
    if (!answer.ok) {
      unchecked(`${answer.code}: ${answer.message}`, 'warn');
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
