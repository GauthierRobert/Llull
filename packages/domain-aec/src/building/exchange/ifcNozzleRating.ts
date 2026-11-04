/**
 * Pressure rating of a nozzle read from the 01 PSC rating table (plant 08 DAT H6): a nozzle stores only its class label (`CL150`); the IFC port also carries the rated
 * pressure at 38 degC (100 degF, the first column of ASME B16.5) of the bundled table, with its basis and whether every table row it used is verified.
 * @invariant pure; a label that is not `CL<class>`, or a class the table lacks, adds nothing
 */

import type { CadDocument } from '@core/model/types';
import { BUNDLED_RATING_TABLE_ID } from '../../plant/catalog/bundled';
import { ratingAt, ratingTableById } from '../../plant/catalog/ptRating';
import { ifcReal, ifcString } from './ifcStep';

const REFERENCE_TEMPERATURE_C = 38;

/** `Pset_llullNozzle` properties `RatedPressure` (Pa, gauge), `RatedPressureBasis`, `RatedPressureVerified`; none when the rating has no PSC row. */
export function ratedPressureProperties(doc: CadDocument, rating: string): string[] {
  const label = /^CL\s*(\d+)$/i.exec(rating.trim());
  const table = ratingTableById(doc, BUNDLED_RATING_TABLE_ID);
  if (label === null || table === undefined) return [];
  const answer = ratingAt(table, Number(label[1]), REFERENCE_TEMPERATURE_C);
  if (!answer.ok) return [];
  return [
    `IFCPROPERTYSINGLEVALUE('RatedPressure','Rated pressure, gauge, Pa, from the 01 PSC rating table',IFCPRESSUREMEASURE(${ifcReal(answer.ratingBar * 1e5)}),$)`,
    `IFCPROPERTYSINGLEVALUE('RatedPressureBasis',$,IFCLABEL(${ifcString(`${table.id} class ${label[1]} at ${REFERENCE_TEMPERATURE_C} degC (${answer.method})`)}),$)`,
    `IFCPROPERTYSINGLEVALUE('RatedPressureVerified',$,IFCBOOLEAN(${answer.verified ? '.T.' : '.F.'}),$)`,
  ];
}
