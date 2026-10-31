/**
 * ISA 5.1 instrument tag grammar (plant 04 PID, TECHNICAL_SPEC §5.1): `letters sep loop suffix?`. Linear: one scan of at most 64 characters, no regular expression,
 * two candidate letter parses (with and without a first-letter modifier) of a tag of at most 63 letters.
 */

import {
  FIRST_LETTERS,
  SUCCEEDING_LETTERS,
  type FirstLetterRow,
  type LetterGrade,
  type LetterRole,
  type SucceedingLetterRow,
} from './isa51Letters';

export const MAX_INSTRUMENT_TAG_LENGTH = 64;

/** Symbols that may appear in non-ISA limit marks (`PIS+Z+A`): shape-valid, letters not in the table (PID_TAG_NONSTANDARD). */
const LIMIT_MARK_SYMBOLS = '+*/&';

export interface TagWarning {
  readonly code: string;
  readonly message: string;
}

export interface ParsedFunction {
  readonly letter: string;
  readonly role: LetterRole;
  readonly meaning: string;
  readonly grade?: 'B';
  readonly unverified?: true;
}

export interface ParsedModifier {
  readonly letter: string;
  readonly meaning: string;
  readonly grade?: 'B';
  readonly unverified?: true;
}

export interface TagParse {
  readonly ok: true;
  /** Normalised tag. */
  readonly tag: string;
  readonly convention: 'ISA-5.1';
  /** All identification letters, first letter included (`PDIC`). */
  readonly letters: string;
  readonly firstLetter: { readonly letter: string; readonly meaning: string };
  readonly modifier: ParsedModifier | null;
  readonly functions: readonly ParsedFunction[];
  readonly functionModifiers: readonly ParsedModifier[];
  readonly loop: string;
  readonly separator: '-' | ' ' | '';
  readonly suffix: string | null;
  readonly grade: LetterGrade;
  readonly unverified: boolean;
  readonly warnings: readonly TagWarning[];
}

export interface TagParseFailure {
  readonly ok: false;
  readonly tag: string;
  readonly convention: 'ISA-5.1';
  readonly code: 'PID_TAG_FORMAT' | 'PID_TAG_NONSTANDARD';
  readonly message: string;
  readonly warnings: readonly TagWarning[];
}

export const normaliseTagText = (tag: string): string => tag.replaceAll('⁺', '+').trim().replace(/\s+/g, ' ');

const FIRST_BY_LETTER: ReadonlyMap<string, FirstLetterRow> = new Map(FIRST_LETTERS.map((row) => [row.letter, row]));
const MODIFIER_LETTERS: ReadonlySet<string> = new Set(FIRST_LETTERS.flatMap((row) => (row.modifier === null ? [] : [row.letter])));
/** The row of a succeeding letter that is a readout / output (the first listed: `U` is readout, `L` is Light). */
const FUNCTION_BY_LETTER: ReadonlyMap<string, SucceedingLetterRow> = new Map(
  SUCCEEDING_LETTERS.filter((row) => row.role !== 'modifier')
    .reverse()
    .map((row) => [row.letter, row]),
);
const MODIFIER_BY_LETTER: ReadonlyMap<string, SucceedingLetterRow> = new Map(
  SUCCEEDING_LETTERS.filter((row) => row.role === 'modifier').map((row) => [row.letter, row]),
);

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isCapital = (ch: string | undefined): boolean => ch !== undefined && ch >= 'A' && ch <= 'Z';

interface Shape {
  readonly letters: string;
  readonly separator: '-' | ' ' | '';
  readonly loop: string;
  readonly suffix: string | null;
}

