/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildingErrors } from '@core/commands/building/validate';
import { serializeDocument } from '@core/commands/persistence';

const house = execute(createEmptyDocument(), 'add_building_template', {
  template: 'house',
}).document;
const valid = JSON.parse(JSON.stringify(house.building)) as Record<string, unknown>;

function mutate(edit: (building: Record<string, any>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(valid)) as Record<string, any>;
  edit(copy);
  return copy;
}

describe('buildingErrors', () => {
  it('accepts every generated building (incl. slab openings)', () => {
    expect(buildingErrors(valid)).toEqual([]);
    const office = execute(createEmptyDocument(), 'add_building_template', {
      template: 'office',
    }).document;
    expect(buildingErrors(JSON.parse(JSON.stringify(office.building)))).toEqual([]);
  });

  it.each([
    ['not an object', () => 3, /must be an object/],
    ['missing levels', () => mutate((b) => delete b.levels), /levels must be an object/],
    ['missing elements', () => mutate((b) => delete b.elements), /elements must be an object/],
    ['missing project', () => mutate((b) => delete b.project), /project must be an object/],
    [
      'bad level',
      () => mutate((b) => (b.levels['level-1'].height = 0)),
      /level level-1 is malformed/,
    ],
    [
      'unknown in order',
      () => mutate((b) => b.elementOrder.push('ghost')),
      /elementOrder must list known ids/,
    ],
    [
      'bad category',
      () => mutate((b) => (b.elements['wall-1'].category = 'roof')),
      /unknown category/,
    ],
    ['element not object', () => mutate((b) => (b.elements['wall-1'] = 1)), /is not an object/],
    ['id mismatch', () => mutate((b) => (b.elements['wall-1'].id = 'x')), /id does not match/],
    ['bad mark', () => mutate((b) => (b.elements['wall-1'].mark = 3)), /mark must be a string/],
    ['bad entityIds', () => mutate((b) => delete b.elements['wall-1'].entityIds), /entityIds/],
    [
      'NaN thickness',
      () => mutate((b) => (b.elements['wall-1'].thickness = null)),
      /thickness must be a finite/,
    ],
    [
      'bad point',
      () => mutate((b) => (b.elements['wall-1'].start = [1])),
      /start must be \[x, y\]/,
    ],
    [
      'bad boundary',
      () => mutate((b) => (b.elements['slab-1'].boundary = [[0, 0]])),
      /boundary must be a polygon/,
    ],
    [
      'bad openings',
      () => mutate((b) => (b.elements['slab-2'].openings = [[[0, 0]]])),
      /openings must be polygons/,
    ],
    [
      'unknown level',
      () => mutate((b) => (b.elements['wall-1'].levelId = 'level-9')),
      /not a known level/,
    ],
    ['no host', () => mutate((b) => delete b.elements['door-1'].hostId), /hostId must be a string/],
  ])('rejects %s', (_label, build, message) => {
    expect(buildingErrors(build()).join('\n')).toMatch(message);
  });

  it('load_document refuses a malformed building and keeps the current document', () => {
    const json = serializeDocument(house).replace('"thickness":300', '"thickness":"thick"');
    const before = createEmptyDocument();
    const result = execute(before, 'load_document', { json });
    expect(result.document).toBe(before);
    expect(result.summary).toMatch(/thickness must be a finite number/);
  });
});
