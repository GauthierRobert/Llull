import { describe, expect, it } from 'vitest';
import { restoreStepNames, withAsciiStepNames } from '@lib/stepNames';
import { encodeStepString } from '@lib/step21/encode';

const PLACEHOLDER = 'llull_name_000001';
const { placeholders } = withAsciiStepNames('a = box([1], name="Ø20 Welle")');
const RESTORED = "'\\X2\\00D8\\X0\\20 Welle'";

/** A STEP line whose first string holds the placeholder cut at `cut` by `lineBreak` (what a writer does when a line exceeds 72 characters). */
const wrapped = (cut: number, lineBreak: string): string =>
  `#10 = PRODUCT('${PLACEHOLDER.slice(0, cut)}${lineBreak}${PLACEHOLDER.slice(cut)}','x','',(#7));`;

describe('restoreStepNames with a string literal wrapped over lines', () => {
  it('restores a placeholder cut anywhere by a line break + indentation', () => {
    for (let cut = 1; cut < PLACEHOLDER.length; cut++) {
      expect(restoreStepNames(wrapped(cut, '\n  '), placeholders), `cut ${cut}`).toBe(`#10 = PRODUCT(${RESTORED},'x','',(#7));`);
    }
  });

  it('accepts CRLF and tab indentation', () => {
    expect(restoreStepNames(wrapped(8, '\r\n\t '), placeholders)).toContain(RESTORED);
  });

  it('restores a name longer than one STEP line (> 72 characters) wrapped inside the literal', () => {
    const long = `Ø${'x'.repeat(100)}`;
    const { placeholders: longNames } = withAsciiStepNames(`a = box([1], name="${long}")`);
    const folded = "#1 = PRODUCT('llull_name_\n   000001','llull_name_000001','',(#2));";
    const encoded = encodeStepString(long, 'run');
    expect(restoreStepNames(folded, longNames)).toBe(`#1 = PRODUCT('${encoded}','${encoded}','',(#2));`);
  });

  it('leaves a wrapped literal that holds no placeholder untouched', () => {
    const text = "#1 = X('a\n  b','c',(#2));";
    expect(restoreStepNames(text, placeholders)).toBe(text);
  });
});

describe('encodeStepString: U+007F and control characters (ISO 10303-21 6.4.3: only U+0020..U+007E stand for themselves)', () => {
  it('escapes DEL in every mode', () => {
    for (const mode of ['per-char', 'utf16-run', 'run'] as const) {
      expect(encodeStepString('a\u007Fb', mode), mode).toBe('a\\X2\\007F\\X0\\b');
    }
  });

  it('run mode merges neighbouring escapes into one \\X2\\ run', () => {
    expect(encodeStepString('a\u007FØ', 'run')).toBe('a\\X2\\007F00D8\\X0\\');
  });
});
