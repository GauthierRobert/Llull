/** `.lld` lexer + parser: statements, values, comments, blocks, checks, and syntax errors with their line. */

import { describe, expect, it } from 'vitest';
import { parseDesign, parseValue } from '@design/parse';
import { DesignError } from '@design/errors';
import { splitTop, isSpace } from '@design/lexer';

const syntaxLine = (source: string): number => {
  try {
    parseDesign(source);
  } catch (error) {
    if (error instanceof DesignError && error.code === 'DESIGN_SYNTAX') return error.line;
    throw error;
  }
  throw new Error('expected a syntax error');
};

describe('parseDesign', () => {
  it('reads header, params, commands (with and without alias), checks and loops', () => {
    const statements = parseDesign(
      [
        'design part units=mm   # header',
        'param w = 80mm',
        '',
        'add_box base size=[w, 10, 2] color="#c8553d"',
        'set_units units=m',
        'add_box _ size=[1,1,1]',
        'for i in 0..n-1 {',
        '  add_cylinder post{i} radius=1 height=(h + 2)',
        '}',
        'check volume of=base expect ~= 1600 ± 2%',
        'check bbox of=base expect == [80, 10, 2] +- 0.1mm',
      ].join('\n'),
    );
    expect(statements.map((s) => [s.kind, s.line])).toEqual([
      ['header', 1],
      ['param', 2],
      ['command', 4],
      ['command', 5],
      ['command', 6],
      ['for', 7],
      ['check', 10],
      ['check', 11],
    ]);
    expect(statements[0]).toMatchObject({ name: 'part', pairs: [{ key: ['units'], value: { kind: 'word', text: 'mm' } }] });
    expect(statements[1]).toMatchObject({ name: 'w', expression: '80mm' });
    expect(statements[2]).toMatchObject({ command: 'add_box', alias: 'base' });
    expect(statements[3]).toMatchObject({ command: 'set_units', alias: null });
    expect(statements[4]).toMatchObject({ alias: null });
    expect(statements[5]).toMatchObject({ variable: 'i', from: '0', to: 'n-1', body: [{ alias: 'post{i}' }] });
    expect(statements[6]).toMatchObject({ metric: 'volume', op: '~=', tolerance: { value: 2, unit: '%' } });
    expect(statements[7]).toMatchObject({ op: '==', tolerance: { value: 0.1, unit: 'mm' }, expected: { kind: 'list' } });
  });

  it('keeps # inside values (colors) and strips trailing comments', () => {
    const [command] = parseDesign('add_box b size=[1,1,1] color=#c8553d # red');
    expect(command).toMatchObject({ pairs: [{ key: ['size'] }, { key: ['color'], value: { kind: 'word', text: '#c8553d' } }] });
  });

  it('reads dotted keys and nested lists', () => {
    const [command] = parseDesign('add_hole h hole.kind=simple points=[[1, 2], [3, 4]]');
    expect(command).toMatchObject({
      pairs: [
        { key: ['hole', 'kind'], value: { kind: 'word', text: 'simple' } },
        { key: ['points'], value: { kind: 'list', items: [{ kind: 'list' }, { kind: 'list' }] } },
      ],
    });
  });

  it('reports syntax errors with their line', () => {
    expect(syntaxLine('add_box a size=[1,1,1')).toBe(1);
    expect(syntaxLine('add_box a\nadd_box b size')).toBe(2);
    expect(syntaxLine('param 2w = 3')).toBe(1);
    expect(syntaxLine('param w')).toBe(1);
    expect(syntaxLine('add_box a\ndesign late')).toBe(2);
    expect(syntaxLine('design')).toBe(1);
    expect(syntaxLine('}')).toBe(1);
    expect(syntaxLine('\nfor i in 0..2 {\nadd_box a')).toBe(2);
    expect(syntaxLine('for i from 0 {')).toBe(1);
    expect(syntaxLine('check volume of=a')).toBe(1);
    expect(syntaxLine('check volume of=a expect != 3')).toBe(1);
    expect(syntaxLine('check volume of=a expect ==')).toBe(1);
    expect(syntaxLine('check volume of=a expect == 3 ± x')).toBe(1);
    expect(syntaxLine('3box a')).toBe(1);
    expect(syntaxLine('add_box a.b size=1')).toBe(1);
    expect(syntaxLine('add_box a s.2=1')).toBe(1);
    expect(syntaxLine('add_box a name="open')).toBe(1);
    expect(syntaxLine('add_box a x=]')).toBe(1);
  });
});

describe('parseValue', () => {
  it('lists, strings, JSON, words', () => {
    expect(parseValue('[1, [2, 3]]', 1)).toEqual({
      kind: 'list',
      items: [
        { kind: 'word', text: '1' },
        {
          kind: 'list',
          items: [
            { kind: 'word', text: '2' },
            { kind: 'word', text: '3' },
          ],
        },
      ],
    });
    expect(parseValue('"a b"', 1)).toEqual({ kind: 'string', value: 'a b' });
    expect(parseValue('{"near": [0, 0, 1]}', 1)).toEqual({ kind: 'json', value: { near: [0, 0, 1] } });
    expect(parseValue('w/2', 1)).toEqual({ kind: 'word', text: 'w/2' });
    expect(() => parseValue('', 1)).toThrow(DesignError);
    expect(() => parseValue('[1', 1)).toThrow(DesignError);
    expect(() => parseValue('{bad', 1)).toThrow(DesignError);
  });

  it('splitTop keeps brackets, quotes and parentheses together', () => {
    expect(splitTop('a=[1, 2] b="x y" c=(1 + 2)', isSpace, 1)).toEqual(['a=[1, 2]', 'b="x y"', 'c=(1 + 2)']);
  });
});
