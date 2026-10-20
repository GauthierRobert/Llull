/**
 * The Part 21 examples printed in the CAx-IF composite validation practice (docs/aerospace/06-composites/validation/cax-if-rp-examples.p21, sources.md S42)
 * against what export_composite_ap242 writes: the same entities with the same number of attributes and the same literal item names, and (with
 * LLULL_AP242_MIM) the examples' own records against the AP242 ed4 schema (entity names and attribute counts; the examples are fragments, so their
 * references and unset skeleton attributes are not checked).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRecords, stringsOf } from '@lib/step21/records';
import { checkRecords, loadSchema, partials } from '../../../helpers/expressSchema';
import { exportOf, panelDoc } from './ap242Support';

const fixture = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'aerospace', '06-composites', 'validation', 'cax-if-rp-examples.p21'),
  'utf8',
);
const examples = parseRecords(fixture).bodies;
const mim = process.env['LLULL_AP242_MIM'];

describe('CAx-IF practice examples', () => {
  const written = (): ReadonlyMap<number, string> => parseRecords(exportOf(panelDoc().doc).data.step).bodies;

  it('every entity the practice shows and llull writes is written with the same number of attributes', () => {
    const mine = written();
    const shape = (body: string): string[] => partials(body).map(([name, args]) => `${name}/${args.length}`);
    const mineShapes = new Set([...mine.values()].flatMap(shape));
    const compared: string[] = [];
    for (const body of examples.values()) {
      for (const entry of shape(body)) {
        const [name] = entry.split('/');
        const writes = [...mineShapes].some((candidate) => candidate.startsWith(`${name}/`));
        if (!writes) continue;
        expect(mineShapes.has(entry), `${entry} as printed in the practice`).toBe(true);
        compared.push(entry);
      }
    }
    expect(compared.map((entry) => entry.toUpperCase())).toEqual(
      expect.arrayContaining([
        'PRODUCT_RELATED_PRODUCT_CATEGORY/3',
        'PROPERTY_DEFINITION/3',
        'PROPERTY_DEFINITION_REPRESENTATION/2',
        'REPRESENTATION/3',
        'INTEGER_REPRESENTATION_ITEM/2',
        'MEASURE_REPRESENTATION_ITEM/3',
        'DESCRIPTIVE_REPRESENTATION_ITEM/2',
        'ROW_REPRESENTATION_ITEM/2',
        'ITEM_IDENTIFIED_REPRESENTATION_USAGE/5',
        'PLY_ORIENTATION_ANGLE/4',
        'PLY_ANGLE_REPRESENTATION/3',
        'REINFORCEMENT_ORIENTATION_BASIS/3',
        'AXIS2_PLACEMENT_3D/2',
        'PLACEMENT/1',
        'PRODUCT/4',
        'PRODUCT_DEFINITION_FORMATION/3',
        'PRODUCT_DEFINITION/4',
      ]),
    );
  });

  it('the validation property item names of the practice that llull writes are the practice names (not llull ones)', () => {
    const itemNames = (bodies: ReadonlyMap<number, string>): Set<string> =>
      new Set(
        [...bodies.values()]
          .filter((body) => /^(INTEGER|MEASURE|DESCRIPTIVE)_REPRESENTATION_ITEM|^ROW_REPRESENTATION_ITEM/.test(body))
          .map((body) => stringsOf(body)[0] ?? ''),
      );
    const mine = itemNames(written());
    const printed = [...itemNames(examples)];
    // the practice shows these, llull does not write them (explicit-solid level properties are the geometric validation properties of 04 XCH)
    const notWritten = new Set(['centre point of all plies', 'volume measure', 'area measure', 'centre point']);
    for (const name of printed.filter((item) => item !== '' && !notWritten.has(item))) expect(mine.has(name), name).toBe(true);
  });

  it.skipIf(mim === undefined || !existsSync(mim))(
    'the practice examples have known entities and the schema attribute count (AP242 ed4 MIM)',
    () => {
      const { violations } = checkRecords(loadSchema(mim as string), examples, examples.keys());
      const structural = violations.filter(
        (violation) => violation.message === 'unknown entity' || violation.message.includes('arguments, the schema has'),
      );
      expect(structural).toEqual([]);
    },
  );
});