/** `letters sep loop suffix?` or a reason it is not. */
function shapeOf(tag: string): Shape | string {
  let digit = 0;
  while (digit < tag.length && !isDigit(tag[digit])) digit++;
  if (digit === tag.length) return 'there is no loop number (digits after the letters, e.g. FIC-101)';
  let letters = tag.slice(0, digit);
  let separator: Shape['separator'] = '';
  const last = letters[letters.length - 1];
  if (last === '-' || last === ' ') {
    separator = last;
    letters = letters.slice(0, -1);
  }
  if (letters === '') return 'there are no identification letters before the loop number';
  let end = digit;
  while (isDigit(tag[end])) end++;
  if (tag[end] === '.' && isDigit(tag[end + 1])) {
    end++;
    while (isDigit(tag[end])) end++;
  }
  const loop = tag.slice(digit, end);
  const rest = tag.slice(end);
  if (rest.length > 1 || (rest.length === 1 && !isCapital(rest)))
    return `"${rest}" follows the loop number: only one capital suffix letter (FV-101A) may`;
  if (!isCapital(letters[0])) return 'the tag starts with a capital letter (the measured variable)';
  for (const ch of letters) if (!isCapital(ch) && !LIMIT_MARK_SYMBOLS.includes(ch)) return `"${ch}" is not a capital letter`;
  return { letters, separator, loop, suffix: rest === '' ? null : rest };
}

interface LetterParse {
  readonly modifier: ParsedModifier | null;
  readonly modifierGrade: LetterGrade;
  readonly functions: ParsedFunction[];
  readonly functionModifiers: ParsedModifier[];
  readonly bad?: string;
}

/** Succeeding letters: readouts / outputs, and H L M as modifiers after an alarm (A), a switch (S) or another modifier. */
function succeedingOf(letters: string): LetterParse {
  const functions: ParsedFunction[] = [];
  const functionModifiers: ParsedModifier[] = [];
  let previous: string | undefined;
  let previousIsModifier = false;
  for (const ch of letters) {
    const modifiable = previousIsModifier || previous === 'A' || previous === 'S';
    const modifier = MODIFIER_BY_LETTER.get(ch);
    if (modifier !== undefined && modifiable) {
      functionModifiers.push({
        letter: ch,
        meaning: modifier.meaning,
        ...(modifier.grade === 'B' ? { grade: 'B' as const, unverified: true as const } : {}),
      });
      previousIsModifier = true;
      continue;
    }
    const row = FUNCTION_BY_LETTER.get(ch);
    if (row === undefined) return { modifier: null, modifierGrade: 'A', functions, functionModifiers, bad: ch };
    functions.push({
      letter: ch,
      role: row.role,
      meaning: row.meaning,
      ...(row.grade === 'B' ? { grade: 'B' as const, unverified: true as const } : {}),
    });
    previous = ch;
    previousIsModifier = false;
  }
  return { modifier: null, modifierGrade: 'A', functions, functionModifiers };
}

/** Both candidate readings of the letters after the first: as succeeding letters only, and with the second letter a first-letter modifier. */
function letterParse(letters: string): { parse: LetterParse; alternative: boolean } | { bad: string } {
  const after = letters.slice(1);
  const plain = succeedingOf(after);
  const second = after[0];
  const row = second === undefined ? undefined : FIRST_BY_LETTER.get(second);
  const withModifier =
    second !== undefined && MODIFIER_LETTERS.has(second) && after.length > 1 && row?.modifier != null
      ? succeedingOf(after.slice(1))
      : undefined;
  const plainOk = plain.bad === undefined;
  const modifierOk = withModifier !== undefined && withModifier.bad === undefined;
  const asModifier: LetterParse | undefined =
    modifierOk && row?.modifier != null
      ? { ...withModifier, modifier: { letter: second ?? '', meaning: row.modifier }, modifierGrade: row.grade }
      : undefined;
  // A switch followed by H / L / M is the high / low switch (PSH, TSL): the plain reading wins over "second letter is a modifier".
  if (plainOk && asModifier !== undefined) return { parse: plain.functionModifiers.length > 0 ? plain : asModifier, alternative: true };
  if (plainOk) return { parse: plain, alternative: false };
  if (asModifier !== undefined) return { parse: asModifier, alternative: false };
  return { bad: withModifier?.bad ?? plain.bad ?? '?' };
}

