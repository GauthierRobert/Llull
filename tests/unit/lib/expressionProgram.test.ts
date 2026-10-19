/** Compiled expression programs: same bits as evaluateExpression, exact forward-mode derivatives, compile errors. */

import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '@lib/expression';
import {
  compileExpression,
  linearProgram,
  programFunction,
  programGradient,
  programIsBitExact,
  type Program,
} from '@lib/expressionProgram';

const names = ['a', 'b', 'c'];
const compiled = (expression: string): Program => {
  const program = compileExpression(expression, names);
  if (typeof program === 'string') throw new Error(program);
  return program;
};

describe('compileExpression', () => {
  const expressions = [
    'a - (b + c) * 2.5e-1',
    '-a * b / c + pi',
    'sqrt(a*a + b*b) - hypot(a, b) + abs(-c)',
    'pow(a, 3) + exp(b / 10) + ln(c) + log10(a)',
    'sin(a) * cos(b) + tan(c / 10) + atan2(a, b) + asin(0.5) + acos(0.25) + atan(c)',
    'min(a, b, c) + max(a, b) + floor(a) + ceil(b) + round(c) + trunc(a) + sign(-b) + mod(a, 2) + tau',
  ];

  it.each(expressions)('%s evaluates to the same bits as evaluateExpression', (expression) => {
    const f = programFunction(compiled(expression));
    for (const [a, b, c] of [
      [1.25, 2.5, 3.75],
      [7.1, 0.3, 9.9],
      [3, 4, 5],
    ] as const) {
      const reference = evaluateExpression(expression, { a, b, c });
      expect(reference.ok).toBe(true);
      expect(Object.is(f([a, b, c]), reference.ok ? reference.value : Number.NaN)).toBe(true);
    }
  });

  it('refuses syntax errors, unknown names and functions, and wrong arity', () => {
    expect(compileExpression('a +', names)).toBe('unexpected end of expression');
    expect(compileExpression('d', names)).toBe('unknown name: d');
    expect(compileExpression('foo(a)', names)).toBe('unknown function: foo');
    expect(compileExpression('pow(a)', names)).toContain('takes 2-2');
    expect(compileExpression('(a', names)).toContain("expected ')'");
    expect(compileExpression('sqrt(a', names)).toContain("expected ')' in call");
    expect(compileExpression('a b', names)).toContain("unexpected token 'b'");
    expect(compileExpression('', names)).toBe('expression is empty');
    expect(compileExpression('a $ b', names)).toContain('unexpected character');
    expect(compileExpression(')', names)).toContain("unexpected token ')'");
  });

  it('flags trigonometry as not bit-exact for the native twin', () => {
    expect(programIsBitExact(compiled('a - b * pow(c, 2)'))).toBe(true);
    expect(programIsBitExact(compiled('a * sin(b)'))).toBe(false);
  });
});

describe('programGradient (forward-mode automatic differentiation)', () => {
  const at = [1.3, 0.7, 2.1];
  const centralDifference = (program: Program, i: number): number => {
    const f = programFunction(program);
    const h = 1e-6;
    const plus = [...at];
    const minus = [...at];
    plus[i] = (plus[i] as number) + h;
    minus[i] = (minus[i] as number) - h;
    return (f(plus) - f(minus)) / (2 * h);
  };

  it('linear stacks give their coefficients exactly', () => {
    const { value, gradient } = programGradient(compiled('a - (b + c) / 2'), at);
    expect(value).toBeCloseTo(1.3 - 1.4, 12);
    expect(gradient).toEqual([1, -0.5, -0.5]);
    expect(programGradient(linearProgram([2, -1, 0.5]), at).gradient).toEqual([2, -1, 0.5]);
  });

  it.each([
    'sin(a) * cos(b) + tan(c / 4)',
    'asin(b) + acos(b / 2) + atan(a) + atan2(a, c)',
    'sqrt(a * c) + abs(-b) + exp(b) + ln(c) + log10(a)',
    'pow(a, 2.5) + pow(c, b) + hypot(a, b, c) + mod(c, a)',
    'min(a, b) * max(b, c) + -a / b + floor(c) + sign(a)',
  ])('%s matches central differences', (expression) => {
    const program = compiled(expression);
    const { gradient } = programGradient(program, at);
    gradient.forEach((g, i) => expect(Math.abs(g - centralDifference(program, i))).toBeLessThan(1e-6));
  });
});
