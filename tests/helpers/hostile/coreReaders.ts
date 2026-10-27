/** Hostile-input table: core readers of user text (fonts, expressions, units, images, material libraries, saved documents) and PLM / protocol readers. */
import { execute } from '@core/commands/registry';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Entity } from '@core/model/types';
import { evaluateExpression } from '@lib/expression';
import { compileExpression } from '@lib/expressionProgram';
import { parseFont } from '@lib/font/font';
import { parseHexRgb } from '@lib/isHexColor';
import { parseImageDataUrl } from '@lib/imageDataUrl';
import { parseUnit } from '@lib/quantity';
import { parseIsoMetric, parseThreadDimensions } from '@lib/threadForm';
import { parseBody } from '@plm/pdm/args';
import { readPdm } from '@plm/pdm/read';
import { parseInstant } from '@plm/pdm/part21';
import { parseQuery } from '@protocol/discoveryRank';
import { parseCommandResponse } from '@protocol/restProtocol';
import { libraryFile } from '../../unit/materials/support';
import { firaBytes } from '../../unit/wrap/fixtures';
import { run as plmRun } from '../../unit/plm/scenarioRunner';
import { inWork } from '../../unit/plm/fixtures';
import { asBytes, asText, orRefusal, repeated, type HostileReader } from './types';

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** `JSON.parse` whose syntax / depth errors are refusals (the readers under test take the parsed value). */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return undefined;
    throw error;
  }
};

let pdmBase: string | null = null;
/** The PDM export of a released-style item (`export_step_pdm`), once. */
const pdmText = (): string => {
  if (pdmBase === null) {
    const result = plmRun(inWork(), 'export_step_pdm', { organization: { id: 'CAGE-1A2B3', name: 'Acme Aero' } });
    pdmBase = (result.data as { step: string }).step;
  }
  return pdmBase;
};
const pdmBuild = (records: number): string => {
  const base = pdmText();
  const at = base.lastIndexOf('ENDSEC;');
  const filler = Array.from({ length: records }, (_, k) => `#${900000 + k}=NEXT_ASSEMBLY_USAGE_OCCURRENCE('u${k}','','',#1,#2,$);\n`).join(
    '',
  );
  return base.slice(0, at) + filler + base.slice(at);
};

const libraryBuild = (records: number): string => {
  const file = libraryFile();
  const first = (file['materials'] as Record<string, unknown>[])[0] as Record<string, unknown>;
  return JSON.stringify({ ...file, materials: Array.from({ length: records + 1 }, (_, k) => ({ ...first, id: `m${k}`, name: `m${k}` })) });
};

let boxEntity: Entity | null = null;
const documentBuild = (records: number): string => {
  boxEntity ??= (() => {
    const result = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    return result.document.entities[result.affected[0] as string] as Entity;
  })();
  const base: CadDocument = createEmptyDocument();
  const ids = Array.from({ length: records }, (_, k) => `box-${k}`);
  const doc: CadDocument = { ...base, entities: Object.fromEntries(ids.map((id) => [id, { ...(boxEntity as Entity), id }])), order: ids };
  return serializeDocument(doc);
};

const png1x1 = (): Uint8Array =>
  Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  );

