/** Inputs a check or design replaced by a documented default: listed in data.defaulted and named in the summary (INT-14). */

import type { CommandResult } from '@core/commands/types';

export interface DefaultedValue {
  readonly input: string;
  /** The value used, as text. */
  readonly value: string;
}

/** The entries of `used` whose input `given` leaves undefined, in the order of `used`. */
export function defaultedInputs(
  given: Readonly<Record<string, unknown>>,
  used: Readonly<Record<string, number | boolean | string>>,
): DefaultedValue[] {
  return Object.entries(used)
    .filter(([input]) => given[input] === undefined)
    .map(([input, value]) => ({ input, value: String(value) }));
}

/** "windPressure 0.6 (defaulted), snowLoad 0.8 (defaulted)"; empty when nothing was defaulted. */
export const defaultedClause = (defaulted: ReadonlyArray<DefaultedValue>): string =>
  defaulted.map(({ input, value }) => `${input} ${value} (defaulted)`).join(', ');

/** `result` with `defaulted` added to its data and named at the end of its summary (unchanged when the list is empty and no list existed). */
export function withDefaulted(result: CommandResult, defaulted: ReadonlyArray<DefaultedValue>): CommandResult {
  const known = (result.data as { defaulted?: DefaultedValue[] } | undefined)?.defaulted ?? [];
  const all = [...defaulted, ...known.filter((entry) => !defaulted.some((own) => own.input === entry.input))];
  return {
    ...result,
    summary: defaulted.length === 0 ? result.summary : `${result.summary} ${defaultedClause(defaulted)}.`,
    data: { ...(result.data as object | undefined), defaulted: all },
  };
}
