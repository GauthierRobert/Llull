/**
 * Unit literals in expressions. Lengths (`6mm`, `3.2m`, `2in`) convert to the document unit anywhere; angles (`45deg`, `0.5rad`) only in
 * params whose angle unit is known (`ANGLE_PARAMS`), because the registry mixes radians and degrees and the schema does not say which.
 * Bare numbers are already in the document unit.
 */

import { MM_PER_UNIT } from '@core/model/units';
import type { CadDocument } from '@core/model/types';
import { DesignError } from './errors';

type AngleUnit = 'deg' | 'rad';

/** `<command>.<param path>` -> the angle unit that param takes (contract-tested: every entry names a real param). */
export const ANGLE_PARAMS: Readonly<Record<string, AngleUnit>> = {
  'add_box.rotation': 'rad',
  'add_cylinder.rotation': 'rad',
  'add_sphere.rotation': 'rad',
  'add_cone.rotation': 'rad',
  'add_torus.rotation': 'rad',
  'add_wedge.rotation': 'rad',
  'add_pyramid.rotation': 'rad',
  'rotate_entity.delta': 'rad',
  'revolve_profile.angle': 'rad',
  'revolve_profile.rotation': 'rad',
  'array_polar.angle': 'rad',
  'draw_arc.startAngle': 'rad',
  'draw_arc.endAngle': 'rad',
  'add_hole.hole.cskAngle': 'deg',
  'add_hole.extent.drillPointAngle': 'deg',
};

const LENGTH = /(?<![\w.])(\d+(?:\.\d+)?(?:e-?\d+)?)(mm|cm|m|in|ft)\b/g;
const ANGLE = /(?<![\w.])(\d+(?:\.\d+)?(?:e-?\d+)?)(deg|rad)\b/g;

const RADIANS_PER: Readonly<Record<AngleUnit, number>> = { deg: Math.PI / 180, rad: 1 };

const format = (value: number): string => String(Number(value.toPrecision(15)));

/**
 * `expression` with unit literals replaced by plain numbers in document / param units.
 * @failure an angle literal in a param without a known angle unit -> DESIGN_UNIT_NOT_SUPPORTED
 */
export function convertUnits(expression: string, doc: Pick<CadDocument, 'units'>, paramKey: string | null, line: number): string {
  const lengths = expression.replace(LENGTH, (_, n: string, unit: keyof typeof MM_PER_UNIT) =>
    format((Number(n) * MM_PER_UNIT[unit]) / MM_PER_UNIT[doc.units]),
  );
  return lengths.replace(ANGLE, (_, n: string, unit: AngleUnit) => {
    const target = paramKey === null ? undefined : ANGLE_PARAMS[paramKey];
    if (target === undefined)
      throw new DesignError(
        'DESIGN_UNIT_NOT_SUPPORTED',
        line,
        `angle unit "${unit}" is not supported for ${paramKey ?? 'this value'}`,
        'Write the number in the unit the command description states.',
      );
    return format((Number(n) * RADIANS_PER[unit]) / RADIANS_PER[target]);
  });
}

/** A length tolerance / expected value unit factor to document units, or null for an unknown unit. */
export function lengthFactor(unit: string, doc: Pick<CadDocument, 'units'>): number | null {
  const mm = (MM_PER_UNIT as Readonly<Record<string, number>>)[unit];
  return mm === undefined ? null : mm / MM_PER_UNIT[doc.units];
}
