/** Hostile-input table: exchange text formats (STEP Part 21, IGES, DXF, survey text / DXF, `.lld` designs). */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseDxf } from '@lib/dxfRead';
import { summarizeIges } from '@lib/iges/summary';
import { parseRecords } from '@lib/step21/records';
import { summarizeStep21 } from '@lib/step21/summary';
import { DesignError } from '@design/errors';
import { parseDesign } from '@design/parse';
import { buildValueExpr } from '@design/valueExpr';
import { evaluateValue } from '@design/valueEval';
import { coerceValue } from '@design/valueSchema';
import { loadModules } from '@design/modules';
import { runDesign } from '@design/run';
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
/** DXF text from flat `code, value, code, value…` arguments. */
const groups = (...flat: Array<string | number>): string => flat.join('\n') + '\n';
const inEntities = (...flat: Array<string | number>): string => groups(0, 'SECTION', 2, 'ENTITIES', ...flat, 0, 'ENDSEC', 0, 'EOF');
/** A HATCH (square), a SPLINE (fit points) and a full ELLIPSE per record: the readers of dxfReadShapes. */
// prettier-ignore
const dxfShapes = (records: number): string =>
  repeated(
    groups(0, 'SECTION', 2, 'ENTITIES'),
    (k) =>
      groups(0, 'HATCH', 8, 'H', 10, 0, 20, 0, 30, 0, 70, 1, 91, 1, 92, 3, 72, 0, 73, 1, 93, 4, 10, k, 20, 0, 10, k + 1, 20, 0, 10, k + 1, 20, 1, 10, k, 20, 1, 97, 0, 75, 0, 76, 1, 98, 0) +
      groups(0, 'SPLINE', 8, 'S', 70, 0, 11, k, 21, 0, 11, k, 21, 3, 11, k + 2, 21, 3) +
      groups(0, 'ELLIPSE', 8, 'E', 10, k, 20, 0, 11, 2, 21, 0, 40, 0.5, 41, 0, 42, 6.283185307179586),
    groups(0, 'ENDSEC', 0, 'EOF'),
    records,
  );
const dxfShapeExtras = [
  { name: 'HATCH with astronomical path / vertex counts', input: () => inEntities(0, 'HATCH', 91, 99999999999, 92, 2, 93, 99999999999) },
  {
    name: 'HATCH with thousands of empty paths',
    input: () =>
      groups(0, 'SECTION', 2, 'ENTITIES', 0, 'HATCH', 91, 4999) + groups(92, 3, 72, 0, 93, 2).repeat(4999) + groups(0, 'ENDSEC', 0, 'EOF'),
  },
  { name: 'SPLINE with absurd degree and knot counts', input: () => inEntities(0, 'SPLINE', 71, 99999999, 72, 99999999, 73, 3) },
  {
    name: 'SPLINE with 200k control points',
    input: () => groups(0, 'SECTION', 2, 'ENTITIES', 0, 'SPLINE', 71, 3) + '10\n0\n20\n0\n'.repeat(200_000) + groups(0, 'ENDSEC', 0, 'EOF'),
  },
  {
    name: 'SPLINE with NaN knots',
    input: () => inEntities(0, 'SPLINE', 71, 1, 40, 'NaN', 40, 0, 40, 1, 40, 1, 10, 0, 20, 0, 10, 1, 20, 1),
  },
  {
    name: 'SPLINE with a zero weight, decreasing knots and +-1e308 knots',
    input: () =>
      inEntities(
        ...[0, 'SPLINE', 71, 1, 40, 0, 40, 0, 40, 1, 40, 1, 10, 0, 20, 0, 10, 1, 20, 1, 41, 1, 41, 0],
        ...[0, 'SPLINE', 71, 1, 40, 1, 40, 0, 40, 1, 40, 1, 10, 0, 20, 0, 10, 1, 20, 1],
        ...[0, 'SPLINE', 71, 1, 40, -1e308, 40, -1e308, 40, 1e308, 40, 1e308, 10, 0, 20, 0, 10, 1, 20, 1],
      ),
  },
  {
    name: 'a self-referencing block of 50 empty INSERTs',
    input: () =>
      groups(
        0,
        'SECTION',
        2,
        'BLOCKS',
        0,
        'BLOCK',
        2,
        'B',
        10,
        0,
        20,
        0,
        30,
        0,
        ...Array.from({ length: 50 }, () => [0, 'INSERT', 2, 'B', 8, '0']).flat(),
      ) + groups(0, 'ENDBLK', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 2, 'B', 8, '0', 0, 'ENDSEC', 0, 'EOF'),
  },
  {
    name: 'ELLIPSE with zero / negative / NaN ratio',
    input: () => inEntities(0, 'ELLIPSE', 11, 1, 40, 0, 0, 'ELLIPSE', 11, 1, 40, -3, 0, 'ELLIPSE', 11, 'NaN', 40, 'NaN'),
  },
];
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

