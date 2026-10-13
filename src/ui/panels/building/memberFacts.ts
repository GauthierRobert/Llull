/** @layer ui/panels/building Pure fact rows (label, value) of a steel member for the inspector. */

import type { SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fixedNumber } from '@lib/compactNumber';
import { toMetres, toMm } from '@core/model/units';
import { findProfile } from '@aec/steel/profiles';

const formatPoint = (point: ReadonlyArray<number>): string =>
  point.map((value) => fixedNumber(value, 1)).join(', ');

export function memberFacts(
  member: SteelMemberElement,
  document: Pick<CadDocument, 'units'>,
): ReadonlyArray<readonly [string, string]> {
  const lengthUnits = Math.hypot(
    member.end[0] - member.start[0],
    member.end[1] - member.start[1],
    member.end[2] - member.start[2],
  );
  const massPerMetre = findProfile(member.profile)?.massPerMetre;
  const mass =
    massPerMetre === undefined
      ? '—'
      : `${Math.round(toMetres(document, lengthUnits) * massPerMetre)} kg`;
  return [
    ['Role', member.role],
    ['Profile', member.profile],
    ['Grade', member.material],
    ['Start', formatPoint(member.start)],
    ['End', formatPoint(member.end)],
    ['Length', `${Math.round(toMm(document, lengthUnits))} mm`],
    ['Mass', mass],
  ];
}
