import { describe, expect, it } from 'vitest';
import { isParameterNameValid, parameterDraftOf } from '@ui/panels/parameterRules';

describe('parameterRules', () => {
  it('accepts identifiers and blank, rejects others', () => {
    expect(isParameterNameValid('')).toBe(true);
    expect(isParameterNameValid(' width_1 ')).toBe(true);
    expect(isParameterNameValid('1width')).toBe(false);
    expect(isParameterNameValid('a b')).toBe(false);
  });
  it('trims the draft and rejects blanks', () => {
    expect(parameterDraftOf(' w ', ' 3 * 2 ')).toEqual({ name: 'w', expression: '3 * 2' });
    expect(parameterDraftOf('w', '  ')).toBeNull();
    expect(parameterDraftOf('', '1')).toBeNull();
  });
});
