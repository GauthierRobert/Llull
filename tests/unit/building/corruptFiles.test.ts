import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

type Json = Record<string, unknown>;

const BAD: unknown[] = [null, 'x', -1, 0, [], {}, true, undefined];

/** Industrial model: hall with crane + connections + plates + footings + panels, then pipes, supports, tray, equipment. */
function industrialModel(): CadDocument {
  let doc = execute(createEmptyDocument(), 'add_portal_frame_building', {
    span: 12000,
    length: 12000,
    baySpacing: 6000,
    eaveHeight: 6000,
    crane: { capacity: 10, railHeight: 4500 },
  }).document;
  const steps: Array<[string, Json]> = [
    [
      'add_equipment',
      { name: 'Pump', mark: 'P-1', location: [3000, 3000], size: [1500, 800, 900] },
    ],
    [
      'add_pipe_run',
      {
        points: [
          [1000, 3000, 1500],
          [9000, 3000, 1500],
        ],
        dn: 100,
        line: 'L-1',
        from: 'P-1',
      },
    ],
    ['add_pipe_support', { pipeId: 'pipe-1', spacing: 4000 }],
    [
      'add_cable_tray',
      {
        points: [
          [1000, 5000, 3000],
          [9000, 5000, 3000],
        ],
      },
    ],
    ['add_curved_wall', { start: [14000, 0], through: [15000, 1000], end: [16000, 0] }],
  ];
  for (const [name, params] of steps) {
    const result = execute(doc, name, params);
    expect(result.affected.length, `${name}: ${result.summary}`).toBeGreaterThan(0);
    doc = result.document;
  }
  return doc;
}

/** Every path (up to `depth` keys deep) inside `root`, as key lists. */
function pathsIn(root: unknown, depth: number, prefix: string[] = []): string[][] {
  if (depth === 0 || root === null || typeof root !== 'object') return [];
  return Object.entries(root as Json).flatMap(([key, value]) => [
    [...prefix, key],
    ...pathsIn(value, depth - 1, [...prefix, key]),
  ]);
}

function corrupt(base: Json, path: string[], value: unknown): Json {
  const copy = JSON.parse(JSON.stringify(base)) as Json;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Json;
  target[path[path.length - 1] as string] = value;
  return copy;
}

/** Raw crashes (TypeError / RangeError / non-Error) on load; descriptive rejections are fine. */
function rawCrash(text: string): string | null {
  try {
    deserializeDocument(text);
    return null;
  } catch (error) {
    return !(error instanceof Error) || error instanceof TypeError || error instanceof RangeError
      ? String(error)
      : null;
  }
}

function fuzzBuilding(
  file: { version: number; document: Json },
  label: string,
  depth: number,
): string[] {
  const building = file.document['building'] as Json;
  const elements = building['elements'] as Record<string, Json>;
  const firstOfCategory = new Map<string, string>();
  for (const [id, element] of Object.entries(elements)) {
    const category = String(element['category']);
    if (!firstOfCategory.has(category)) firstOfCategory.set(category, id);
  }
  const roots: Array<[string[], unknown]> = [
    [['building'], { ...building, elements: undefined }],
    ...[...firstOfCategory.values()].map((id): [string[], unknown] => [
      ['building', 'elements', id],
      elements[id],
    ]),
    [['building', 'levels'], building['levels']],
  ];
  const failures: string[] = [];
  // Deterministic sample: two bad values per field, rotated by the field's running index.
  let fieldIndex = 0;
  for (const [prefix, root] of roots) {
    for (const relative of pathsIn(root, depth)) {
      const path = ['document', ...prefix, ...relative];
      for (const offset of [0, 3]) {
        const value = BAD[(fieldIndex + offset) % BAD.length];
        const crash = rawCrash(JSON.stringify(corrupt(file as unknown as Json, path, value)));
        if (crash) failures.push(`${label} ${path.join('.')}=${JSON.stringify(value)}: ${crash}`);
      }
      fieldIndex += 1;
    }
  }
  expect(fieldIndex, `${label}: fields exercised`).toBeGreaterThan(100);
  return failures;
}

describe('corrupt industrial building data never crashes load', () => {
  const doc = industrialModel();

  it('covers every industrial category in the model', () => {
    const categories = new Set(Object.values(doc.building?.elements ?? {}).map((e) => e.category));
    for (const category of [
      'member',
      'plate',
      'footing',
      'panel',
      'connection',
      'equipment',
      'pipe',
      'pipeSupport',
      'tray',
      'curvedWall',
    ]) {
      expect(categories.has(category as never), category).toBe(true);
    }
  });

  it('v2 file: single-field corruption (3 levels deep) of one element per category', () => {
    const file = JSON.parse(serializeDocument(doc)) as { version: number; document: Json };
    expect(file.version).toBe(2);
    expect(fuzzBuilding(file, 'v2', 3).slice(0, 10)).toEqual([]);
  });

  it('v1 file (derived entities stored, no step counter): field-level corruption sweep', () => {
    const full = JSON.parse(serializeDocument(doc, { includeDerived: true })) as {
      version: number;
      document: Json;
    };
    const legacy = { ...full, version: 1, document: { ...full.document } };
    delete legacy.document['nextStepNumber'];
    expect(rawCrash(JSON.stringify(legacy))).toBeNull();
    expect(deserializeDocument(JSON.stringify(legacy)).building).toEqual(doc.building);
    expect(fuzzBuilding(legacy, 'v1', 1).slice(0, 10)).toEqual([]);
  });
});
