/** Plant 04 PID M6: the schema check (rules of DEXPI_XML_Schema.xsd) and the 2.0 name encoding. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readXml } from '@lib/xmlRead';
import { checkDexpi20 } from '@aec/plant/pid/dexpi20/schemaCheck';
import {
  attributeName,
  attributeProperty,
  decodeName,
  encodeName,
  enumReference,
  unitOfReference,
  unitReference,
  valueOfReference,
} from '@aec/plant/pid/dexpi20/names20';
import { PID_PACK } from './dexpiFixtures';
import { SCHEMA_MUTANTS, VALID_MINIMAL } from './dexpiSchemaMutants';

const check = (text: string): ReturnType<typeof checkDexpi20> => {
  const read = readXml(text);
  if (!read.ok) throw new Error(read.error.message);
  return checkDexpi20(read.root);
};

describe('checkDexpi20: the rules of DEXPI_XML_Schema.xsd', () => {
  it('accepts the DEXPI reference file and an instance that uses every value kind', () => {
    expect(check(readFileSync(path.join(PID_PACK, 'data/dexpi20/reference_pid.xml'), 'utf8'))).toEqual({
      valid: true,
      count: 0,
      violations: [],
    });
    expect(check(VALID_MINIMAL).valid).toBe(true);
  });

  it.each(SCHEMA_MUTANTS)('rejects %s', (_name, text, message) => {
    const report = check(text);
    expect(report.valid).toBe(false);
    expect(report.violations.map((violation) => violation.message).join('\n')).toContain(message);
    expect(report.violations[0]?.path).toMatch(/^line \d+, column \d+$/);
  });

  it('rejects another root, lists at most 100 violations but counts all, and ignores namespace declarations', () => {
    expect(check('<PlantModel/>').violations[0]?.message).toContain('expected <Model>');
    const many = `<Model name="m" uri="u">${'<Object type="x"/>'.repeat(150)}</Model>`;
    const report = check(many);
    expect(report.count).toBe(150);
    expect(report.violations).toHaveLength(100);
    expect(check('<Model xmlns:p="urn:p" name="m" uri="u"/>').valid).toBe(true);
  });

  it('takes element names like constructor as unknown elements, not as rules', () => {
    expect(check('<Model name="m" uri="u"><constructor/><toString/></Model>').count).toBe(2);
  });

  it('accepts the type-definition elements of the schema without looking inside', () => {
    expect(check('<Model name="m" uri="u"><Package name="p"><Anything/></Package></Model>').valid).toBe(true);
  });
});

describe('names of the 2.0 encoding', () => {
  const SAMPLES = [
    '',
    'a',
    'Nozzle-1',
    '1abc',
    '_x002D_',
    'a_x005F_b',
    '_',
    'x_',
    'é€𝄞',
    'A B',
    'PipingNetworkSegment-12',
    '__proto__',
    'constructor',
  ];

  it.each(SAMPLES)('encodes %j to a XSD name and decodes it back', (text) => {
    const encoded = encodeName(text);
    expect(encoded).toMatch(/^[A-Za-z_][A-Za-z_0-9]*$/);
    expect(decodeName(encoded)).toBe(text === '' ? ' ' : text);
  });

  it('is injective on a mixed sample (two texts never share a name)', () => {
    const names = SAMPLES.map(encodeName);
    expect(new Set(names).size).toBe(SAMPLES.length);
    expect(encodeName('a-b')).toBe('a_x002D_b');
    expect(encodeName('_x002D_')).toBe('_x005F_x002D_');
  });

  it('decodes a malformed escape to the replacement character, never throws', () => {
    expect(decodeName('a_xD800_b')).toBe('a\uFFFDb');
    expect(decodeName('a_x110000_b')).toBe('a\uFFFDb');
    expect(decodeName('a_x12_b')).toBe('a_x12_b');
  });

  it('names attributes by the DEXPI 2.0 rule and keeps the others under Llull_', () => {
    expect(attributeProperty('LineNumberAssignmentClass', 'text')).toBe('LineNumber');
    expect(attributeProperty('LocationSpecialization', 'enum')).toBe('Location');
    expect(attributeProperty('UpperLimitDesignPressure', 'quantity')).toBe('UpperLimitDesignPressure');
    expect(attributeProperty('AreaIsa95NameAssignmentClass', 'text')).toBe('PlantAreaName');
    expect(attributeProperty('NominalCapacity(Volume)', 'quantity')).toBe('NominalCapacityVolume');
    expect(attributeProperty('Foo', 'text')).toBe('Llull_Foo');
    expect(attributeProperty('Foo Bar', 'text')).toBe('Llull_Foo_x0020_Bar');
    expect(attributeProperty('Llull_X', 'text')).toBe('Llull_Llull_X');
    for (const [name, kind] of [
      ['LineNumberAssignmentClass', 'text'],
      ['LocationSpecialization', 'enum'],
      ['UpperLimitDesignPressure', 'quantity'],
      ['AreaIsa95NameAssignmentClass', 'text'],
      ['NominalCapacity(Volume)', 'quantity'],
      ['Foo', 'text'],
      ['Foo Bar', 'text'],
      ['Llull_X', 'text'],
      ['Set:Name', 'text'],
      ['constructor', 'text'],
    ] as const)
      expect(attributeName(attributeProperty(name, kind), kind), name).toBe(name);
  });

  it('writes unit and enumeration references and reads the unit / value at their end', () => {
    expect(unitReference('Bar')).toBe('Core/PhysicalQuantities.PressureGaugeUnit.Bar');
    expect(unitReference('Furlong')).toBe('Core/PhysicalQuantities.Unit.Furlong');
    expect(unitReference('constructor')).toBe('Core/PhysicalQuantities.Unit.constructor');
    expect(unitOfReference(unitReference('Kilowatt'))).toBe('Kilowatt');
    expect(enumReference('Location', 'CentralLocation', undefined)).toBe('Plant/Enumerations.LocationClassification.CentralLocation');
    expect(enumReference('Location', 'Field', 'Plant/Enumerations.LocationClassification.Field')).toBe(
      'Plant/Enumerations.LocationClassification.Field',
    );
    expect(enumReference('Location', 'Field', 'http://sandbox.dexpi.org/rdl/Field')).toBe(
      'Plant/Enumerations.LocationClassification.Field',
    );
    expect(valueOfReference('Plant/Enumerations.LocationClassification.Field')).toBe('Field');
  });
});
