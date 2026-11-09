import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { spaceEnvironmentErrors } from '@cae/environment/model';
import { environmentPlugin } from '@cae/index';
import { missionDocument, run } from './fixtures';

/** The raw slice as persistence sees it (deep copy of the JSON). */
const rawSlice = (): Record<string, unknown> => JSON.parse(JSON.stringify(missionDocument().spaceEnvironment)) as Record<string, unknown>;

/** Replaces the value at a dotted path by `edit(current)`; `undefined` deletes the key. */
function update(root: Record<string, unknown>, path: string, edit: (current: unknown) => unknown): void {
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, root);
  const next = edit(parent[last]);
  if (next === undefined) delete parent[last];
  else parent[last] = next;
}

const errorsAfter = (...edits: [string, (current: unknown) => unknown][]): string[] => {
  const slice = rawSlice();
  for (const [path, edit] of edits) update(slice, path, edit);
  return spaceEnvironmentErrors({ spaceEnvironment: slice });
};

const set = (value: unknown) => (): unknown => value;

describe('spaceEnvironment slice (load validation)', () => {
  it('accepts a slice written by the commands and an absent slice', () => {
    expect(spaceEnvironmentErrors({ spaceEnvironment: rawSlice() })).toEqual([]);
    expect(spaceEnvironmentErrors({})).toEqual([]);
    expect(spaceEnvironmentErrors({ spaceEnvironment: { outgassingProfile: 'ecss_q_st_70_02' } })).toEqual([]);
  });

  it.each<[string, [string, (current: unknown) => unknown][], string]>([
    ['an unknown shipped profile id', [['outgassingProfile', set('nasa')]], 'spaceEnvironment.outgassingProfile'],
    ['a profile that is neither id nor object', [['outgassingProfile', set(5)]], 'spaceEnvironment.outgassingProfile'],
    ['a profile id with a reserved name', [['outgassingProfile.id', set('constructor')]], 'outgassingProfile'],
    ['a profile without limits', [['outgassingProfile.limits', set([])]], 'outgassingProfile'],
    [
      'more limits than the cap',
      [['outgassingProfile.limits', set(Array.from({ length: 9 }, () => ({ quantity: 'TML', op: '<', value: 1, unit: '%' })))]],
      'outgassingProfile',
    ],
    ['a limit above 100 %', [['outgassingProfile.limits.0.value', set(101)]], 'outgassingProfile'],
    ['a negative limit', [['outgassingProfile.limits.0.value', set(-1)]], 'outgassingProfile'],
    ['a limit of unknown quantity', [['outgassingProfile.limits.0.quantity', set('XYZ')]], 'outgassingProfile'],
    ['an unknown operator', [['outgassingProfile.limits.0.op', set('>')]], 'outgassingProfile'],
    ['a profile without source', [['outgassingProfile.source', set('')]], 'outgassingProfile.source'],
    ['an oversized source text', [['outgassingProfile.source', set('x'.repeat(501))]], 'outgassingProfile.source'],
    ['an unknown key of the profile', [['outgassingProfile.extra', set(1)]], 'outgassingProfile'],
    ['an unknown top-level key', [['extra', set(1)]], 'spaceEnvironment'],
    ['relative humidity above 100', [['humidityExposure.relativeHumidity', set(101)]], 'humidityExposure.relativeHumidity'],
    [
      'a temperature unit that is not a temperature',
      [['humidityExposure.temperature.unit', set('kg')]],
      'humidityExposure.temperature.unit',
    ],
    ['a duration unit that is not a time', [['humidityExposure.duration.unit', set('mm')]], 'humidityExposure.duration.unit'],
    ['a negative duration', [['humidityExposure.duration.value', set(-1)]], 'humidityExposure.duration'],
    ['a non-finite duration (null after JSON)', [['humidityExposure.duration.value', set(null)]], 'humidityExposure.duration.value'],
    ['faces other than both / one', [['humidityExposure.faces', set('three')]], 'humidityExposure.faces'],
    ['an exposure without source', [['humidityExposure.source', set(undefined)]], 'humidityExposure.source'],
    ['a fluence unit that is not accepted', [['aoFluence.unit', set('atoms/mm^2')]], 'aoFluence.unit'],
    ['a negative fluence', [['aoFluence.value', set(-1)]], 'aoFluence.value'],
    ['a fluence without source', [['aoFluence.source', set(undefined)]], 'aoFluence.source'],
    ['a slice that is not an object', [], 'spaceEnvironment'],
  ])('refuses %s, naming the path', (name, edits, path) => {
    const errors = name === 'a slice that is not an object' ? spaceEnvironmentErrors({ spaceEnvironment: [1] }) : errorsAfter(...edits);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.startsWith(path) || error.includes(path))).toBe(true);
  });

  it('plugin validate / derive / restore behave as pure definition data', () => {
    const doc = missionDocument();
    expect(environmentPlugin.document?.validate({ spaceEnvironment: { outgassingProfile: 'nope' } }).length).toBeGreaterThan(0);
    expect(environmentPlugin.document?.derivedEntityIds(doc).size).toBe(0);
    const raw = { a: 1 };
    expect(environmentPlugin.document?.restore(raw)).toBe(raw);
  });

  it('survives history replay and is cleared by clear_document', () => {
    const doc = missionDocument();
    const replayed = run(doc, 'replay_history', {});
    expect(replayed.document.spaceEnvironment).toEqual(doc.spaceEnvironment);
    const cleared = execute(doc, 'clear_document', {});
    expect('spaceEnvironment' in cleared.document).toBe(false);
    expect(createEmptyDocument().spaceEnvironment).toBeUndefined();
  });
});
