/** The independent Part 21 reader (aerospace 04 TR-XCH-18): records, schema / unit / GVP / census, canonical numbering. */
import { describe, expect, it } from 'vitest';
import { entityName, parseRecords, referencesOf, stringsOf } from '@lib/step21/records';
import { fileSchemaOf, summarizeStep21 } from '@lib/step21/summary';
import { canonicalizeStep21 } from '@lib/step21/canonical';
import { fakeStepText } from '../../helpers/fakeXdeKernel';

describe('Part 21 records', () => {
  const text = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }'));",
    'ENDSEC;',
    'DATA;',
    "#1 = PRODUCT('a;b #9 ''quoted''','n', /* comment; #7 */ '',(#2));",
    '#2 = (',
    '  A()   B(1.,2.)',
    ');',
    "#3=CARTESIAN_POINT('p',(1.E+03,-0.5,.25));",
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');

  it('splits records outside strings and comments, collapsing whitespace', () => {
    const { bodies } = parseRecords(text);
    expect([...bodies.keys()]).toEqual([1, 2, 3]);
    expect(bodies.get(1)).toBe("PRODUCT('a;b #9 ''quoted''','n', '',(#2))");
    expect(bodies.get(2)).toBe('( A() B(1.,2.) )');
    expect(entityName(bodies.get(1) ?? '')).toBe('PRODUCT');
    expect(entityName(bodies.get(2) ?? '')).toBe('(complex)');
    expect(stringsOf(bodies.get(1) ?? '')).toEqual(["a;b #9 'quoted'", 'n', '']);
    expect(referencesOf("PRODUCT('x #4','y',(#2,#3))")).toEqual([4, 2, 3]);
    expect(fileSchemaOf(text)).toBe('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }');
  });

  it('tolerates garbage, a missing DATA section and an unterminated record', () => {
    expect(parseRecords('garbage').bodies.size).toBe(0);
    expect(parseRecords('#1 = A();\n#2 = B(').bodies.size).toBe(1);
    expect(parseRecords('DATA;\n# = ;\n#x = A();\n#4 A();').bodies.size).toBe(0);
    expect(fileSchemaOf('nothing')).toBeNull();
    expect(summarizeStep21('garbage')).toMatchObject({ fileSchema: null, lengthUnit: null, records: 0, geometricValidationProperties: [] });
  });
});

describe('summarizeStep21', () => {
  it('reads the unit with its exact factor, products and the geometric validation properties per product', () => {
    const summary = summarizeStep21(
      fakeStepText(
        [
          { name: 'Part A', volume: 8, area: 24, centroid: [1, 2, 3] },
          { name: 'Part B', volume: 1.5e3, area: 8, centroid: [0, 0, 0] },
        ],
        { unit: 'inch' },
      ),
    );
    expect(summary.lengthUnit).toEqual({ name: 'inch', mmPerUnit: 25.4 });
    expect(summary.products).toEqual(['Part A', 'Part B']);
    expect(summary.validationPropertyCounts.geometric).toBe(6);
    const a = summary.geometricValidationProperties.filter((entry) => entry.product === 'Part A');
    expect(a.map((entry) => entry.description)).toEqual(['volume', 'surface area', 'centroid']);
    expect(a[0]?.values).toEqual([{ item: 'volume measure', measure: 'VOLUME_MEASURE', value: 8 }]);
    expect(a[2]?.values[0]).toMatchObject({ item: 'centre point', value: [1, 2, 3] });
    expect(a[0]?.definitionTarget).toBe('PRODUCT_DEFINITION_SHAPE');
    expect(summary.entityCensus['PRODUCT']).toBe(2);
  });

  it('reads SI prefixes, unknown units and files without validation properties', () => {
    expect(summarizeStep21(fakeStepText([], { unit: 'mm' })).lengthUnit).toEqual({ name: 'mm', mmPerUnit: 1 });
    const metres = 'DATA;\n#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );\nENDSEC;';
    expect(summarizeStep21(metres).lengthUnit).toEqual({ name: 'm', mmPerUnit: 1000 });
    const feet = "DATA;\n#1 = ( CONVERSION_BASED_UNIT('FOOT',#2) LENGTH_UNIT() NAMED_UNIT(#3) );\nENDSEC;";
    expect(summarizeStep21(feet).lengthUnit).toEqual({ name: 'foot', mmPerUnit: 304.8 });
    expect(summarizeStep21('DATA;\n#1 = X();\nENDSEC;').lengthUnit).toBeNull();
    const plain = summarizeStep21(fakeStepText([{ name: 'P', volume: 1, area: 1, centroid: [0, 0, 0] }], { withProperties: false }));
    expect(plain.geometricValidationProperties).toEqual([]);
  });
});

describe('canonicalizeStep21', () => {
  /** Two numberings / emission orders of the same graph (what two OCCT runs can produce). */
  const A = [
    'DATA;',
    "#1 = PRODUCT('p','p','',(#2));",
    "#2 = CONTEXT('c');",
    "#3 = SHAPE('s',(#4,#5));",
    '#4 = POINT(1.,2.);',
    '#5 = POINT(3.,4.);',
    "#6 = TEXT('see #1; ref');",
    'ENDSEC;',
  ];
  const B = [
    'DATA;',
    "#40 = TEXT('see #1; ref');",
    '#30 = POINT(3.,4.);',
    '#20 = POINT(1.,2.);',
    "#10 = SHAPE('s',(#20,#30));",
    "#7 = CONTEXT('c');",
    "#5 = PRODUCT('p','p','',(#7));",
    'ENDSEC;',
  ];
  const wrap = (data: string[]): string => `ISO-10303-21;\nHEADER;\nENDSEC;\n${data.join('\n')}\nEND-ISO-10303-21;\n`;

  it('gives one text for any numbering of the same graph, keeps references inside strings and list order', () => {
    const first = canonicalizeStep21(wrap(A));
    expect(canonicalizeStep21(wrap(B))).toBe(first);
    expect(canonicalizeStep21(first)).toBe(first);
    expect(first).toContain("TEXT('see #1; ref')");
    expect(first.indexOf('POINT(1.,2.)')).toBeLessThan(first.indexOf('POINT(3.,4.)'));
    expect(first.startsWith('ISO-10303-21;\nHEADER;')).toBe(true);
    expect(first.endsWith('ENDSEC;\nEND-ISO-10303-21;\n')).toBe(true);
  });

  it('keeps cycles, dangling references and unparseable text', () => {
    const cyclic = wrap(['DATA;', '#1 = A(#2);', '#2 = B(#1);', '#3 = C(#9);', 'ENDSEC;']);
    const out = canonicalizeStep21(cyclic);
    expect(out).toContain('A(');
    expect(out).toContain('B(');
    expect(out).toContain('C(#9)');
    expect(canonicalizeStep21('garbage')).toBe('garbage');
    expect(canonicalizeStep21('DATA;\n#1 = A();')).toBe('DATA;\n#1 = A();');
  });
});