/** The `.lld` value pipeline of apply_design / check_design / expand_design (text -> tree -> value -> JSON), without a kernel. */
const readValue = (text: string): unknown => {
  try {
    const expr = buildValueExpr(text, { units: 'mm', paramKey: null, line: 1 });
    const host = { line: 1, vars: {}, parameters: { w: 2 }, functions: new Map(), alias: () => undefined };
    return { value: coerceValue(evaluateValue(expr, host), {}, 'value', 1) };
  } catch (error) {
    if (error instanceof DesignError) return { refusal: error.message };
    throw error;
  }
};

const doubling = (levels: number): string =>
  `let a0 = "xxxxxxxxxx" in ${Array.from({ length: levels }, (_, k) => `let a${k + 1} = a${k} + a${k} in `).join('')}len(a${levels})`;

/** `{ source, files }` JSON through parse, module loading and a kernel-free run (add_box lines): a DesignError is the documented refusal. */
const readModules = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { refusal: 'not an object' };
    const { source, files } = parsed as { source?: unknown; files?: unknown };
    if (typeof source !== 'string' || typeof files !== 'object' || files === null) return { refusal: 'no source / files' };
    const statements = parseDesign(source);
    return runDesign(createEmptyDocument(), statements, undefined, undefined, loadModules(statements, files as Record<string, string>));
  } catch (error) {
    if (error instanceof DesignError || error instanceof SyntaxError) return { refusal: error.message };
    throw error;
  }
};

