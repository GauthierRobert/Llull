/** Forming notes of the flat pattern: formed features that are not developed (beads) or only approximately (flanged holes). */

import type { Vec2 } from '@core/model/types';
import { toDegrees } from '@lib/angle';
import { fmt } from '@lib/dxfWriter';
import type { UnfoldedForm } from './unfold';

/**
 * One-line forming note of a formed feature, in the unit of `factor` (output length per document length unit); positions go through `place`.
 * @invariant a bead is stated as EXCLUDED from the flat pattern; a flanged-hole cut diameter is stated APPROXIMATE
 */
export function formingNote(form: UnfoldedForm, place: (point: Vec2) => Vec2, factor: number): string {
  const at = (point: Vec2): string => `${fmt(place(point)[0])},${fmt(place(point)[1])}`;
  if (form.kind === 'bead')
    return `FORMING bead ${form.id} ${at(form.start)} to ${at(form.end)} R${fmt(form.radius * factor)} DEPTH${fmt(form.depth * factor)} ${form.direction.toUpperCase()} ${form.endShape.toUpperCase()} ENDS - NOT IN FLAT PATTERN, BLANK NOT ADJUSTED FOR DRAW`;
  return `FORMING flanged hole ${form.id} at ${at(form.center)} FLAT CUT DIA ${fmt(2 * form.developedRadius * factor)} APPROXIMATE (UNVERIFIED) TANGENT DIA ${fmt(2 * form.physicalRadius * factor)} LIP ${fmt(form.flangeHeight * factor)} AT ${fmt(toDegrees(form.angle))} DEG ${form.direction.toUpperCase()}`;
}
