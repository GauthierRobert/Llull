/** Length units of a Part 21 text per representation context, and the reader's linear-time guarantee on hostile input (aerospace 04 review). */
import { describe, expect, it } from 'vitest';
import { summarizeStep21 } from '@lib/step21/summary';
import { canonicalizeStep21 } from '@lib/step21/canonical';
import { parseRecords } from '@lib/step21/records';
import { groupFileGvp } from '@core/commands/exchange/fileGvp';

/** An SI millimetre unit record FIRST, then a context whose unit is a conversion-based INCH defined as 0.0254 METRE, carrying the GVP. */
const SI_BEFORE_CONVERSION = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));
ENDSEC;
DATA;
#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#2=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));
#3=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.0254),#2);
#4=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);
#5=(CONVERSION_BASED_UNIT('INCH',#3)LENGTH_UNIT()NAMED_UNIT(#4));
#6=( GEOMETRIC_REPRESENTATION_CONTEXT(3)
  GLOBAL_UNIT_ASSIGNED_CONTEXT ((#5)) REPRESENTATION_CONTEXT('c','3d') );
#7=( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('m','3d') );
#10=PRODUCT('p','Part','',());
#11=PRODUCT_DEFINITION_FORMATION('','',#10);
#12=PRODUCT_DEFINITION('design','',#11,$);
#13=PRODUCT_DEFINITION_SHAPE('','',#12);
#14=PROPERTY_DEFINITION('geometric validation property','',#13);
#15=MEASURE_REPRESENTATION_ITEM('volume measure',VOLUME_MEASURE(8.),#99);
#16=REPRESENTATION('',(#15),#6);
#17=PROPERTY_DEFINITION_REPRESENTATION(#14,#16);
ENDSEC;
END-ISO-10303-21;
`;

describe('step21 length unit per representation context', () => {
  it('multiplies a conversion-based unit by its own unit: 0.0254 + METRE is 25.4 mm, even after an SI millimetre record', () => {
    const summary = summarizeStep21(SI_BEFORE_CONVERSION);
    const [gvp] = summary.geometricValidationProperties;
    expect(gvp?.lengthUnit).toEqual({ name: 'inch', mmPerUnit: 25.4 });
    const [group] = groupFileGvp(summary, 1);
    expect(group?.volume).toBeCloseTo(8 * 25.4 ** 3, 6);
  });

  it('uses the SI millimetre unit when the GVP representation names it, whatever the file order', () => {
    const text = SI_BEFORE_CONVERSION.replace("#16=REPRESENTATION('',(#15),#6)", "#16=REPRESENTATION('',(#15),#7)");
    expect(summarizeStep21(text).geometricValidationProperties[0]?.lengthUnit).toEqual({ name: 'mm', mmPerUnit: 1 });
    expect(groupFileGvp(summarizeStep21(text), 1)[0]?.volume).toBe(8);
  });

  it('falls back to the global unit when a representation names no context unit', () => {
    const text = SI_BEFORE_CONVERSION.replace("#16=REPRESENTATION('',(#15),#6)", "#16=REPRESENTATION('',(#15),#99)");
    const summary = summarizeStep21(text);
    expect(summary.geometricValidationProperties[0]?.lengthUnit).toBeNull();
    expect(summary.lengthUnit).toEqual({ name: 'inch', mmPerUnit: 25.4 });
    expect(groupFileGvp(summary, 1)[0]?.volume).toBeCloseTo(8 * 25.4 ** 3, 6);
  });

  it('reads a conversion unit whose measure unit is millimetre (25.4 + MILLI METRE)', () => {
    const text = SI_BEFORE_CONVERSION.replace('LENGTH_MEASURE(0.0254),#2', 'LENGTH_MEASURE(25.4),#1');
    expect(summarizeStep21(text).lengthUnit?.mmPerUnit).toBe(25.4);
  });
});

describe('step21 reader is linear on hostile input', () => {
  const MB = 1_000_000;
  const within = (millis: number, work: () => unknown): void => {
    const started = performance.now();
    work();
    expect(performance.now() - started).toBeLessThan(millis);
  };
  const wrap = (data: string): string => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;

  it.each([
    ['a 1 MB quoted string', `#1=PRODUCT('${'A'.repeat(MB)}','n','',());`],
    ['a 1 MB unterminated string', `#1=PRODUCT('${'A'.repeat(MB)}`],
    ['a 1 MB run of quotes', `#1=PRODUCT(${"'".repeat(MB)});`],
    ['a 1 MB digit run', `#1=MEASURE_REPRESENTATION_ITEM('v',VOLUME_MEASURE(${'1'.repeat(MB)}),#2);`],
    ['a 1 MB digit run after #', `#1=X(#${'7'.repeat(MB)});`],
    ['a 1 MB uppercase identifier', `#1=${'A'.repeat(MB)};`],
    ['a 1 MB complex record of names', `#1=(${'A()'.repeat(MB / 3)});`],
    ['1 MB of whitespace before DATA', `${'\n'.repeat(MB)}`],
    ['1 MB of dots and digits', `#1=X(${'1.'.repeat(MB / 2)});`],
  ])('summarize / canonicalize / parse stay under a second on %s', (_label, data) => {
    const text = wrap(data);
    within(1000, () => summarizeStep21(text));
    within(1000, () => parseRecords(text));
    within(1000, () => canonicalizeStep21(text));
  });

  it('a 1 MB run of newlines before the DATA keyword does not go quadratic', () => {
    within(1000, () => parseRecords(`${'\n'.repeat(MB)}DATA;\n#1=X();\nENDSEC;`));
  });

  it('counts a census type named inside a string or a nested attribute as nothing, and the top-level name once', () => {
    const summary = summarizeStep21(
      wrap(
        "#1=ADVANCED_FACE('DATUM(',(#2),#3,.T.);\n#2=(DATUM('A')TOLERANCE_ZONE());\n#3=PRODUCT('FLATNESS_TOLERANCE(','','',(DATUM_SYSTEM()));",
      ),
    );
    expect(summary.entityCensus).toEqual({ ADVANCED_FACE: 1, DATUM: 1, PRODUCT: 1, TOLERANCE_ZONE: 1 });
  });
});

describe('canonicalizeStep21 on deep and broken graphs', () => {
  it('walks a 100000-record reference chain without recursing, keeps the graph, and is idempotent', () => {
    const depth = 100_000;
    const records = Array.from({ length: depth }, (_, index) => `#${index + 1}=NODE('n',#${index + 2});`);
    records.push(`#${depth + 1}=LEAF('end');`);
    const text = `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${records.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
    const started = performance.now();
    const once = canonicalizeStep21(text);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(parseRecords(once).bodies.size).toBe(depth + 1);
    expect(canonicalizeStep21(once)).toBe(once);
  });

  it('returns the input text unchanged when it holds no records or no DATA section', () => {
    expect(canonicalizeStep21('not a step file')).toBe('not a step file');
    expect(canonicalizeStep21('#1=A();')).toBe('#1=A();');
  });

  it('a reference cycle keeps every record', () => {
    const text = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=A(#2);\n#2=B(#1);\nENDSEC;\nEND-ISO-10303-21;\n';
    expect(parseRecords(canonicalizeStep21(text)).bodies.size).toBe(2);
  });
});
