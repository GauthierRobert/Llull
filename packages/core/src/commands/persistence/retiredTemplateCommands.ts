/**
 * Retired `instantiate_template`: its three hard-coded 2D generators were the same flow as a `build_project` of `draw_arc` /
 * `draw_rectangle` calls. A saved step becomes that plan; the nested draws mint `circ-` / `rect-` ids in the same order, so replay keeps
 * every id.
 */

import type { RetiredCommandRewrite } from '../types';
import type { Vec2 } from '../../model/types';
import { MAX_TEMPLATE_ENTITIES } from '../limits';
import { isRecord } from '../../lib/isRecord';
import { circlePoints } from '../../geometry/tessellation';

interface Action {
  readonly command: string;
  readonly params: Record<string, unknown>;
}

type Placement = Readonly<Record<string, unknown>>;

const numberOr = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN);

const isCount = (value: number, max: number): boolean => Number.isInteger(value) && value >= 1 && value <= max;

const circle = (center: Vec2, radius: number, placement: Placement): Action => ({
  command: 'draw_arc',
  params: { center, radius, ...placement },
});

function boltCircle(count: number, radius: number, hole: number, placement: Placement): Action[] {
  return circlePoints(0, 0, 0, radius, count).map(([x, y]) => circle([x, y], hole, placement));
}

/** The draws a template produced, in creation order; [] when its params were invalid. */
function templateActions(template: unknown, raw: Record<string, unknown>, placement: Placement): Action[] {
  const p = (key: string): number => numberOr(raw[key]);
  if (template === 'bolt_hole_pattern') {
    if (!isCount(p('count'), MAX_TEMPLATE_ENTITIES)) return [];
    return boltCircle(p('count'), p('boltCircleRadius'), p('holeRadius'), placement);
  }
  if (template === 'flange') {
    if (!isCount(p('boltCount'), MAX_TEMPLATE_ENTITIES - 2) || !(p('boreRadius') < p('outerRadius'))) return [];
    return [
      circle([0, 0], p('outerRadius'), placement),
      circle([0, 0], p('boreRadius'), placement),
      ...boltCircle(p('boltCount'), p('boltCircleRadius'), p('holeRadius'), placement),
    ];
  }
  if (template === 'rectangular_plate_with_holes') {
    const [rows, cols] = [p('holeRows'), p('holeCols')];
    if (!isCount(rows, MAX_TEMPLATE_ENTITIES) || !isCount(cols, MAX_TEMPLATE_ENTITIES - 1)) return [];
    if (rows * cols + 1 > MAX_TEMPLATE_ENTITIES || p('marginX') < 0 || p('marginY') < 0) return [];
    const colStep = cols > 1 ? (p('width') - 2 * p('marginX')) / (cols - 1) : 0;
    const rowStep = rows > 1 ? (p('height') - 2 * p('marginY')) / (rows - 1) : 0;
    const holes = Array.from({ length: rows * cols }, (_, k) =>
      circle([p('marginX') + (k % cols) * colStep, p('marginY') + Math.floor(k / cols) * rowStep], p('holeRadius'), placement),
    );
    const plate = { command: 'draw_rectangle', params: { width: p('width'), height: p('height') } };
    return [{ ...plate, params: { ...plate.params, ...placement } }, ...holes];
  }
  return [];
}

export const RETIRED_TEMPLATE_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  instantiate_template: ({ template, params, position, color }) => ({
    name: 'build_project',
    params: {
      actions: templateActions(template, isRecord(params) ? params : {}, {
        ...(position !== undefined ? { position } : {}),
        ...(color !== undefined ? { color } : {}),
      }),
    },
  }),
};