export const CORE_READERS: readonly HostileReader[] = [
  {
    name: 'core: parseFont (TrueType / OpenType)',
    covers: [
      'core/src/lib/font/font.ts:parseFont',
      'core/src/lib/font/stroke.ts:readStrokeFont',
      'core/src/lib/font/cff.ts:readCff',
      'core/src/lib/font/sfnt.ts:readDirectory',
      'core/src/lib/font/sfnt.ts:readHeader',
      'core/src/lib/font/sfnt.ts:readPermissions',
      'core/src/lib/font/sfnt.ts:readNames',
      'import_font',
    ],
    input: 'bytes',
    build: () => firaBytes(),
    skipLinear: 'a binary font container: its size is not a record count',
    read: (input) => parseFont(asBytes(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'core: import_font (execute, base64)',
    covers: [],
    input: 'bytes',
    build: () => firaBytes(),
    skipLinear: 'a binary font container: its size is not a record count',
    read: (input) => execute(createEmptyDocument(), 'import_font', { base64: toBase64(asBytes(input)) }),
    accepts: (result) => (result as { affected: string[] }).affected.length > 0,
  },
  {
    name: 'core: evaluateExpression',
    covers: ['core/src/lib/expression.ts:tokenize'],
    input: 'text',
    build: (records) => `1${' + 2 * (3 - 1)'.repeat(records)}`,
    nest: (depth) => '('.repeat(depth) + '1' + ')'.repeat(depth),
    extra: [
      { name: 'unary minus chain', input: () => '-'.repeat(100_000) + '1' },
      { name: 'power chain', input: () => '2^'.repeat(100_000) + '2' },
      { name: 'function call nest', input: () => 'sin('.repeat(100_000) + '1' + ')'.repeat(100_000) },
    ],
    read: (input) => [evaluateExpression(asText(input), { w: 1 }), compileExpression(asText(input), ['w'])],
    accepts: (result) => (result as [{ ok: boolean }])[0].ok,
    budgetMs: 60_000,
  },
  {
    name: 'core: parseUnit',
    covers: ['core/src/lib/quantity.ts:parseUnit'],
    input: 'text',
    build: (records) => `W/(m*K)${'*m'.repeat(records)}`,
    nest: (depth) => '('.repeat(depth) + 'm' + ')'.repeat(depth),
    extra: [{ name: 'many exponent shorthands', input: () => 'm3'.repeat(100_000) }],
    read: (input) => parseUnit(asText(input)),
    accepts: (result) => !('code' in (result as object)),
  },
  {
    name: 'core: parseImageDataUrl',
    covers: ['core/src/lib/imageDataUrl.ts:parseImageDataUrl'],
    input: 'text',
    build: (records) => `data:image/png;base64,${toBase64(Uint8Array.from([...png1x1(), ...new Array<number>(records * 8).fill(0)]))}`,
    read: (input) => parseImageDataUrl(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'core: parseMaterialLibrary (llull-material-library JSON)',
    covers: ['core/src/commands/materials/libraryFormat.ts:parseMaterialLibrary', 'import_material_library'],
    input: 'text',
    build: libraryBuild,
    read: (input) => parseMaterialLibrary(parsedJson(asText(input))),
    accepts: (result) => (result as { ok: boolean }).ok,
    maxRecords: 4000,
  },
  {
    name: 'core: load_document (execute, saved JSON)',
    covers: ['load_document'],
    input: 'text',
    build: documentBuild,
    nest: (depth) => '['.repeat(depth) + ']'.repeat(depth),
    read: (input) => execute(createEmptyDocument(), 'load_document', { json: asText(input) }),
    accepts: (result) => (result as { affected: string[] }).affected.length > 0,
    maxRecords: 4000,
  },
  {
    name: 'core: thread designations and colours',
    covers: [
      'core/src/lib/threadForm.ts:parseThreadDimensions',
      'core/src/lib/threadForm.ts:parseIsoMetric',
      'core/src/lib/isHexColor.ts:parseHexRgb',
    ],
    input: 'text',
    build: (records) => `M${'1'.repeat(records)}x1.5-6H`,
    read: (input) => [parseThreadDimensions(asText(input)), parseIsoMetric(asText(input)), parseHexRgb(asText(input))],
    accepts: () => true,
  },
  {
    name: 'plm: readPdm (AP242 PDM file)',
    covers: ['plm/src/pdm/read.ts:readPdm', 'plm/src/pdm/args.ts:parseBody', 'plm/src/pdm/part21.ts:parseInstant'],
    input: 'text',
    build: pdmBuild,
    nest: (depth) => `ISO-10303-21;\nDATA;\n#1=A(${'('.repeat(depth)}${')'.repeat(depth)});\nENDSEC;\n`,
    read: (input) => [readPdm(asText(input)), parseBody(asText(input)), parseInstant(asText(input))],
    accepts: (result) => typeof (result as unknown[])[0] === 'object',
  },
  {
    name: 'protocol: parseQuery and parseCommandResponse',
    covers: ['protocol/src/discoveryRank.ts:parseQuery', 'protocol/src/restProtocol.ts:parseCommandResponse'],
    input: 'text',
    build: (records) => repeated('', (k) => `box${k} fillet `, 'edge', records),
    read: (input) => [parseQuery(asText(input)), orRefusal(() => parseCommandResponse(parsedJson(asText(input)), 200))],
    accepts: () => true,
  },
];
