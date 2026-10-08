import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateExpression, expressionSyntaxError } from '@core/commands/expression';

const value = (expression: string, env: Record<string, number> = {}): number | string => {
  const result = evaluateExpression(expression, env);
  return result.ok ? result.value : result.error;
};

describe('expression numbers', () => {
  it.each([
    ['1e-3', 0.001],
    ['2.5E+2', 250],
    ['1e3 + 1', 1001],
    ['.5 * 4', 2],
    ['3.', 3],
    ['-1e2', -100],
  ])('evaluates %s', (expression, expected) => {
    expect(value(expression)).toBeCloseTo(expected);
  });

  it('still parses an identifier named e after an operator', () => {
    expect(value('2 * e', { e: 3 })).toBe(6);
  });

  it('a dangling exponent is not a number', () => {
    expect(typeof value('1e')).toBe('string');
  });
});

describe('expressionSyntaxError', () => {
  it.each(['2*', '(1+2', '1 +', '*3', '1 2', '@'])('flags %s', (expression) => {
    expect(expressionSyntaxError(expression)).not.toBeNull();
  });

  it('accepts valid expressions, unknown references and reference-driven divisions', () => {
    expect(expressionSyntaxError('1e-3')).toBeNull();
    expect(expressionSyntaxError('later * 2')).toBeNull();
    expect(expressionSyntaxError('a / (b - 1)')).toBeNull();
  });

  it('flags a constant divide by zero', () => {
    expect(expressionSyntaxError('1 / 0')).toContain('not a finite');
  });
});

describe('set_parameter with an invalid expression', () => {
  const base = execute(
    execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '5' }).document,
    'set_parameter',
    { name: 'h', expression: 'w * 2' },
  ).document;

  it('keeps the previous expression, value and dependents', () => {
    const result = execute(base, 'set_parameter', { name: 'w', expression: '2*' });
    expect(result.document).toBe(base);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("keeps its previous expression '5'");
    expect(base.parameters['h']!.value).toBe(10);
    expect(base.parameters['h']!.error).toBeUndefined();
  });

  it('does not create a new parameter from an invalid expression', () => {
    const result = execute(base, 'set_parameter', { name: 'fresh', expression: '(1+' });
    expect(result.document).toBe(base);
    expect(result.summary).toContain('was not created');
  });

  it('accepts scientific notation', () => {
    const result = execute(base, 'set_parameter', { name: 'tol', expression: '1e-3' });
    expect(result.document.parameters['tol']!.value).toBeCloseTo(0.001);
    expect(result.document.parameters['tol']!.error).toBeUndefined();
  });

  it('still stores forward references with an error (the parameter may come later)', () => {
    const result = execute(base, 'set_parameter', { name: 'x', expression: 'ghost * 2' });
    expect(result.document.parameters['x']!.error).toContain('unknown parameter');
  });
});
