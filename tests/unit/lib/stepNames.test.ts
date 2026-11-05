import { describe, expect, it } from 'vitest';
import { restoreStepNames, step21String, withAsciiStepNames } from '@lib/stepNames';

describe('step21String (ISO 10303-21 string encoding)', () => {
  it('keeps printable ASCII as is', () => {
    expect(step21String('Welle 20 mm (A-1)')).toBe('Welle 20 mm (A-1)');
  });
  it('encodes Latin-1 letters as \\X2\\ UTF-16 hex runs', () => {
    expect(step21String('Ø20 Welle')).toBe('\\X2\\00D8\\X0\\20 Welle');
    expect(step21String('café')).toBe('caf\\X2\\00E9\\X0\\');
  });
  it('encodes a run of CJK characters as one \\X2\\ run', () => {
    expect(step21String('轴 A')).toBe('\\X2\\8F74\\X0\\ A');
    expect(step21String('部品軸')).toBe('\\X2\\90E854C18EF8\\X0\\');
  });
  it('encodes an astral code point as \\X4\\ (eight hex digits), never as two \\X2\\ surrogate units', () => {
    expect(step21String('a😀b')).toBe('a\\X4\\0001F600\\X0\\b');
    expect(step21String('é😀')).toBe('\\X2\\00E9\\X0\\\\X4\\0001F600\\X0\\');
  });
  it('doubles apostrophes and reverse solidi, and escapes control characters', () => {
    expect(step21String("O'Brien \\ 5")).toBe("O''Brien \\\\ 5");
    expect(step21String('a\nb')).toBe('a\\X2\\000A\\X0\\b');
  });
});

describe('withAsciiStepNames', () => {
  const source = [
    'a = box([1, 1, 1], color="#c8553d", name="Ø20 Welle")',
    'b = box([1, 1, 1], color="#c8553d", name="plain")',
    'label(a, "Ø20 Welle")',
    'c = box([1, 1, 1], color="#c8553d", name="O\'Brien")',
    'param("Ø param", 3)',
  ].join('\n');

  it('replaces only the names the writer would not carry through, one placeholder per distinct name', () => {
    const { source: ascii, placeholders } = withAsciiStepNames(source);
    expect(ascii).toContain('name="llull_name_000001")');
    expect(ascii).toContain('label(a, "llull_name_000001")');
    expect(ascii).toContain('name="llull_name_000002")');
    expect(ascii).toContain('name="plain"');
    expect(ascii).toContain('param("Ø param", 3)');
    expect([...placeholders.names.values()]).toEqual(['Ø20 Welle', "O'Brien"]);
  });

  it('reads a name written with JSON escapes (a backslash, a quote) back to the real name', () => {
    const { placeholders } = withAsciiStepNames('a = box([1], name="C:\\\\dir \\"x\\"")');
    expect([...placeholders.names.values()]).toEqual(['C:\\dir "x"']);
  });

  it('picks a prefix that is not in the script, so a name that looks like a placeholder stays a name', () => {
    const tricky = 'a = box([1], name="llull_name_000001")\nb = box([1], name="Ø")';
    const { source: ascii, placeholders } = withAsciiStepNames(tricky);
    expect(placeholders.prefix).toBe('llull_name_x');
    expect(ascii).toContain('name="llull_name_000001"');
    expect(ascii).toContain('name="llull_name_x000001"');
    const step = "#1 = PRODUCT('llull_name_000001','llull_name_x000001','',(#2));";
    expect(restoreStepNames(step, placeholders)).toBe("#1 = PRODUCT('llull_name_000001','\\X2\\00D8\\X0\\','',(#2));");
  });

  it('leaves a script without such names untouched', () => {
    const plain = 'a = box([1], name="plain")';
    const { source: ascii, placeholders } = withAsciiStepNames(plain);
    expect(ascii).toBe(plain);
    expect(placeholders.names.size).toBe(0);
    expect(restoreStepNames("#1 = PRODUCT('x','x','',(#2));", placeholders)).toBe("#1 = PRODUCT('x','x','',(#2));");
  });
});

describe('restoreStepNames', () => {
  it('replaces placeholders inside STEP strings only, also inside longer strings', () => {
    const { placeholders } = withAsciiStepNames('a = box([1], name="Ø20 Welle")\nb = box([1], name="O\'Brien")');
    const step = [
      "#10 = PRODUCT('llull_name_000001','llull_name_000001','',(#7));",
      "#11 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('llull_name_000001_1','llull_name_000002','',#3,#10,$);",
      '/* llull_name_000001 stays in a comment */',
    ].join('\n');
    expect(restoreStepNames(step, placeholders)).toBe(
      [
        "#10 = PRODUCT('\\X2\\00D8\\X0\\20 Welle','\\X2\\00D8\\X0\\20 Welle','',(#7));",
        "#11 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('\\X2\\00D8\\X0\\20 Welle_1','O''Brien','',#3,#10,$);",
        '/* llull_name_000001 stays in a comment */',
      ].join('\n'),
    );
  });
});
