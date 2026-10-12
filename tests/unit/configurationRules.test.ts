import { describe, expect, it } from 'vitest';
import type { Configuration, Parameter } from '@core/model/types';
import { configurationDraftOf, isConfigurationActive } from '@ui/panels/configurationRules';

const param = (expression: string): Parameter => ({ name: 'w', expression, value: 1 });
const config = (parameterValues: Record<string, string>): Configuration => ({
  name: 'c',
  parameterValues,
});

describe('configurationRules', () => {
  it('is active only when every parameter holds the expression', () => {
    expect(isConfigurationActive(config({ w: '2' }), { w: param('2') })).toBe(true);
    expect(isConfigurationActive(config({ w: '2' }), { w: param('3') })).toBe(false);
    expect(isConfigurationActive(config({ w: '2' }), {})).toBe(false);
    expect(isConfigurationActive(config({}), { w: param('2') })).toBe(false);
  });

  it('builds a trimmed draft and ignores blank rows', () => {
    const rows = [
      { paramName: ' w ', expression: ' 2 ' },
      { paramName: '', expression: '' },
    ];
    expect(configurationDraftOf(' small ', rows)).toEqual({
      name: 'small',
      parameterValues: { w: '2' },
    });
  });

  it('rejects blank name, no rows and half-filled rows', () => {
    const ok = [{ paramName: 'w', expression: '2' }];
    expect(configurationDraftOf(' ', ok)).toBeNull();
    expect(configurationDraftOf('a', [{ paramName: '', expression: '' }])).toBeNull();
    expect(configurationDraftOf('a', [{ paramName: 'w', expression: '' }])).toBeNull();
  });
});
