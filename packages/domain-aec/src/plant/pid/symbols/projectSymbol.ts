/**
 * Project symbols of the P&ID (plant 04 PID-FU-4, `define_pid_symbol`): a project's own graphics for a library class. Definitions are UNTRUSTED (an
 * agent's parameters, a loaded file): `shapeProblems` checks every number, count, size and string before a shape is stored or drawn; `normalise` fits the
 * graphics into the box of the built-in class, so the nozzle ports of equipment and the ports of inline components stay where authoring put them.
 */

import { isRecord } from '@lib/isRecord';
import type { Vec2 } from '@core/model/vectors';
import { halfExtents } from '../authoring/classes';
import { KNOWN_EQUIPMENT_CLASSES, KNOWN_PIPING_CLASSES } from '../dexpi/proteusClasses';
import type { PidConvention, PidModel } from '../model';
import { INLINE_HALF, INLINE_HALF_HEIGHT } from './piping';
import type { PidSymbol, Shape, ShapeStyle } from './shapes';

/** Limits of an untrusted definition (sheet millimetres, symbol frame). */
export const SYMBOL_LIMITS = { shapes: 64, points: 200, text: 24, coordinate: 1000, textHeight: 100, name: 64 } as const;

const STYLES: readonly string[] = ['visible', 'thin', 'hidden'];
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown): value is Vec2 =>
  Array.isArray(value) &&
  value.length === 2 &&
  isNumber(value[0]) &&
  isNumber(value[1]) &&
  Math.abs(value[0]) <= SYMBOL_LIMITS.coordinate &&
  Math.abs(value[1]) <= SYMBOL_LIMITS.coordinate;

/** Families whose graphics a project may replace, and the class set that names them. */
export const symbolFamilyOf = (cls: string): 'equipment' | 'piping' | null =>
  KNOWN_EQUIPMENT_CLASSES.has(cls) ? 'equipment' : KNOWN_PIPING_CLASSES.has(cls) ? 'piping' : null;

/** Half extents the graphics of `cls` are fitted into. */
export const targetBox = (cls: string): readonly [number, number] =>
  symbolFamilyOf(cls) === 'piping' ? [INLINE_HALF, INLINE_HALF_HEIGHT] : halfExtents(cls);

/** Why one raw shape is not acceptable (null when it is); the vocabulary is `Shape` of `shapes.ts`. */
function shapeProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return 'must be an object';
  const style = raw['style'];
  if (style !== undefined && !(typeof style === 'string' && STYLES.includes(style))) return `style must be ${STYLES.join(', ')}`;
  for (const flag of ['closed', 'fill']) if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return `${flag} must be a boolean`;
  switch (raw['t']) {
    case 'line': {
      const points = raw['pts'];
      if (!Array.isArray(points) || points.length < 2) return 'a line needs pts: at least 2 points [x, y]';
      if (points.length > SYMBOL_LIMITS.points) return `a line has at most ${SYMBOL_LIMITS.points} points`;
      return points.every(isPoint) ? null : `every point must be [x, y] of finite numbers within +/-${SYMBOL_LIMITS.coordinate} mm`;
    }
    case 'circle':
      if (!isPoint(raw['c'])) return 'a circle needs c: [x, y] of finite numbers within the limit';
      return isNumber(raw['r']) && raw['r'] > 0 && raw['r'] <= SYMBOL_LIMITS.coordinate ? null : 'a circle needs r > 0 within the limit';
    case 'text': {
      if (!isPoint(raw['at'])) return 'a text needs at: [x, y]';
      if (!(isNumber(raw['h']) && raw['h'] > 0 && raw['h'] <= SYMBOL_LIMITS.textHeight))
        return `a text needs a height h in (0, ${SYMBOL_LIMITS.textHeight}] mm`;
      const content = raw['s'];
      if (typeof content !== 'string' || content === '' || content.length > SYMBOL_LIMITS.text)
        return `a text needs s: 1 to ${SYMBOL_LIMITS.text} characters`;
      // eslint-disable-next-line no-control-regex
      return /[\u0000-\u001f\u007f<>&"']/.test(content) ? 'text must not contain control characters or < > & " \'' : null;
    }
    default:
      return 't must be line, circle or text';
  }
}

