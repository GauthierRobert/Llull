/**
 * Plant 03 EQP M5, review round 1: the data sheet is unit-independent. (a) Every template kind built in mm, m and in with scaled inputs gives the same
 * sheet (numbers within 1e-6 relative; text compared with its numbers masked, since messages quote document units; documentUnits and file hashes ignored).
 * (b) Structural: every numeric leaf of the stored template and nozzles is either a length key converted by `toMillimetres` or an explicit non-length key,
 * so a new length field cannot escape the conversion unnoticed.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { LENGTH_KEYS } from '@aec/plant/equipment/datasheet/millimetres';
import { at, objectAt, type JsonObject } from '../../../helpers/json';
import { apply, data } from '../../../helpers/commandAssertions';
import {
  bemNozzles,
  bemParams,
  drumNozzles,
  drumParams,
  mmDocument,
  pumpParams,
  separatorNozzles,
  separatorParams,
  tankParams,
} from './equipmentFixtures';

/** Input keys that hold a length (test-owned list: independent of the production key list on purpose). */
const INPUT_LENGTHS = new Set([
  'location',
  'insideDiameter',
  'tangentLength',
  'shellThickness',
  'headThickness',
  'corrosionAllowance',
  'height',
  'thickness',
  'baseRingWidth',
  'pitchDiameter',
  'legWidth',
  'width',
  'axisElevation',
  'baseElevation',
  'stations',
  'spacing',
  'firstElevation',
  'elevation',
  'depth',
  'projection',
  'station',
  'radialOffset',
  'shellInsideDiameter',
  'tubesheetThickness',
  'outsideDiameter',
  'wallThickness',
  'length',
  'pitch',
  'diameter',
  'shellHeight',
  'courses',
  'designLiquidLevel',
  'levelAboveBottomTangent',
  'position',
  'crownRadius',
  'knuckleRadius',
]);

function scaled(value: unknown, factor: number, key = ''): unknown {
  if (typeof value === 'number') return INPUT_LENGTHS.has(key) ? value * factor : value;
  if (Array.isArray(value)) return value.map((entry) => scaled(entry, factor, key));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scaled(entry, factor, name)]));
  return value;
}

type Build = (doc: CadDocument, factor: number) => CadDocument;
const add =
  (command: string, params: object, tag: string, nozzles: object[] = []): Build =>
  (doc, factor) => {
    let next = apply(doc, command, scaled(params, factor));
    for (const nozzle of nozzles) next = apply(next, 'add_nozzle', { equipment: tag, ...(scaled(nozzle, factor) as object) });
    return next;
  };

const verticalOnly = Object.fromEntries(Object.entries(separatorParams).filter(([key]) => key !== 'orientation'));

const CASES: Record<string, { tag: string; build: Build }> = {
  'skirt separator': { tag: 'V-101', build: add('add_vessel', separatorParams, 'V-101', separatorNozzles) },
  'saddle drum': { tag: 'D-201', build: add('add_vessel', drumParams, 'D-201', drumNozzles) },
  'legs vessel': {
    tag: 'V-101',
    build: add('add_vessel', { ...separatorParams, support: { type: 'legs', count: 4, height: 1500 } }, 'V-101', separatorNozzles),
  },
  'column with trays and clips': {
    tag: 'C-301',
    build: add(
      'add_process_column',
      {
        ...verticalOnly,
        tag: 'C-301',
        insideDiameter: 2000,
        tangentLength: 15000,
        trays: { count: 20, spacing: 600, firstElevation: 1500, type: 'sieve' },
        platformClips: [
          { elevation: 3000, fromDeg: 30, toDeg: 120, depth: 200, height: 150 },
          { elevation: 9000, fromDeg: 200, toDeg: 300 },
        ],
      },
      'C-301',
    ),
  },
  exchanger: { tag: 'E-301', build: add('add_heat_exchanger', bemParams, 'E-301', bemNozzles) },
  tank: {
    tag: 'T-401',
    build: add('add_storage_tank', tankParams, 'T-401', [
      {
        mark: 'N1',
        dn: 200,
        rating: 'CL150',
        facing: 'RF',
        location: { on: 'shell', elevation: 1000, orientationDeg: 90 },
        projection: 10400,
      },
    ]),
  },
  'pump with driver': {
    tag: 'P-101',
    build: add('add_pump', { ...pumpParams, baseplate: { length: 1800, width: 700, height: 150 } }, 'P-101'),
  },
};

