/** Hostile-input table: exchange text formats (STEP Part 21, IGES, DXF, survey text / DXF, `.lld` designs). */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseDxf } from '@lib/dxfRead';
import { summarizeIges } from '@lib/iges/summary';
import { parseRecords } from '@lib/step21/records';
import { summarizeStep21 } from '@lib/step21/summary';
import { DesignError } from '@design/errors';
import { parseDesign } from '@design/parse';
import { parseSurvey } from '@aec/civil/survey/surveyParse';
import { fakeIgesText } from '../fakeXdeKernel';
import { asText, repeated, type HostileReader } from './types';

const stepRecord = (k: number): string =>
  `#${3 * k + 1}=CARTESIAN_POINT('p${k}',(${k}.5,0.,1.E-3));\n#${3 * k + 2}=PRODUCT('id${k}','name ''${k}''','',(#${3 * k + 3}));\n#${3 * k + 3}=PROPERTY_DEFINITION('geometric validation property','',#${3 * k + 1});\n`;
const stepBuild = (records: number): string =>
  repeated(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nFILE_NAME('a','2026',(''),(''),'','','');\nFILE_SCHEMA(('AP242'));\nENDSEC;\nDATA;\n",
    stepRecord,
    'ENDSEC;\nEND-ISO-10303-21;\n',
    records,
  );
const stepNest = (depth: number): string => `DATA;\n#1=A(${'('.repeat(depth)}${')'.repeat(depth)});\n`;
const stepExtras = [
  { name: 'many unterminated strings', input: () => "#1=A('".repeat(200_000) },
  { name: 'many unterminated comments', input: () => 'DATA;\n' + '#1=A(/*'.repeat(200_000) },
  { name: 'many DATA; keywords', input: () => 'DATA ;\n'.repeat(300_000) },
  { name: 'many record openers without bodies', input: () => '#'.repeat(1_000_000) },
  { name: 'huge record ids', input: () => 'DATA;\n' + '#99999999999999999999999=A();\n'.repeat(50_000) },
  { name: 'many unterminated records', input: () => 'DATA;\n' + '#1=A('.repeat(300_000) },
];

const igesBuild = (records: number): string =>
  fakeIgesText(Array.from({ length: records }, (_, k) => [186, 514, 510, 110, 406][k % 5] as number));

const dxfPoint = (k: number): string => `0\nPOINT\n8\nL${k % 7}\n10\n${k}.5\n20\n${k}\n30\n${k + 1}.25\n`;
const dxfBuild = (records: number): string =>
  repeated('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n', dxfPoint, '0\nENDSEC\n0\nEOF\n', records);
const dxfLines = (records: number): string =>
  repeated(
    '0\nSECTION\n2\nENTITIES\n',
    (k) => `0\nLINE\n8\n0\n10\n${k}\n20\n0\n11\n${k}\n21\n5\n0\nLWPOLYLINE\n8\n0\n90\n2\n10\n0\n20\n${k}\n10\n3\n20\n4\n`,
    '0\nENDSEC\n0\nEOF\n',
    records,
  );
const dxfExtras = [
  { name: 'odd number of lines (code without value)', input: () => dxfBuild(50) + '0' },
  { name: 'codes that are not integers', input: () => 'abc\nvalue\n'.repeat(200_000) },
  { name: 'many SECTION openers', input: () => '0\nSECTION\n2\nENTITIES\n'.repeat(100_000) },
  {
    name: 'huge vertex counts',
    input: () => dxfBuild(3).replace('0\nENDSEC\n0\nEOF', '0\nLWPOLYLINE\n90\n99999999999\n0\nENDSEC\n0\nEOF'),
  },
];

const surveyBuild = (records: number): string =>
  repeated('P,E,N,Z,D\n', (k) => `${k},${k}.5,${k * 2},${k % 9}.25,code ${k}\n`, '', records);

const lldBuild = (records: number): string =>
  repeated(
    'design part units=mm\nparam w = 80mm\n',
    (k) => `add_box b${k} size=[w, 10, ${k}] color="#c8553d" # note\n`,
    'check volume of=b0 expect ~= 1600 ± 2%\n',
    records,
  );

/** `DesignError` is the documented syntax refusal of the `.lld` parser; anything else thrown is a defect. */
const readDesign = (text: string): unknown => {
  try {
    return parseDesign(text);
  } catch (error) {
    if (error instanceof DesignError) return { refusal: error.message };
    throw error;
  }
};