const BOX = 'module m() {\n  add_box b size=[1, 1, 1]\n  export b\n}\n';
const moduleCase = (source: string, files: Record<string, string>): string => JSON.stringify({ source, files });
const wide = (count: number): string =>
  moduleCase(
    Array.from({ length: count }, (_, k) => `use "w${k}.lld" as w${k}`).join('\n'),
    Object.fromEntries(Array.from({ length: count }, (_, k) => [`w${k}.lld`, BOX])),
  );

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
    name: 'dxf: import_dxf (HATCH, SPLINE, ELLIPSE)',
    covers: ['core/src/lib/dxfReadShapes.ts:readHatch', 'core/src/lib/dxfReadShapes.ts:readSpline'],
    input: 'text',
    build: dxfShapes,
    extra: [...dxfExtras, ...dxfShapeExtras],
    read: (input) => execute(createEmptyDocument(), 'import_dxf', { text: asText(input) }),
    accepts: created,
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
  {
    name: 'design: value language (apply_design, check_design, expand_design)',
    covers: [
      'design-lang/src/valueExpr.ts:buildValueExpr',
      'design-lang/src/valueEval.ts:evaluateValue',
      'design-lang/src/valueSchema.ts:coerceValue',
      'apply_design',
      'check_design',
      'expand_design',
    ],
    input: 'text',
    build: (records) => `[for i in 0..<${records}: {k: i * w, s: "a" + "b"}]`,
    nest: (depth) => `${'['.repeat(depth)}1${']'.repeat(depth)}`,
    maxRecords: 1 << 12,
    extra: [
      { name: 'range-bodied comprehension', input: () => 'len([for i in 0..<3000: 0..<100000])' },
      { name: 'zip bomb', input: () => '[for i in 0..<100000: zip(0..<100000, 0..<100000)][0][0]' },
      { name: 'sum of a big list in a loop', input: () => 'let a = 0..<100000 in len([for i in 0..<20000: sum(a)])' },
      { name: 'shared list repeated by coerce', input: () => 'let a = 0..<100000 in [for i in 0..<1000: a]' },
      { name: 'string doubling', input: () => doubling(30) },
      { name: 'flat operator chain', input: () => `1${'+1'.repeat(50_000)}` },
      { name: 'flat index chain', input: () => `[[0]]${'[0]'.repeat(20_000)}` },
      { name: 'reserved object key', input: () => '{__proto__: 1}' },
      { name: 'duplicate object key', input: () => '{a: 1, a: 2}' },
      { name: 'unknown names and calls', input: () => 'zzz(1, qqq.rrr[3])' },
    ],
    read: (input) => readValue(asText(input)),
    accepts: (result) => Array.isArray((result as { value?: unknown }).value),
  },
  {
    name: 'design: run budget (nested loops, near-limit values; apply_design)',
    covers: [],
    input: 'text',
    build: (records) => `for i in 0..${Math.min(records, 60) - 1} {\n  add_box b{i} size=[1, 1, 1]\n}\n`,
    maxRecords: 60,
    extra: [
      {
        name: 'nested empty loops',
        input: () => 'for a in 0..999 {\n for b in 0..999 {\n for c in 0..999 {\n for d in 0..999 {\n }\n }\n }\n}\n',
      },
      {
        name: 'many near-limit values',
        input: () => Array.from({ length: 40 }, (_, k) => `add_box b${k} size=[len([for i in 0..<9000: sum(0..<90)]), 1, 1]`).join('\n'),
      },
    ],
    read: (input) => {
      try {
        const statements = parseDesign(asText(input));
        return runDesign(createEmptyDocument(), statements);
      } catch (error) {
        if (error instanceof DesignError) return { refusal: error.message };
        throw error;
      }
    },
    accepts: (result) => typeof (result as { commands?: number }).commands === 'number',
  },
  {
    name: 'design: modules (loadModules, use ... as ..., apply_design)',
    covers: ['design-lang/src/modules.ts:loadModules', 'design-lang/src/run.ts:runDesign'],
    input: 'text',
    build: (records) => wide(Math.min(records, 60)),
    maxRecords: 1 << 8,
    extra: [
      {
        name: 'import cycle',
        input: () =>
          moduleCase('use "a.lld" as a', {
            'a.lld': 'module a() {\n  use "b.lld" as b\n}\n',
            'b.lld': 'module b() {\n  use "a.lld" as a\n}\n',
          }),
      },
      {
        name: 'depth 9 chain',
        input: () =>
          moduleCase(
            'use "m0.lld" as x',
            Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`m${k}.lld`, `module m${k}() {\n  use "m${k + 1}.lld" as x\n}\n`])),
          ),
      },
      { name: '65 files', input: () => wide(65) },
      { name: '300 KB module', input: () => moduleCase('use "big.lld" as b', { 'big.lld': `module big() {\n}\n${'#'.repeat(300_000)}` }) },
      {
        name: 'multibyte module over the byte limit',
        input: () => moduleCase('use "big.lld" as b', { 'big.lld': `module big() {\n}\n# ${'é'.repeat(140_000)}` }),
      },
      { name: 'NUL path', input: () => moduleCase('use "a\\u0000.lld" as a', {}) },
      { name: 'backslash path', input: () => moduleCase('use "a\\\\b.lld" as a', {}) },
      { name: 'drive-letter path', input: () => moduleCase('use "C:/x.lld" as a', {}) },
      {
        name: 'diamond ladder (2^20 instances)',
        input: () =>
          moduleCase(
            'use "d0.lld" as d',
            Object.fromEntries(
              Array.from({ length: 21 }, (_, k) => [
                `d${k}.lld`,
                k === 20 ? BOX : `module d${k}() {\n  use "d${k + 1}.lld" as l\n  use "d${k + 1}.lld" as r\n}\n`,
              ]),
            ),
          ),
      },
      { name: 'many unclosed modules', input: () => moduleCase('use "u.lld" as u', { 'u.lld': 'module u() {\n'.repeat(5000) }) },
      { name: 'not JSON', input: () => 'use' },
    ],
    read: (input) => readModules(asText(input)),
    accepts: (result) => typeof (result as { commands?: number }).commands === 'number',
  },
];
