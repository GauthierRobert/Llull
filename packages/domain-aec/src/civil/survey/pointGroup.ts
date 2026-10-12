/**
 * New survey point group shared by every survey import command.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel, PointGroupObject, SurveyPoint } from '@core/model/civil';
import { civilObjectsOf, getCivil, nextCivilId } from '../model';

/** Point group with the next free id; name defaults to `<defaultLabel> <n>`. */
export function newPointGroup(
  doc: CadDocument,
  requestedName: string | undefined,
  defaultLabel: string,
  points: ReadonlyArray<SurveyPoint>,
): { civil: CivilModel; id: string; group: PointGroupObject } {
  const civil = getCivil(doc);
  const id = nextCivilId(civil, 'pointGroup');
  const group: PointGroupObject = {
    id,
    category: 'pointGroup',
    name:
      requestedName?.trim() || `${defaultLabel} ${civilObjectsOf(civil, 'pointGroup').length + 1}`,
    entityIds: [],
    points: [...points],
  };
  return { civil, id, group };
}
