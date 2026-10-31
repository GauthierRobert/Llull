/** Instrument tag split of the authoring commands: the ISA 5.1 parser (`tags/parseTag.ts`) reduced to the stored parts. */

import { parseTag } from '../tags/parseTag';

export interface TagParts {
  readonly category: string;
  readonly functions: string;
  readonly loopNumber: string;
  readonly suffix: string;
}

/** `FIC-101`, `PDIT 12.01`, `FV101A`: category = first letter, functions = the other letters, loop number, suffix; undefined unless the tag parses with ISA 5.1 letters. */
export function splitInstrumentTag(tag: string): TagParts | undefined {
  const parsed = parseTag(tag);
  if (!parsed.ok) return undefined;
  return { category: parsed.letters.slice(0, 1), functions: parsed.letters.slice(1), loopNumber: parsed.loop, suffix: parsed.suffix ?? '' };
}

/** Tag of an instrument built from its parts: letters, `-`, loop number. */
export const composeInstrumentTag = (category: string, functions: string, loop: string): string => `${category}${functions}-${loop}`;

/** Why a tag is not an ISA 5.1 instrument tag (the parser's reason), for the refusal of the authoring commands. */
export function tagRefusal(tag: string): string {
  const parsed = parseTag(tag);
  return parsed.ok ? `"${tag}" parses` : `${parsed.message} (ISA 5.1, see parse_instrument_tag)`;
}
