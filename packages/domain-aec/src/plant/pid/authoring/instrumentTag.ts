/** Minimal instrument tag split of the authoring commands (M3): letters, separator, loop number, suffix. The ISA 5.1 grammar and letter tables are M4 (`parse_instrument_tag`). */

export interface TagParts {
  readonly category: string;
  readonly functions: string;
  readonly loopNumber: string;
  readonly suffix: string;
}

/** `FIC-101`, `PDIT 12.01`, `FV101A`: 1 to 6 capital letters, optional `-` or space, a loop number (digits, optional `.digits`), an optional suffix letter. */
const INSTRUMENT_TAG = /^([A-Z])([A-Z]{0,5})[- ]?(\d{1,9}(?:\.\d{1,9})?)([A-Z]?)$/;

export function splitInstrumentTag(tag: string): TagParts | undefined {
  const match = INSTRUMENT_TAG.exec(tag.trim().replace(/\s+/g, ' '));
  if (match === null) return undefined;
  const [, category, functions, loopNumber, suffix] = match;
  return { category: category ?? '', functions: functions ?? '', loopNumber: loopNumber ?? '', suffix: suffix ?? '' };
}

/** Tag of an instrument built from its parts: letters, `-`, loop number. */
export const composeInstrumentTag = (category: string, functions: string, loop: string): string => `${category}${functions}-${loop}`;