const created = (result: unknown): boolean => (result as { affected: string[] }).affected.length > 0;

export const EXCHANGE_READERS: readonly HostileReader[] = [
  {
    name: 'step: parseRecords (Part 21 reader)',
    covers: ['core/src/lib/step21/records.ts:parseRecords'],
    input: 'text',
    build: stepBuild,
    nest: stepNest,
    extra: stepExtras,
    read: (input) => parseRecords(asText(input)),
    accepts: (result) => (result as { bodies: Map<number, string> }).bodies.size === 9,
  },
  {
    name: 'step: summarizeStep21',
    covers: ['core/src/lib/step21/summary.ts:summarizeStep21', 'import_step_exact'],
    input: 'text',
    build: stepBuild,
    nest: stepNest,
    extra: stepExtras,
    read: (input) => summarizeStep21(asText(input)),
    accepts: (result) => (result as { products: string[] }).products.length === 3,
  },
  {
    name: 'iges: summarizeIges',
    covers: ['core/src/lib/iges/summary.ts:summarizeIges', 'import_iges'],
    input: 'text',
    build: igesBuild,
    extra: [
      { name: 'many Hollerith headers', input: () => '999999999H'.repeat(200_000).padEnd(72) + 'G      1\n' },
      { name: 'long global section', input: () => `${'1,'.repeat(36).padEnd(72)}G${'1'.padStart(7)}\n`.repeat(20_000) },
    ],
    read: (input) => summarizeIges(asText(input)),
    accepts: (result) => (result as { entities: number }).entities === 3,
  },
  {
    name: 'dxf: parseDxf (points, header)',
    covers: ['core/src/lib/dxfRead.ts:parseDxf'],
    input: 'text',
    build: dxfBuild,
    extra: dxfExtras,
    read: (input) => parseDxf(asText(input)),
    accepts: (result) => result !== null,
  },
  {
    name: 'dxf: parseDxf (lines, lwpolylines)',
    covers: [],
    input: 'text',
    build: dxfLines,
    extra: dxfExtras,
    read: (input) => parseDxf(asText(input)),
    accepts: (result) => result !== null,
  },
  {
    name: 'dxf: import_dxf (execute)',
    covers: ['import_dxf'],
    input: 'text',
    build: dxfLines,
    extra: dxfExtras,
    read: (input) => execute(createEmptyDocument(), 'import_dxf', { text: asText(input) }),
    accepts: created,
  },
  {
    name: 'dxf: import_survey_dxf (execute)',
    covers: ['import_survey_dxf'],
    input: 'text',
    build: dxfBuild,
    extra: dxfExtras,
    read: (input) => execute(createEmptyDocument(), 'import_survey_dxf', { text: asText(input) }),
    accepts: created,
  },
  {
    name: 'survey: parseSurvey (PENZD text)',
    covers: ['domain-aec/src/civil/survey/surveyParse.ts:parseSurvey'],
    input: 'text',
    build: surveyBuild,
    read: (input) => parseSurvey(asText(input), 'PENZD'),
    accepts: (result) => (result as { points: unknown[] }).points.length === 3,
  },
  {
    name: 'survey: import_survey_points (execute)',
    covers: ['import_survey_points'],
    input: 'text',
    build: surveyBuild,
    read: (input) => execute(createEmptyDocument(), 'import_survey_points', { text: asText(input), format: 'PENZD' }),
    accepts: created,
  },
  {
    name: 'design: parseDesign (.lld)',
    covers: ['design-lang/src/parse.ts:parseDesign', 'design-lang/src/parse.ts:parseValue'],
    input: 'text',
    build: lldBuild,
    nest: (depth) => `add_box b size=${'['.repeat(depth)}1${']'.repeat(depth)}\n`,
    extra: [
      { name: 'deeply nested for blocks', input: () => 'for i in 0..2 {\n'.repeat(20_000) },
      { name: 'many unclosed brackets', input: () => 'add_box b size=' + '['.repeat(100_000) },
      { name: 'many unterminated strings', input: () => 'add_box b name="'.repeat(50_000) },
    ],
    read: (input) => readDesign(asText(input)),
    accepts: (result) => Array.isArray(result),
  },
];
