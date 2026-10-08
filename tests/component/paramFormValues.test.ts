import { describe, it, expect } from 'vitest';
import { getCommand } from '@core/commands/registry';
import {
  fieldsFromSchema,
  parseFormValues,
  valuesFromParams,
} from '@ui/components/commandPalette/paramForm';

describe('valuesFromParams', () => {
  it('round-trips existing params through the form text and back', () => {
    const fields = fieldsFromSchema(getCommand('array_linear')!.paramsSchema);
    const params = { id: 'box-1.1', count: 3, offset: [2, 0.5, -1e-3] };
    const values = valuesFromParams(fields, params);
    expect(values).toEqual({ id: 'box-1.1', count: '3', offset: '2, 0.5, -0.001' });
    const parsed = parseFormValues(fields, values);
    expect(parsed).toEqual({ ok: true, params });
  });

  it('leaves unknown or mistyped params blank instead of throwing', () => {
    const fields = fieldsFromSchema(getCommand('array_linear')!.paramsSchema);
    expect(valuesFromParams(fields, { count: 'many', offset: 'x' })).toMatchObject({
      count: '',
      offset: '',
    });
  });
});