/** Every problem of a list of raw shapes, each with its path (`<prefix>[i]`); empty when the definition can be stored. */
export function shapeProblems(raw: unknown, prefix: string): string[] {
  if (!Array.isArray(raw)) return [`${prefix} must be an array of shapes`];
  if (raw.length === 0) return [`${prefix} must not be empty`];
  if (raw.length > SYMBOL_LIMITS.shapes) return [`${prefix} has ${raw.length} shapes; the limit is ${SYMBOL_LIMITS.shapes}`];
  return raw.flatMap((shape, index) => {
    const problem = shapeProblem(shape);
    return problem === null ? [] : [`${prefix}[${index}]: ${problem}`];
  });
}

/** The shape with only the fields of the vocabulary (an untrusted object may carry others). */
function cleaned(raw: Record<string, unknown>): Shape {
  const style = raw['style'] as ShapeStyle | undefined;
  const common = style === undefined ? {} : { style };
  if (raw['t'] === 'circle')
    return { t: 'circle', c: raw['c'] as Vec2, r: raw['r'] as number, ...(raw['fill'] === true ? { fill: true as const } : {}), ...common };
  if (raw['t'] === 'text') return { t: 'text', at: raw['at'] as Vec2, h: raw['h'] as number, s: raw['s'] as string };
  return {
    t: 'line',
    pts: (raw['pts'] as Vec2[]).map((p): Vec2 => [p[0], p[1]]),
    ...(raw['closed'] === true ? { closed: true as const } : {}),
    ...(raw['fill'] === true ? { fill: true as const } : {}),
    ...common,
  };
}

/** Bounding box of the geometry of valid shapes (text counts as its anchor). */
function extent(shapes: readonly Shape[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const shape of shapes) {
    if (shape.t === 'line') for (const p of shape.pts) take(p[0], p[1]);
    else if (shape.t === 'circle') {
      take(shape.c[0] - shape.r, shape.c[1] - shape.r);
      take(shape.c[0] + shape.r, shape.c[1] + shape.r);
    } else take(shape.at[0], shape.at[1]);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * The shapes of a VALID raw definition centred on the middle of their bounding box and scaled uniformly to fit the half extents `target`.
 * @failure zero extent (a point, or a line of no length) -> the reason string
 */
export function normalise(raw: readonly Record<string, unknown>[], target: readonly [number, number]): Shape[] | string {
  const shapes = raw.map(cleaned);
  const { min, max } = extent(shapes);
  const halfW = (max[0] - min[0]) / 2;
  const halfH = (max[1] - min[1]) / 2;
  if (!(halfW > 1e-9 || halfH > 1e-9)) return 'the graphics have no extent (a point or a degenerate line)';
  const scale = Math.min(halfW > 1e-9 ? target[0] / halfW : Infinity, halfH > 1e-9 ? target[1] / halfH : Infinity);
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const move = (p: Vec2): Vec2 => [(p[0] - cx) * scale, (p[1] - cy) * scale];
  return shapes.map((shape): Shape => {
    if (shape.t === 'line') return { ...shape, pts: shape.pts.map(move) };
    if (shape.t === 'circle') return { ...shape, c: move(shape.c), r: shape.r * scale };
    return { ...shape, at: move(shape.at), h: shape.h * scale };
  });
}

/** Whether stored shapes lie inside `target` (a loaded file's definition must already be fitted). */
export function fitsBox(shapes: readonly Shape[], target: readonly [number, number]): boolean {
  const { min, max } = extent(shapes);
  return [min[0], max[0]].every((x) => Math.abs(x) <= target[0] + 1e-6) && [min[1], max[1]].every((y) => Math.abs(y) <= target[1] + 1e-6);
}

/** `symbol` with the project graphics of its class when the project defines them for `convention`, else `symbol` itself. */
export function withProjectSymbol(pid: PidModel, symbol: PidSymbol, convention: PidConvention): PidSymbol {
  const project = pid.symbols === undefined || !Object.hasOwn(pid.symbols, symbol.class) ? undefined : pid.symbols[symbol.class];
  if (project === undefined || !project.conventions.includes(convention)) return symbol;
  return { ...symbol, name: project.name, shapes: project.shapes };
}
