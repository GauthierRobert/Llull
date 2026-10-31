/** Plant 04 PID M4: `parse_instrument_tag` over every case of validation/data/tag_parse_cases.json (VC-PID-08), the letter table against isa51_letters.json, and the tag registry. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { FIRST_LETTERS, SUCCEEDING_LETTERS } from '@aec/plant/pid/tags/isa51Letters';
import { buildTagRegistry } from '@aec/plant/pid/tags/registry';
import { getPid } from '@aec/plant/pid/state';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { PID_PACK } from './dexpiFixtures';
import { feedPumpControlled } from './authoringFixtures';

interface Parsed {
  ok: boolean;
  tag: string;
  convention: string;
  letters: string;
  firstLetter: { letter: string; meaning: string };
  modifier: { letter: string; meaning: string } | null;
  functions: Array<{ letter: string; role: string; meaning: string; grade?: string; unverified?: boolean }>;
  functionModifiers: Array<{ letter: string; meaning: string }>;
  loop: string;
  separator: string;
  suffix: string | null;
  grade: string;
  unverified: boolean;
  warnings: Array<{ code: string; message: string }>;
  code?: string;
}

interface Case {
  id: string;
  input: string;
  expect: {
    ok: boolean;
    firstLetter?: string;
    variable?: string;
    modifier?: string | null;
    modifierMeaning?: string;
    functions?: Array<string | { letter: string; role: string; meaning: string }>;
    functionModifiers?: string[];
    loop?: string;
    code?: string;
    warning?: string;
  };
}

const pack = JSON.parse(readFileSync(path.join(PID_PACK, 'data/tag_parse_cases.json'), 'utf8')) as { cases: Case[] };
const letters = JSON.parse(readFileSync(path.join(PID_PACK, 'data/isa51_letters.json'), 'utf8')) as {
  firstLetter: Array<{ letter: string; measuredVariable: string; modifier: string | null; grade: string }>;
  succeedingLetters: Array<{ letter: string; role: string; meaning: string; grade: string }>;
};

const empty = createEmptyDocument();
const parse = (tag: string): Parsed => {
  const result = execute(empty, 'parse_instrument_tag', { tag });
  expect(result.document).toBe(empty);
  expect(result.affected).toEqual([]);
  return result.data as Parsed;
};

describe('tag_parse_cases.json', () => {
  it('has the 16 cases of the pack', () => {
    expect(pack.cases.map((c) => c.id)).toEqual(Array.from({ length: 16 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  });

  for (const testCase of pack.cases) {
    it(`${testCase.id}: ${testCase.input}`, () => {
      const result = execute(empty, 'parse_instrument_tag', { tag: testCase.input });
      const want = testCase.expect;
      const got = result.data as Parsed;
      expect(got.ok).toBe(want.ok);
      expect(got.convention).toBe('ISA-5.1');
      if (!want.ok) {
        expect(result.rejected).toBe(true);
        expect(result.error?.code).toBe(want.code);
        expect(got.code).toBe(want.code);
        return;
      }
      expect(result.rejected).toBeUndefined();
      if (want.firstLetter !== undefined) expect(got.firstLetter.letter).toBe(want.firstLetter);
      if (want.variable !== undefined) expect(got.firstLetter.meaning).toBe(want.variable);
      if (want.modifier !== undefined) expect(got.modifier?.letter ?? null).toBe(want.modifier);
      if (want.modifierMeaning !== undefined) expect(got.modifier?.meaning).toBe(want.modifierMeaning);
      if (want.loop !== undefined) expect(got.loop).toBe(want.loop);
      if (want.functions !== undefined)
        expect(got.functions.map((f) => f.letter)).toEqual(want.functions.map((f) => (typeof f === 'string' ? f : f.letter)));
      for (const full of (want.functions ?? []).filter((f) => typeof f !== 'string')) expect(got.functions).toContainEqual(full);
      if (want.functionModifiers !== undefined) expect(got.functionModifiers.map((m) => m.letter)).toEqual(want.functionModifiers);
      if (want.warning !== undefined) expect(got.warnings.map((w) => w.code)).toContain(want.warning);
    });
  }
});

describe('the letter table', () => {
  it('equals validation/data/isa51_letters.json row for row', () => {
    expect(FIRST_LETTERS.map((r) => ({ letter: r.letter, measuredVariable: r.meaning, modifier: r.modifier, grade: r.grade }))).toEqual(
      letters.firstLetter.map(({ letter, measuredVariable, modifier, grade }) => ({ letter, measuredVariable, modifier, grade })),
    );
    expect(SUCCEEDING_LETTERS.map((r) => ({ letter: r.letter, role: r.role, meaning: r.meaning, grade: r.grade }))).toEqual(
      letters.succeedingLetters.map(({ letter, role, meaning, grade }) => ({ letter, role, meaning, grade })),
    );
  });
});

describe('grammar details', () => {
  it('reads separators, loop numbers and the suffix of parallel devices', () => {
    expect(parse('FV-101A')).toMatchObject({ ok: true, separator: '-', loop: '101', suffix: 'A', letters: 'FV' });
    expect(parse('FV101A')).toMatchObject({ separator: '', loop: '101', suffix: 'A' });
    expect(parse('PI 4712.01')).toMatchObject({ separator: ' ', loop: '4712.01', suffix: null });
    expect(parse('  fic'.toUpperCase().replace('FIC', 'FIC   032  '))).toMatchObject({ tag: 'FIC 032', loop: '032' });
  });

  it('reads the superscript plus as a plus and then refuses the limit marks as nonstandard letters', () => {
    const bad = parse('PIS⁺Z⁺A 275003');
    expect(bad).toMatchObject({ ok: false, code: 'PID_TAG_NONSTANDARD', tag: 'PIS+Z+A 275003' });
  });

  it('resolves the second letter by the grammar: modifier when the rest parses, switch high / low otherwise', () => {
    const psh = parse('PSH-1');
    expect(psh).toMatchObject({ modifier: null });
    expect(psh.functions.map((f) => f.letter)).toEqual(['S']);
    expect(psh.functionModifiers.map((m) => m.letter)).toEqual(['H']);
    const psv = parse('PSV-101');
    expect(psv.warnings.map((w) => w.code)).toContain('PID_TAG_AMBIGUOUS_LETTERS');
    expect(psv.modifier).toMatchObject({ letter: 'S', meaning: 'Safety' });
    expect(psv.functions.map((f) => f.letter)).toEqual(['V']);
    expect(parse('FQI-3').modifier?.letter).toBe('Q');
    expect(parse('FFIC-3')).toMatchObject({ modifier: { letter: 'F', meaning: 'Ratio (fraction)' } });
    expect(parse('TAL-3').functionModifiers.map((m) => m.letter)).toEqual(['L']);
    expect(parse('LAL-3').functionModifiers.map((m) => m.letter)).toEqual(['L']);
    expect(parse('LL-3').functions.map((f) => f.meaning)).toEqual(['Light']);
  });

  it('accepts a first letter alone, and keeps U as a readout', () => {
    expect(parse('T-101')).toMatchObject({ ok: true, functions: [], firstLetter: { letter: 'T' } });
    expect(parse('US-1').functions).toEqual([expect.objectContaining({ letter: 'S', role: 'output' })]);
    expect(parse('UU-1').functions[0]).toMatchObject({ letter: 'U', role: 'readout' });
  });

  it('flags grade B letters unverified and keeps grade A clean', () => {
    const b = parse('IC-1');
    expect(b).toMatchObject({ grade: 'B', unverified: true });
    expect(parse('KI-1')).toMatchObject({ grade: 'B', unverified: true });
    expect(parse('TKI-1')).toMatchObject({ unverified: true });
    expect(parse('JI-1').unverified).toBe(true);
    expect(parse('FIC-101')).toMatchObject({ grade: 'A', unverified: false });
    expect(parse('PAM-1')).toMatchObject({ unverified: true });
    expect(parse('PAM-1').functionModifiers.map((m) => m.letter)).toEqual(['M']);
  });

  it('warns for every user-choice letter and parses on', () => {
    for (const letter of ['C', 'D', 'G', 'M', 'N', 'O']) {
      const result = parse(`${letter}I-1`);
      expect(result.ok, letter).toBe(true);
      expect(
        result.warnings.map((w) => w.code),
        letter,
      ).toContain('PID_TAG_USER_LETTER');
    }
    expect(parse('FB-1').warnings.map((w) => w.code)).toEqual(['PID_TAG_USER_LETTER']);
    expect(parse('FIC-101').warnings).toEqual([]);
  });

  it('refuses a bad shape with PID_TAG_FORMAT and a letter outside the table with PID_TAG_NONSTANDARD', () => {
    for (const tag of [
      '',
      'FIC',
      '101',
      '-101',
      'fic-101',
      'FIC-',
      'FIC-101-A',
      'FIC-101AB',
      'FIC-1.',
      'F-IC-1',
      'F IC 1 2',
      `F${'I'.repeat(70)}-1`,
    ])
      expect(parse(tag), JSON.stringify(tag)).toMatchObject({ ok: false, code: 'PID_TAG_FORMAT' });
    for (const tag of ['FDD-1', 'QQQ-1', 'HH-1', 'P/I-1', 'F*C-2']) expect(parse(tag), tag).toMatchObject({ ok: false });
    expect(parse('FDD-1')).toMatchObject({ code: 'PID_TAG_NONSTANDARD' });
    expect(parse('LH-1')).toMatchObject({ code: 'PID_TAG_NONSTANDARD' });
    expect(parse('P/I-1')).toMatchObject({ code: 'PID_TAG_NONSTANDARD' });
  });

  it('answers a refusal with the code, its remediation and the path, leaving the document alone', () => {
    const result = expectRefusal(empty, 'parse_instrument_tag', { tag: 'FIC' }, 'PID_TAG_FORMAT', 'tag');
    expect(result.error?.remediation).toBeTruthy();
    expect(result.data).toMatchObject({ ok: false, code: 'PID_TAG_FORMAT' });
    expect(execute(empty, 'parse_instrument_tag', { tag: 'FIC-1', convention: 'ISO' }).rejected).toBe(true);
    expect(data(empty, 'parse_instrument_tag', { tag: 'FIC-1', convention: 'ISA-5.1' })).toMatchObject({ ok: true });
  });

  it('summarises the decoding for an agent', () => {
    const summary = execute(empty, 'parse_instrument_tag', { tag: 'PDIC-205' }).summary;
    expect(summary).toContain('Pressure, vacuum');
    expect(summary).toContain('Differential');
    expect(summary).toContain('Control');
    expect(execute(empty, 'parse_instrument_tag', { tag: 'CIC-12' }).summary).toContain('PID_TAG_USER_LETTER');
    expect(execute(empty, 'parse_instrument_tag', { tag: 'T-1' }).summary).toContain('no function letters');
  });
});

describe('add_pid_instrument uses the parser', () => {
  const sheet = apply(empty, 'create_pid_sheet', { number: 'PID-001' });
  const place = (tag: string): Record<string, unknown> => ({ sheet: 'PID-001', tag, at: [10, 10], location: 'field' });

  it('stores category = first letter, functions = the other letters (modifier included) and the loop number', () => {
    const doc = apply(apply(sheet, 'add_pid_instrument', place('PDIC-205')), 'add_pid_instrument', place('FV 101A'));
    const items = Object.values(getPid(doc).items);
    expect(items.find((i) => i.tag === 'PDIC-205')).toMatchObject({ category: 'P', functions: 'DIC', loopNumber: '205' });
    expect(items.find((i) => i.tag === 'FV 101A')).toMatchObject({ category: 'F', functions: 'V', loopNumber: '101' });
  });

  it('refuses letters outside ISA 5.1 unless the parts are given, and says why', () => {
    const refused = expectRefusal(sheet, 'add_pid_instrument', place('QQQ-1'), 'PID_TAG_FORMAT', 'tag');
    expect(refused.summary).toContain('ISA 5.1');
    expect(
      execute(sheet, 'add_pid_instrument', {
        sheet: 'PID-001',
        parts: { category: 'Q', functions: 'QQ', loop: '1' },
        at: [1, 1],
        location: 'field',
      }).rejected,
    ).toBeUndefined();
    expectRefusal(sheet, 'add_pid_instrument', place('PIS+Z+A 275003'), 'PID_TAG_FORMAT', 'tag');
  });

  it('makes update_pid_item re-split an instrument tag with the same grammar', () => {
    const doc = apply(sheet, 'add_pid_instrument', place('FT-1'));
    const renamed = apply(doc, 'update_pid_item', { item: 'FT-1', set: { tag: 'TAHH-300' } });
    expect(Object.values(getPid(renamed).items).find((i) => i.tag === 'TAHH-300')).toMatchObject({
      category: 'T',
      functions: 'AHH',
      loopNumber: '300',
    });
    expectRefusal(doc, 'update_pid_item', { item: 'FT-1', set: { tag: 'ZZZ-QQ' } }, 'PID_TAG_FORMAT', 'set.tag');
  });
});

describe('tag registry', () => {
  it('maps normalised tags to the items of the unique-tag kinds, in model order, in one pass', () => {
    const doc = feedPumpControlled();
    const pid = getPid(doc);
    const registry = buildTagRegistry(pid);
    expect(registry.get('FIC-101')?.map((i) => i.kind)).toEqual(['instrument']);
    expect(registry.get('T-101')).toHaveLength(1);
    expect(registry.has('100-P-1001-A1')).toBe(false);
    expect([...registry.keys()]).toContain('HV-102');
    const sheetId = pid.sheetOrder[0];
    expect(buildTagRegistry(pid, 'other-sheet').size).toBe(0);
    expect(buildTagRegistry(pid, sheetId).size).toBe(registry.size);
  });
});
