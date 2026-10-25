/**
 * Plant 08 DAT M1: the `plant.data` slice survives save and load, and a hand-edited file that breaks an invariant is refused with a path (TR-DAT-02).
 * A tag that only drifted from its format loads (check_plant_data reports it); a deleted model element leaves an orphan, not an error.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { plantDataErrors } from '@aec/plant/data/validate';
import { apply, data } from '../../../helpers/commandAssertions';
import { addEquipment, addPipe, assignPump, libraryDocument } from './dataFixtures';

/** Hierarchy, library, two pumps, a line and a reserved tag: every kind of object the slice holds. */
function fullDocument(): CadDocument {
  let doc = addEquipment(libraryDocument(), { name: 'A' }).doc;
  doc = assignPump(doc, 'equipment-1', { provenance: { DesignPressure: { source: 'datasheet', ref: 'DS-1', unverified: true } } }).doc;
  const pipe = addPipe(doc, { line: 'L-1', from: 'P-101', to: 'BL-1', service: 'cw' });
  doc = apply(pipe.doc, 'assign_plant_object', {
    target: pipe.id,
    className: 'ProcessLine',
    hierarchy: 'U10',
    tagFields: { fluidCode: 'CWS', seq: 7, spec: 'B2' },
  });
  doc = apply(doc, 'assign_plant_object', {
    target: 'reserved',
    className: 'Tank',
    hierarchy: 'U10',
    nextSequence: true,
    properties: { Description: 'later', DesignPressure: 2 },
  });
  return apply(doc, 'define_plant_class', {
    name: 'Mine',
    parent: 'Tank',
    tagScope: 'site',
    properties: [{ name: 'Kind', type: 'enum', enumValues: ['a', 'b'], default: 'a' }],
  });
}

type Edit = [path: string, value: unknown];

const pop = (current: unknown): unknown => (current as unknown[]).slice(0, -1);

/** Sets `path` of the saved slice (`$o0` / `$h1` = the first object id / second hierarchy id; a function value maps the current value; undefined deletes), reloads. */
function reload(...edits: Edit[]): CadDocument {
  const file = JSON.parse(serializeDocument(fullDocument())) as { document: { plant: { data: Record<string, unknown> } } };
  const slice = file.document.plant.data;
  const ids: Record<string, string[]> = { o: slice['objectOrder'] as string[], h: slice['hierarchyOrder'] as string[] };
  for (const [path, value] of edits) {
    const keys = path
      .split('.')
      .map((key) => (/^\$([oh])(\d)$/.test(key) ? ((ids[key[1] as string] as string[])[Number(key[2])] as string) : key));
    const parent = keys.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, slice);
    const last = keys.at(-1) as string;
    if (value === undefined) delete parent[last];
    else parent[last] = typeof value === 'function' ? (value as (current: unknown) => unknown)(parent[last]) : value;
  }
  return deserializeDocument(JSON.stringify(file));
}

