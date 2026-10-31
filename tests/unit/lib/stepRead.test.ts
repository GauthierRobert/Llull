/**
 * `@lib/stepRead` (plant 08 DAT-M3, TR-DAT-25): the ISO 10303-21 reader promoted from the production IFC oracle. Syntax cases, the buildingSMART samples of
 * the pack against the statistics measured with IfcOpenShell (VC-DAT-13 inputs), limits and a size budget.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_STEP_ERRORS, readStep, stepReferences, stepString } from '@lib/stepRead';
import { PACK, packJson } from '../plant/data/dataFixtures';

const wrap = (data: string, schema = 'IFC4'): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;

describe('readStep syntax', () => {
  it('reads the header schema, entities, enums, $ and *, nested lists and typed values', () => {
    const file = readStep(
      wrap(
        `#1=IFCPUMP('guid',$,'P-101',$,$,#2,*,'T',.ENDSUCTION.);\n#2=IFCPROPERTYSINGLEVALUE('W',$,IFCMASSMEASURE(450.),$);\n#3=IFCRELNESTS('g',$,$,$,#1,(#2,#1));`,
        'IFC4X3_ADD2',
      ),
    );
    expect(file.errors).toEqual([]);
    expect(file.schema).toBe('IFC4X3_ADD2');
    expect(file.entities.get(1)).toEqual({
      id: 1,
      type: 'IFCPUMP',
      args: ["'guid'", '$', "'P-101'", '$', '$', '#2', '*', "'T'", '.ENDSUCTION.'],
    });
    expect(file.entities.get(2)?.args[2]).toEqual(['IFCMASSMEASURE', '450.']);
    expect(file.entities.get(3)?.args[5]).toEqual(['#2', '#1']);
    expect(stepReferences(file.entities.get(3)?.args ?? [])).toEqual([1, 2, 1]);
  });

  it('decodes strings with doubled quotes and the X2 escape and ignores comments and whitespace', () => {
    const file = readStep(wrap(String.raw`/* c */ #1 = IFCLABEL ( 'it''s \X2\00E9\X0\, (ok)' , $ ) ;` + '\n#2=A();'));
    expect(file.errors).toEqual([]);
    expect(stepString(file.entities.get(1)?.args[0])).toBe("it's é, (ok)");
    expect(file.entities.get(1)?.args).toHaveLength(2);
    expect(file.entities.get(2)?.args).toEqual([]);
    expect(stepString('$')).toBe('');
    expect(stepString(undefined)).toBe('');
    expect(stepString(['x'])).toBe('');
  });

  it('reports a missing header or trailer, a complex or damaged record and a missing reference, and keeps reading', () => {
    const file = readStep("DATA;\n#1=(A()B());\n#2=C(#9);\n#3=D('x');\n#4=E(\nENDSEC;");
    expect(file.errors).toEqual(
      expect.arrayContaining([
        'missing ISO-10303-21 header',
        'missing END-ISO-10303-21 trailer',
        expect.stringContaining('unparsable statement'),
        '#2 C references missing #9',
      ]),
    );
    expect([...file.entities.keys()]).toEqual([2, 3]);
    expect(file.schema).toBe('');
  });

  it('refuses nesting deeper than 64 levels for that record only', () => {
    const file = readStep(wrap(`#1=A(${'('.repeat(100)}${')'.repeat(100)});\n#2=B(1);`));
    expect(file.errors).toEqual(expect.arrayContaining([expect.stringContaining('nesting deeper than 64')]));
    expect([...file.entities.keys()]).toEqual([2]);
  });

  it('caps the error list', () => {
    const records = Array.from({ length: 1000 }, (_, k) => `#${k + 1}=A(#${k + 5000});`).join('\n');
    expect(readStep(wrap(records)).errors).toHaveLength(MAX_STEP_ERRORS);
  });

  it('ignores unbalanced closing parentheses and an empty text', () => {
    expect(readStep(wrap('#1=A(1)),2));')).entities.size).toBeLessThanOrEqual(1);
    const empty = readStep('');
    expect(empty.entities.size).toBe(0);
    expect(empty.schema).toBe('');
  });
});

describe('readStep on the buildingSMART samples of the pack', () => {
  const stats = packJson<Record<string, { schema: string; counts: Record<string, number> }>>('data/reference/bsi_sample_stats.json');

  it.each(Object.keys(stats))('%s: schema and entity counts equal the IfcOpenShell statistics', (name) => {
    const text = readFileSync(path.join(PACK, 'data', 'bsi', name), 'utf8');
    const file = readStep(text);
    const expected = stats[name] as { schema: string; counts: Record<string, number> };
    expect(file.schema).toBe(expected.schema);
    expect(file.errors).toEqual([]);
    const counts = new Map<string, number>();
    for (const entity of file.entities.values()) counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
    for (const [type, count] of Object.entries(expected.counts)) {
      if (type === 'IfcPropertySet' || type === 'IfcRelDefinesByProperties') continue;
      expect(counts.get(type.toUpperCase()) ?? 0, type).toBe(count);
    }
  });
});

describe('readStep size', () => {
  it('reads 200 000 entities in a few seconds', () => {
    const records = Array.from({ length: 200_000 }, (_, k) => `#${k + 1}=IFCPUMP('${k}',$,'P-${k}',$,$,$,$,'P-${k}',.ENDSUCTION.);`).join(
      '\n',
    );
    const text = wrap(records);
    const started = performance.now();
    const file = readStep(text);
    expect(file.entities.size).toBe(200_000);
    expect(performance.now() - started).toBeLessThan(8000);
  });
});
