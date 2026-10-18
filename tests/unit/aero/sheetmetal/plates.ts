import { createEmptyDocument } from '@core/model/types';
import type { BeadForm } from '@core/model/sheetMetal';
import { beadAreaChange, beadGeometry } from '@aero/sheetmetal/formGeometry';
import { RULE, type BuiltPart, ruleParams } from './helpers';
import { apply, ok } from '../../../helpers/commandAssertions';

/** A bare sheet-metal base of width x height at the origin (side up) under `RULE` overridden by `rule`. */
export function plate(width: number, height: number, rule: Record<string, unknown> = {}): BuiltPart {
  const doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', ruleParams({ ...RULE, ...rule }));
  const drawn = ok(doc, 'draw_rectangle', { width, height, position: [0, 0, 0] });
  const profile = drawn.affected[0] as string;
  const base = ok(drawn.document, 'add_sheet_metal_base', {
    profileId: profile,
    rule: (rule['name'] as string | undefined) ?? RULE.name,
    side: 'up',
  });
  return { doc: base.document, part: base.affected[0] as string, profile };
}

/** Sum of an integrand over [a, b] by the midpoint rule (closed-form cross-checks of revolved volumes). */
export function integrate(f: (x: number) => number, a: number, b: number, steps = 200000): number {
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += f(a + (i + 0.5) * h);
  return sum * h;
}

/** Volume added by a round-ended bead: straight part by the area change, the two caps as ONE solid of revolution, integrated numerically. */
export function beadVolumeChange(form: BeadForm, thickness: number): number {
  const bead = beadGeometry(form, thickness);
  if (bead === null) return NaN;
  const length = Math.hypot(form.end[0] - form.start[0], form.end[1] - form.start[1]);
  const { radius, depth } = form;
  const [outer, centre] = [radius + thickness, depth - radius];
  const top = thickness - centre;
  const crown = (y: number): number => centre + Math.sqrt(Math.max(0, outer ** 2 - y ** 2));
  const ray = (y: number): number => centre + (y * top) / bead.halfWidth;
  const innerReach = (radius * bead.halfWidth) / outer;
  const archThickness = (y: number): number =>
    crown(y) - (y <= innerReach ? centre + Math.sqrt(Math.max(0, radius ** 2 - y ** 2)) : ray(y));
  const troughHeight = (y: number): number => (y <= bead.bottomHalfWidth ? thickness : thickness - ray(y));
  const caps = integrate((y) => 2 * Math.PI * y * (archThickness(y) - troughHeight(y)), 0, bead.halfWidth);
  return length * beadAreaChange(form, thickness) + (form.endShape === 'round' ? caps : 0);
}