describe('plant.data persistence', () => {
  it('round trips the slice exactly and re-serialises the same text', () => {
    const doc = fullDocument();
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.plant?.data).toEqual(doc.plant?.data);
    expect(serializeDocument(loaded)).toBe(text);
    expect(data<{ status: string }>(loaded, 'check_plant_data', {}).status).toBe('warn');
  });

  it('loads a document without the slice, and refuses a slice that is not an object or has another version', () => {
    expect(plantDataErrors(undefined)).toEqual([]);
    expect(plantDataErrors([])).toEqual(['plant.data must be an object']);
    expect(plantDataErrors({ version: 2 })).toEqual(['plant.data.version must be 1']);
    expect(deserializeDocument(serializeDocument(libraryDocument())).plant?.data?.classOrder.length).toBeGreaterThan(5);
  });

  it('a tag that drifted from its format loads and is a check finding; an orphan loads too', () => {
    const drifted = reload(['objects.$o0.tag', 'P-199']);
    expect(data<{ findings: Array<{ code: string }> }>(drifted, 'check_plant_data', {}).findings.map((finding) => finding.code)).toContain(
      'DAT_TAG_FORMAT',
    );
    const orphan = reload(['objects.$o0.target', { kind: 'buildingElement', id: 'equipment-404' }]);
    expect(data<{ findings: Array<{ code: string }> }>(orphan, 'check_plant_data', {}).findings.map((finding) => finding.code)).toContain(
      'DAT_OBJECT_ORPHAN',
    );
  });

  it.each([
    ['settings pattern', [['settings.batteryLimitPattern', '(']], /batteryLimitPattern/],
    ['settings scope', [['settings.defaultTagScope', 'galaxy']], /defaultTagScope/],
    ['settings missing', [['settings', undefined]], /settings must be an object/],
    ['hierarchy node id', [['hierarchy.$h0.id', 'x']], /id must equal its key/],
    ['hierarchy kind', [['hierarchy.$h0.kind', 'galaxy']], /kind must be one of/],
    ['hierarchy parent', [['hierarchy.$h1.parentId', 'hier-gone']], /parentId must name a node/],
    ['hierarchy kind order', [['hierarchy.$h1.kind', 'system']], /cannot be below/],
    ['site with a parent', [['hierarchy.$h0.parentId', '$h1']], /only a site has no parent|parentId must name a node/],
    ['hierarchy order', [['hierarchyOrder', pop]], /hierarchyOrder must list every entry once/],
    ['sibling code', [['hierarchy.$h2.code', 'P1']], /used twice/],
    ['class name', [['classes.Tank.name', 'Other']], /name must equal its key/],
    ['class parent', [['classes.Tank.parent', 'Nope']], /unknown parent/],
    ['class cycle', [['classes.Equipment.parent', 'Tank']], /inherits from itself/],
    ['class tag format', [['classes.Tank.tagFormat', 'nofield']], /tagFormat/],
    ['class property', [['classes.Mine.properties', (list: unknown) => [{ ...(list as object[])[0], unit: 'mm' }]]], /properties\[0\]/],
    ['class property shape', [['classes.Mine.properties', [5]]], /properties\[0\] must be/],
    ['class ifc', [['classes.Tank.ifc.predefinedType', 'NOPE']], /ifc:/],
    [
      'class override',
      [['classes.Mine.properties', [{ name: 'DesignPressure', displayName: 'x', type: 'text' }]]],
      /cannot change the type/,
    ],
    ['class order', [['classOrder', pop]], /classOrder/],
    ['object id', [['objects.$o0.id', 'x']], /id must equal its key/],
    ['object class', [['objects.$o0.className', 'Nope']], /className must name a class/],
    ['object abstract class', [['objects.$o0.className', 'Equipment']], /is abstract/],
    ['object hierarchy', [['objects.$o0.hierarchyId', 'hier-gone']], /hierarchyId/],
    ['object target kind', [['objects.$o0.target', { kind: 'moon' }]], /target\.kind/],
    ['object target id', [['objects.$o0.target', { kind: 'buildingElement' }]], /target\.id/],
    ['object provider target', [['objects.$o0.target', { kind: 'provider', id: 'x' }]], /provider and id/],
    ['object target shape', [['objects.$o0.target', 3]], /target must be an object/],
    ['object tag', [['objects.$o0.tag', ' ']], /tag must be a non-empty string/],
    ['object properties', [['objects.$o0.properties', { a: {} }]], /properties must map/],
    ['object property unknown', [['objects.$o0.properties.Colour', 'red']], /not a property of/],
    ['object property type', [['objects.$o0.properties.DesignPressure', 'high']], /DesignPressure/],
    ['object provenance', [['objects.$o0.provenance', { DesignPressure: 3 }]], /provenance must map/],
    ['object line', [['objects.$o0.lineId', 'plantobj-gone']], /lineId must name a plant object/],
    ['object shape', [['objects.$o0', 3]], /must be an object/],
    ['object order', [['objectOrder', pop]], /objectOrder/],
    [
      'duplicate tag',
      [
        ['objects.$o3.tag', 'P-101'],
        ['objects.$o3.tagFields', { seq: 1 }],
      ],
      /is held by|tag/,
    ],
  ] as Array<[string, Edit[], RegExp]>)('refuses a file with a broken %s', (_name, edits, message) => {
    expect(() => reload(...edits)).toThrow(message);
  });
});
