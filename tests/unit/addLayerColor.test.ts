import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp } from '../helpers/expectNoOp';

describe('add_layer color validation', () => {
  const doc = createEmptyDocument();
  it('rejects a non-hex color without creating a layer', () => {
    expectNoOp(execute(doc, 'add_layer', { name: 'Walls', color: 'red' }), doc, '#rrggbb');
  });
  it('accepts a #rrggbb color', () => {
    const result = execute(doc, 'add_layer', { name: 'Walls', color: '#ff0000' });
    expect(result.document.layers[result.affected[0]!]!.color).toBe('#ff0000');
  });
});
