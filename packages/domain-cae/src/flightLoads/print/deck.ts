/** 14 FLL-M3 deck cards of a printed part: orthotropic `*ELASTIC, TYPE=ENGINEERING CONSTANTS` + `*DENSITY` and the `*ORIENTATION` of the build direction. */

import type { PrintIdealization } from '@core/model/printIdealization';
import type { Vec3 } from '@core/model/vectors';
import { safeName, type DeckContext, type DeckSections } from '../../decks/context';
import { commentText, linesText, row } from '../../decks/format';
import { densityToAnalysis, stressPerMpa } from '../../decks/units';
import { isPrintedRefusal, printedProperties } from './properties';

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Material axes of a print: direction 3 = the build direction, direction 1 = the document axis least aligned with it (projected orthogonal to it), direction 2 = 3 x 1.
 * @invariant axis1 x axis2 = the unit build direction
 */
export function printAxes(layerAxis: Vec3): { readonly axis1: Vec3; readonly axis2: Vec3 } {
  const axis = unit(layerAxis);
  const [ax, ay, az] = [Math.abs(axis[0]), Math.abs(axis[1]), Math.abs(axis[2])];
  const e: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const along = e[0] * axis[0] + e[1] * axis[1] + e[2] * axis[2];
  const axis1 = unit([e[0] - along * axis[0], e[1] - along * axis[1], e[2] - along * axis[2]]);
  return { axis1, axis2: cross(axis, axis1) };
}

const printOf = (ctx: DeckContext, entityId: string): PrintIdealization | undefined =>
  Object.hasOwn(ctx.analysis.printed ?? {}, entityId) ? ctx.analysis.printed?.[entityId] : undefined;

/** `*MATERIAL` body (no `*MATERIAL` line) of a printed part, or null when the part is not printed in this case. */
export function printedMaterialLines(ctx: DeckContext, entityId: string): DeckSections | null {
  const print = printOf(ctx, entityId);
  if (print === undefined) return null;
  const solved = printedProperties(ctx.doc, entityId, print);
  if (isPrintedRefusal(solved)) return { ...solved, ids: [entityId] };
  const material = ctx.materialOf(entityId);
  const { part } = solved;
  const factor = stressPerMpa(ctx.unitSystem);
  const density = (material === null ? 0 : densityToAnalysis(material.density, ctx.doc.units, ctx.unitSystem)) * part.densityRatio;
  return {
    text: linesText([
      `** printed part '${commentText(entityId, 60)}': pattern ${print.infill.pattern}, infill ${print.infill.density}, exponent ${print.exponent.value} (${print.exponent.basis}), skin fraction ${solved.skin.fraction.toPrecision(6)}`,
      `** UNVERIFIED: ${commentText(solved.unverifiedReasons.slice(0, 2).join('; '), 400)}`,
      '*ELASTIC, TYPE=ENGINEERING CONSTANTS',
      row(part.E1 * factor, part.E2 * factor, part.E3 * factor, part.nu12, part.nu13, part.nu23, part.G12 * factor, part.G13 * factor),
      row(part.G23 * factor),
      '*DENSITY',
      row(density),
    ]),
  };
}

/** `*ORIENTATION` block of a printed part (build direction = material direction 3), or null when the part is not printed. */
export function printedOrientation(ctx: DeckContext, entityId: string): { readonly name: string; readonly text: string } | null {
  const print = printOf(ctx, entityId);
  if (print === undefined) return null;
  const { axis1, axis2 } = printAxes(print.layerAxis);
  const name = `OR_PRT_${safeName(entityId)}`;
  return { name, text: `*ORIENTATION, NAME=${name}, SYSTEM=RECTANGULAR\n${row(...axis1, ...axis2)}\n` };
}