const FACTORS: Array<[string, number]> = [
  ['m', 0.001],
  ['in', 1 / 25.4],
];
const unitDocument = (units: string): CadDocument => apply(mmDocument(), 'set_units', { units });
const sheetOf = (doc: CadDocument, tag: string): JsonObject => {
  const {
    text: _text,
    sha256: _hash,
    bytes: _bytes,
    fileName: _name,
    ...record
  } = data<Record<string, unknown>>(doc, 'equipment_datasheet', { equipment: tag });
  return JSON.parse(JSON.stringify(record)) as JsonObject;
};

/** First difference between two JSON values (numbers within 1e-6 relative, strings with digits masked), or null. */
function difference(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const mask = (text: string): string => text.replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi, '#');
    return mask(a) === mask(b) ? null : `${path}: "${a}" vs "${b}"`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let index = 0; index < a.length; index++) {
      const found = difference(a[index], b[index], `${path}.${index}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const [keysA, keysB] = [Object.keys(a).sort(), Object.keys(b).sort()];
    if (keysA.join() !== keysB.join()) return `${path}: keys ${keysA.join()} vs ${keysB.join()}`;
    for (const key of keysA) {
      const found = difference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (found !== null) return found;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

describe('equipment_datasheet is unit-independent (mm, m and in with scaled inputs)', () => {
  describe.each(Object.entries(CASES))('%s', (_name, { tag, build }) => {
    const reference = sheetOf(build(mmDocument(), 1), tag);

    it.each(FACTORS)('the sheet built in %s equals the sheet built in mm', (units, factor) => {
      const other = sheetOf(build(unitDocument(units), factor), tag);
      expect(at(other, 'provenance.documentUnits')).toBe(units);
      const [a, b] = [structuredClone(reference), structuredClone(other)];
      delete objectAt(a, 'provenance')['documentUnits'];
      delete objectAt(b, 'provenance')['documentUnits'];
      expect(difference(a, b)).toBeNull();
    });
  });
});

/** Numeric template / nozzle keys that are not lengths. */
const NON_LENGTH = new Set([
  'count',
  'passes',
  'layoutAngleDeg',
  'ratio',
  'halfAngleDeg',
  'dn',
  'suctionDn',
  'dischargeDn',
  'orientationDeg',
  'fromDeg',
  'toDeg',
  'slope',
  'specificGravity',
  'weightKg',
  'materialDensityKgM3',
  'temperatureC',
  'value',
  'direction',
]);

function numericLeaves(value: unknown, key: string, path: string, out: Array<{ key: string; path: string }>): void {
  if (typeof value === 'number') out.push({ key, path });
  else if (Array.isArray(value)) value.forEach((entry, index) => numericLeaves(entry, key, `${path}.${index}`, out));
  else if (value !== null && typeof value === 'object')
    for (const [name, entry] of Object.entries(value)) numericLeaves(entry, name, `${path}.${name}`, out);
}

describe('every numeric leaf of the stored plant data is a converted length key or a declared non-length key', () => {
  it.each(Object.entries(CASES))('%s', (_name, { tag, build }) => {
    const doc = build(mmDocument(), 1);
    const element = Object.values(doc.building?.elements ?? {}).find(
      (candidate) => candidate.category === 'equipment' && candidate.mark === tag,
    );
    if (element?.category !== 'equipment' || element.plant === undefined) throw new Error('fixture');
    const leaves: Array<{ key: string; path: string }> = [];
    numericLeaves({ template: element.plant.template, nozzles: element.plant.nozzles }, '', '', leaves);
    const escaped = leaves.filter(({ key }) => !LENGTH_KEYS.has(key) && !NON_LENGTH.has(key));
    expect(escaped.map(({ path }) => path)).toEqual([]);
  });
});

describe('the sheet text', () => {
  it('counts bytes as UTF-8 and hashes the UTF-8 bytes (a non-ASCII tag)', () => {
    const doc = apply(mmDocument(), 'add_vessel', { ...separatorParams, tag: 'Ü-101', name: 'Réacteur — π' });
    const result = data<{ text: string; bytes: number; sha256: string; fileName: string }>(doc, 'equipment_datasheet', {
      equipment: 'Ü-101',
    });
    expect(result.text.length).toBeLessThan(result.bytes);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fileName).toBe('_-101-datasheet.json');
    expect(execute(doc, 'equipment_datasheet', { equipment: 'Ü-101' }).summary).toContain(`${result.bytes} bytes`);
  });
});
