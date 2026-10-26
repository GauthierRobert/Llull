/** Generic hostile inputs derived from a reader's valid sample (see `hostileInput.test.ts`). */
import { asBytes, asText, type HostileInput, type HostileReader } from './types';

export interface HostileCase {
  readonly name: string;
  readonly input: () => HostileInput;
  /** Costly case (large input, extra offsets, 2e5 nesting): PR mode runs it for a sample of readers only, full mode for every reader. */
  readonly heavy: boolean;
}

type RawCase = Omit<HostileCase, 'heavy'>;

/** Cases PR mode keeps for every reader: the cheap structural ones (2 truncation offsets, one nesting depth, the first binary word fill). */
const isHeavy = (name: string, offsets: ReadonlySet<number>): boolean =>
  /2 MB|very long line|many tiny records|200000 levels|one unit short|every word 0x(?!FFFFFFFF)/.test(name) ||
  (name.startsWith('truncated valid sample at ') && !offsets.has(Number(name.slice(26).split('/')[0])));

const NUMERIC_TOKENS = ['1e309', 'NaN', '-0', '1e999999999', '99999999999999999999999999', '-1e309', '0x7fffffff', '1e-400'];
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const LONG = 2_000_000;

const bytesFrom = (parts: readonly (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The sample with every 4-byte aligned word replaced by `word` (little endian), the way hostile binary numerics look. */
const wordFill = (sample: Uint8Array, word: number[]): Uint8Array => {
  const out = sample.slice();
  for (let at = 0; at + 4 <= out.length; at += 4) out.set(word, at);
  return out;
};

const textCases = (sample: string, reader: HostileReader): RawCase[] => {
  const mid = Math.floor(sample.length / 2);
  const cases: RawCase[] = [
    { name: 'NUL byte inside the sample', input: () => sample.slice(0, mid) + '\0' + sample.slice(mid) },
    { name: 'only NUL bytes', input: () => '\0'.repeat(4096) },
    { name: 'lone high surrogate inside the sample', input: () => sample.slice(0, mid) + '\uD800' + sample.slice(mid) },
    { name: 'lone low surrogate at the start and a high surrogate at the end', input: () => '\uDC00' + sample + '\uD800' },
    {
      name: 'invalid UTF-8 decoded to replacement characters',
      input: () => new TextDecoder().decode(Uint8Array.from([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80])) + sample,
    },
    { name: 'CR-only line ends', input: () => sample.replace(/\r?\n/g, '\r') },
    { name: 'CRLF line ends', input: () => sample.replace(/\r?\n/g, '\r\n') },
    { name: 'BOM before the sample', input: () => '﻿' + sample },
  ];
  for (const token of NUMERIC_TOKENS) cases.push({ name: `every number replaced by ${token}`, input: () => sample.replace(NUMBER, token) });
  cases.push({
    name: `one very long line (>= 2 MB) without newline`,
    input: () => {
      let records = 8;
      let text = asText(reader.build(records)).replace(/\r?\n/g, ' ');
      while (text.length < LONG && records < 1 << 22) {
        records *= 4;
        text = asText(reader.build(records)).replace(/\r?\n/g, ' ');
      }
      return text;
    },
  });
  cases.push({ name: 'a 2 MB run of one character', input: () => 'x'.repeat(LONG) });
  cases.push({ name: 'a 2 MB run of digits', input: () => '1'.repeat(LONG) });
  cases.push({ name: 'a 2 MB run of spaces then the sample', input: () => ' '.repeat(LONG) + sample });
  return cases;
};

const byteCases = (sample: Uint8Array): RawCase[] => {
  const mid = Math.floor(sample.length / 2);
  return [
    { name: 'NUL bytes inside the sample', input: () => bytesFrom([sample.slice(0, mid), new Uint8Array(64), sample.slice(mid)]) },
    { name: 'only NUL bytes', input: () => new Uint8Array(4096) },
    {
      name: 'invalid UTF-8 / 0xFF bytes inside the sample',
      input: () => bytesFrom([sample.slice(0, mid), [0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80], sample.slice(mid)]),
    },
    { name: 'every word 0xFFFFFFFF (NaN / -1)', input: () => wordFill(sample, [0xff, 0xff, 0xff, 0xff]) },
    { name: 'every word 0x7FFFFFFF (huge int / NaN)', input: () => wordFill(sample, [0xff, 0xff, 0xff, 0x7f]) },
    { name: 'every word 0x7F800000 (+Inf float)', input: () => wordFill(sample, [0x00, 0x00, 0x80, 0x7f]) },
    { name: 'every word 0x80000000 (-0 / min int)', input: () => wordFill(sample, [0x00, 0x00, 0x00, 0x80]) },
    { name: 'every word 0x7F7FFFFF (max float)', input: () => wordFill(sample, [0xff, 0xff, 0x7f, 0x7f]) },
    { name: 'BOM before the sample', input: () => bytesFrom([[0xef, 0xbb, 0xbf], sample]) },
    { name: 'a 2 MB run of 0xFF', input: () => new Uint8Array(LONG).fill(0xff) },
    { name: 'a 2 MB run of 0x01', input: () => new Uint8Array(LONG).fill(1) },
  ];
};

/** Every generic case for one reader, in a stable order. */
export function hostileCases(reader: HostileReader): HostileCase[] {
  const sample = reader.build(3);
  const length = sample.length;
  const cut = (offset: number): HostileInput => sample.slice(0, offset);
  const cases: RawCase[] = [
    { name: 'empty input', input: () => (reader.input === 'bytes' ? new Uint8Array(0) : '') },
    { name: 'whitespace only', input: () => (reader.input === 'bytes' ? asBytes(' \t\r\n \n') : ' \t\r\n \n') },
    { name: 'BOM only', input: () => (reader.input === 'bytes' ? asBytes('﻿') : '﻿') },
  ];
  for (const fraction of [0.01, 0.1, 0.25, 0.5, 0.75, 0.99]) {
    const offset = Math.max(1, Math.floor(length * fraction));
    cases.push({ name: `truncated valid sample at ${offset}/${length}`, input: () => cut(offset) });
  }
  cases.push({ name: 'truncated valid sample one unit short', input: () => cut(Math.max(0, length - 1)) });
  cases.push(...(typeof sample === 'string' ? textCases(sample, reader) : byteCases(sample)));
  if (typeof sample === 'string' && reader.input === 'bytes')
    cases.push(...byteCases(asBytes(sample)).filter((entry) => !entry.name.includes('BOM')));
  cases.push({ name: 'many tiny records (20000)', input: () => reader.build(20_000) });
  if (reader.nest !== undefined) {
    const nest = reader.nest;
    cases.push({ name: 'nesting 10000 levels deep', input: () => nest(10_000) });
    cases.push({ name: 'nesting 200000 levels deep', input: () => nest(200_000) });
  }
  for (const entry of reader.extra ?? []) cases.push({ name: entry.name, input: entry.input });
  const keep = new Set([0.25, 0.75].map((fraction) => Math.max(1, Math.floor(length * fraction))));
  return cases.map((entry) => ({
    name: entry.name,
    heavy:
      isHeavy(entry.name, keep) ||
      (reader.costly === true && !/^(empty|whitespace|BOM only|truncated)/.test(entry.name)),
    input: () => {
      const value = entry.input();
      return reader.input === 'bytes' ? asBytes(value) : typeof value === 'string' ? value : asText(value);
    },
  }));
}
