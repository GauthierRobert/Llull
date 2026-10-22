/** Plain-object laws (a command param or a saved document) in the model's `ScalarLaw` shape. */

import type { ScalarLaw } from './types';

export type LawInput = { type: ScalarLaw['type'] } & Partial<
  Record<'value' | 'start' | 'end' | 'startSlope' | 'endSlope' | 'expression', unknown>
> & { points?: unknown };

/** The law in the model's shape, or why the input is incomplete. */
export function parseLaw(input: LawInput): ScalarLaw | string {
  const num = (v: unknown): v is number => typeof v === 'number';
  switch (input.type) {
    case 'constant':
      return num(input.value) ? { type: 'constant', value: input.value } : 'constant needs value';
    case 'linear':
    case 's_curve':
      return num(input.start) && num(input.end)
        ? { type: input.type, start: input.start, end: input.end }
        : `${input.type} needs start and end`;
    case 'expression':
      return typeof input.expression === 'string' ? { type: 'expression', expression: input.expression } : 'expression needs expression';
    case 'table':
      return Array.isArray(input.points)
        ? {
            type: 'table',
            points: input.points as ReadonlyArray<readonly [number, number]>,
            ...(num(input.startSlope) ? { startSlope: input.startSlope } : {}),
            ...(num(input.endSlope) ? { endSlope: input.endSlope } : {}),
          }
        : 'table needs points';
    default:
      return `unknown law type "${String((input as { type: unknown }).type)}"`;
  }
}
