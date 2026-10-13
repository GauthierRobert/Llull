import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const MATERIAL = { density: 1, color: '#112233', metalness: 0.5, roughness: 0.5 };

describe('user-chosen record keys are never Object.prototype names', () => {
  const doc = createEmptyDocument();
  const cases: ReadonlyArray<readonly [string, (name: string) => Record<string, unknown>]> = [
    ['set_parameter', (name) => ({ name, expression: '1' })],
    ['save_recipe', (name) => ({ name })],
    ['create_configuration', (name) => ({ name, parameterValues: {} })],
    ['create_material', (name) => ({ name, ...MATERIAL })],
  ];
  it.each(cases)('%s rejects constructor / toString / __proto__ unchanged', (command, params) => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const result = execute(doc, command, params(name));
      expect(result.document, `${command} ${name}`).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('reserved');
    }
  });
  it.each(cases)('%s still accepts an ordinary name', (command, params) => {
    const result = execute(doc, command, params('ordinary_name'));
    expect(result.document).not.toBe(doc);
  });

  it('create_configuration rejects a prototype parameter key', () => {
    const result = execute(doc, 'create_configuration', { name: 'v', parameterValues: { constructor: '1' } });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('reserved');
  });

  it('create_material reports replaced only for an own key', () => {
    const first = execute(doc, 'create_material', { name: 'steel', ...MATERIAL });
    expect(first.summary).toContain('created');
    expect(execute(first.document, 'create_material', { name: 'steel', ...MATERIAL }).summary).toContain('replaced');
  });
});