const failure = (tag: string, code: TagParseFailure['code'], message: string, warnings: readonly TagWarning[] = []): TagParseFailure => ({
  ok: false,
  tag,
  convention: 'ISA-5.1',
  code,
  message,
  warnings,
});

/**
 * Parses an instrument tag with the ISA 5.1 letter table. `ok: false` carries PID_TAG_FORMAT (the shape fails) or PID_TAG_NONSTANDARD (letters or
 * symbols outside the table, `PIS+Z+A 275003`); user's-choice letters parse with the info warning PID_TAG_USER_LETTER; grade B letters are flagged `unverified`.
 */
export function parseTag(raw: string): TagParse | TagParseFailure {
  const tag = normaliseTagText(raw);
  if (tag === '' || tag.length > MAX_INSTRUMENT_TAG_LENGTH)
    return failure(tag, 'PID_TAG_FORMAT', `a tag has 1 to ${MAX_INSTRUMENT_TAG_LENGTH} characters, got ${tag.length}`);
  const shape = shapeOf(tag);
  if (typeof shape === 'string') return failure(tag, 'PID_TAG_FORMAT', `"${tag}" does not fit letters + loop number: ${shape}`);
  const nonstandard = [...shape.letters].find((ch) => !isCapital(ch));
  if (nonstandard !== undefined)
    return failure(
      tag,
      'PID_TAG_NONSTANDARD',
      `"${nonstandard}" in "${shape.letters}" is not an ISA 5.1 letter (limit marks such as PIS+Z+A are not part of the table)`,
    );
  const first = FIRST_BY_LETTER.get(shape.letters[0] ?? '');
  if (first === undefined) return failure(tag, 'PID_TAG_NONSTANDARD', `"${shape.letters[0] ?? ''}" is not an ISA 5.1 first letter`);
  const letters = letterParse(shape.letters);
  if ('bad' in letters)
    return failure(
      tag,
      'PID_TAG_NONSTANDARD',
      `"${letters.bad}" in "${shape.letters}" is not an ISA 5.1 succeeding letter at this position`,
    );
  const warnings: TagWarning[] = [];
  const userLetters = [first.letter, ...letters.parse.functions.map((f) => f.letter)].filter((letter, index) => {
    const meaning = index === 0 ? first.meaning : letters.parse.functions[index - 1]?.meaning;
    return meaning?.startsWith("User's") === true && letter !== '';
  });
  for (const letter of userLetters)
    warnings.push({
      code: 'PID_TAG_USER_LETTER',
      message: `"${letter}" is a user's-choice letter: define its meaning in the project legend`,
    });
  if (letters.alternative)
    warnings.push({
      code: 'PID_TAG_AMBIGUOUS_LETTERS',
      message: `"${shape.letters}" reads two ways (second letter a first-letter modifier, or a succeeding letter); the reading shown follows the grammar rules`,
    });
  const grades = [
    first.grade,
    letters.parse.modifier === null ? 'A' : letters.parse.modifierGrade,
    ...letters.parse.functions.map((f) => f.grade ?? 'A'),
    ...letters.parse.functionModifiers.map((m) => m.grade ?? 'A'),
  ];
  const grade: LetterGrade = grades.includes('B') ? 'B' : 'A';
  return {
    ok: true,
    tag,
    convention: 'ISA-5.1',
    letters: shape.letters,
    firstLetter: { letter: first.letter, meaning: first.meaning },
    modifier: letters.parse.modifier,
    functions: letters.parse.functions,
    functionModifiers: letters.parse.functionModifiers,
    loop: shape.loop,
    separator: shape.separator,
    suffix: shape.suffix,
    grade,
    unverified: grade === 'B',
    warnings,
  };
}
