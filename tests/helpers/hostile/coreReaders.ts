/** Hostile-input table: core readers of user text (fonts, expressions, units, images, material libraries, saved documents) and PLM / protocol readers. */
import { execute } from '@core/commands/registry';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Entity } from '@core/model/types';
import { evaluateExpression } from '@lib/expression';
import { compileExpression } from '@lib/expressionProgram';
import { float64ToBase64 } from '@lib/float64Base64';
import { parseFont, validateGlyphs } from '@lib/font/font';
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
import { seacFont, variableFont } from '../../unit/wrap/variableFonts';
import { variableTrueTypeWithMetrics } from '../../unit/wrap/variableTrueType';
import { aliasedStoreFont, gvarTupleFanFont, manyRangesFont, operatorFanFont, sharedSubrsFont } from '../../unit/wrap/hostileFonts';
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

/** A saved document holding one instance array (VIS1), with `tamper` applied to its parsed record: the hostile variants of the packed table. */
const arrayDocument = (tamper: (record: Record<string, unknown>) => void): string => {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
  doc = execute(doc, 'create_component', { name: 'C', entityIds: doc.order, componentId: 'c' }).document;
  doc = execute(doc, 'add_instance_array', { componentId: 'c', counts: [2, 2, 1], step: [5, 5, 5] }).document;
  const saved = JSON.parse(serializeDocument(doc)) as { document: { instanceArrays: Record<string, Record<string, unknown>> } };
  for (const record of Object.values(saved.document.instanceArrays)) tamper(record);
  return JSON.stringify(saved);
};

const png1x1 = (): Uint8Array =>
  Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  );

/** A `dynamics` record with `records` motion profiles and motor drives (PHY-23), with `segment` as the one segment of every profile. */
const driveDynamics = (records: number, segment: unknown = { kind: 'dwell', duration: 1 }): string => {
  const ids = Array.from({ length: records }, (_, k) => `p${k}`);
  const profiles = Object.fromEntries(ids.map((id) => [id, { id, quantity: 'velocity', unit: 'rad/s', segments: [segment] }]));
  const drives = Object.fromEntries(
    ids.map((id) => [id, { id, mode: 'velocity', profile: id, gains: { kp: 1, ki: 0, kpPosition: 0 }, sampleHz: 1000 }]),
  );
  return JSON.stringify({ gravity: [0, 0, -9.81], bodies: {}, joints: {}, motors: {}, propellers: {}, profiles, drives });
};

const isRecordLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A `dynamics` record with `records` gear transmissions, joint physics, load schedules (PHY-23 DRV-M2) and reference series (DRV-M3) between the joints it declares, `tamper` applied to each. */
const mechanismDynamics = (records: number, tamper: (record: Record<string, unknown>) => void = () => undefined): string => {
  const ids = Array.from({ length: records }, (_, k) => k);
  const joint = (id: string): Record<string, unknown> => ({
    id,
    kind: 'revolute',
    parent: 'ground',
    child: `b-${id}`,
    anchor: [0, 0, 0],
    axis: [0, 0, 1],
    damping: 0,
    friction: 0,
    initialVelocity: 0,
  });
  const joints = Object.fromEntries(
    ids.flatMap((k) => [
      [`a${k}`, joint(`a${k}`)],
      [`b${k}`, joint(`b${k}`)],
    ]),
  );
  const source = { name: 's', grade: 'C' };
  const transmissions = Object.fromEntries(
    ids.map((k) => [`t${k}`, { kind: 'gear', id: `t${k}`, driver: `a${k}`, driven: `b${k}`, ratio: 2, efficiency: 0.9, backlashDeg: 0.5 }]),
  );
  const jointPhysics = Object.fromEntries(
    ids.map((k) => [
      `a${k}`,
      {
        id: `a${k}`,
        friction: { model: 'stiction', static: 2, kinetic: 1, source },
        limits: { min: -1, max: 1, stiffness: 10 },
        armatureKgM2: 0.1,
      },
    ]),
  );
  const loadSchedules = Object.fromEntries(
    ids.map((k) => [`l${k}`, { id: `l${k}`, target: { joint: `a${k}` }, kind: 'torque', constant: 1 }]),
  );
  const referenceSeries = Object.fromEntries(
    ids.map((k) => [
      `r${k}`,
      {
        id: `r${k}`,
        quantity: 'joint_velocity',
        target: `a${k}`,
        times: [0, 1, 2],
        values: [0, 1, 2],
        source,
        uncertainty: 0.1,
        bandRel: 0.05,
      },
    ]),
  );
  for (const table of [transmissions, jointPhysics, loadSchedules, referenceSeries])
    for (const record of Object.values(table)) tamper(record);
  return JSON.stringify({
    gravity: [0, 0, -9.81],
    bodies: {},
    joints,
    motors: {},
    propellers: {},
    transmissions,
    jointPhysics,
    loadSchedules,
    referenceSeries,
  });
};

export const CORE_READERS: readonly HostileReader[] = [
  {
    name: 'core: dynamics transmissions, joint physics, load schedules and reference series (load-time validation of a saved document)',
    covers: [
      'core/src/commands/persistence/transmissionsValidation.ts:transmissionProblem',
      'core/src/commands/persistence/transmissionsValidation.ts:jointPhysicsProblem',
      'core/src/commands/persistence/transmissionsValidation.ts:loadScheduleProblem',
      'core/src/commands/persistence/transmissionsValidation.ts:transmissionReferenceProblems',
      'core/src/commands/persistence/referenceSeriesValidation.ts:referenceSeriesProblem',
      'core/src/commands/persistence/referenceSeriesValidation.ts:referenceSeriesReferenceProblems',
    ],
    input: 'text',
    build: (records) => mechanismDynamics(records),
    read: (input) => dynamicsProblems(parsedJson(asText(input))),
    accepts: (result) => Array.isArray(result) && result.length === 0,
    maxRecords: 5000,
    extra: [
      {
        name: 'unknown transmission kind',
        input: () => mechanismDynamics(3, (record) => void ('driver' in record && (record['kind'] = 'foo'))),
      },
      {
        name: 'friction model named after a prototype member',
        input: () =>
          mechanismDynamics(3, (record) => void (isRecordLike(record['friction']) && (record['friction']['model'] = '__proto__'))),
      },
      {
        name: 'limits that are not an object',
        input: () => mechanismDynamics(3, (record) => void ('limits' in record && (record['limits'] = 'abc'))),
      },
      {
        name: 'load target that is not an object',
        input: () => mechanismDynamics(3, (record) => void ('target' in record && (record['target'] = 7))),
      },
      {
        name: 'series times that do not increase',
        input: () => mechanismDynamics(3, (record) => void ('times' in record && (record['times'] = [2, 1, 0]))),
      },
      {
        name: 'series values as a string',
        input: () => mechanismDynamics(3, (record) => void ('times' in record && (record['values'] = 'abc'))),
      },
      {
        name: 'series quantity named after a prototype member',
        input: () => mechanismDynamics(3, (record) => void ('times' in record && (record['quantity'] = '__proto__'))),
      },
      {
        name: 'a ledger series with several points',
        input: () => mechanismDynamics(3, (record) => void ('times' in record && (record['quantity'] = 'ledger_energy'))),
      },
      {
        name: 'six series of 100000 points exceed the document budget',
        input: () =>
          mechanismDynamics(6, (record) => {
            if ('times' in record)
              [record['times'], record['values']] = [
                Array.from({ length: 100_000 }, (_, k) => k),
                Array.from({ length: 100_000 }, () => 0),
              ];
          }),
      },
      {
        name: 'series with 200000 points',
        input: () =>
          mechanismDynamics(1, (record) => {
            if ('times' in record)
              [record['times'], record['values']] = [
                Array.from({ length: 200_000 }, (_, k) => k),
                Array.from({ length: 200_000 }, () => 0),
              ];
          }),
      },
      {
        name: 'transmissions that drive each other in a circle',
        input: () => {
          const dynamics = JSON.parse(mechanismDynamics(3)) as { transmissions: Record<string, unknown> };
          dynamics.transmissions['back'] = { kind: 'gear', id: 'back', driver: 'b0', driven: 'a0', ratio: 2 };
          return JSON.stringify(dynamics);
        },
      },
      {
        name: 'every transmission drives the same joint',
        input: () => mechanismDynamics(3, (record) => void ('driven' in record && (record['driven'] = 'b0'))),
      },
    ],
  },
  {
    name: 'core: dynamics profiles and drives (load-time validation of a saved document)',
    covers: [
      'core/src/commands/persistence/drivesValidation.ts:profileProblem',
      'core/src/commands/persistence/drivesValidation.ts:driveProblem',
    ],
    input: 'text',
    build: (records) => driveDynamics(records),
    read: (input) => dynamicsProblems(parsedJson(asText(input))),
    accepts: (result) => Array.isArray(result) && result.every((problem) => String(problem).includes('no datasheet (dc) motor')),
    maxRecords: 20000,
    extra: [
      { name: 'segment of an unknown kind', input: () => driveDynamics(3, { kind: 'foo' }) },
      { name: 'segment that is null', input: () => driveDynamics(3, null) },
      { name: 'move with an unknown law', input: () => driveDynamics(3, { kind: 'move', law: 'bogus', to: 1, duration: 1 }) },
      {
        name: 'move law named after a prototype member',
        input: () => driveDynamics(3, { kind: 'move', law: 'constructor', to: 1, duration: 1 }),
      },
      { name: 'table with points as a string', input: () => driveDynamics(3, { kind: 'table', points: 'abc', interpolation: 'linear' }) },
      { name: 'table with null points', input: () => driveDynamics(3, { kind: 'table', points: [null, null], interpolation: 'linear' }) },
      { name: 'table without points', input: () => driveDynamics(3, { kind: 'table', interpolation: 'linear' }) },
    ],
  },
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
    name: 'core: parseFont (CFF2 variable font at an instance: fvar, avar, variation store, blend, HVAR)',
    covers: [
      'core/src/lib/font/cffIndex.ts:readIndex',
      'core/src/lib/font/cffIndex.ts:readDict',
      'core/src/lib/font/variation.ts:readVariationSpace',
      'core/src/lib/font/variation.ts:readItemVariationStore',
      'core/src/lib/font/variation.ts:readAdvanceDeltas',
    ],
    input: 'bytes',
    build: () => variableFont({ avar: true, hvar: [3, 2, 1] }),
    extra: [
      { name: '4000 font dicts share one 262 144-entry Subrs INDEX', input: () => sharedSubrsFont(4000, 262_144, 1) },
      { name: '256 font dicts, each used, share one 262 144-entry Subrs INDEX', input: () => sharedSubrsFont(256, 262_144, 256) },
      { name: '4096 data subtables alias one subtable of 4096 region indexes', input: () => aliasedStoreFont(4096, 4096) },
      { name: 'a subtable lists more regions than the store has', input: () => aliasedStoreFont(8, 1, 9) },
      { name: 'an FDSelect of 20 000 one-glyph ranges', input: () => manyRangesFont(20_000) },
      { name: 'an FDSelect whose ranges do not increase', input: () => manyRangesFont(100, true) },
      { name: '2000 glyphs of 70 000 operators each (font-wide operator budget)', input: () => operatorFanFont(2000) },
    ],
    skipLinear: 'a binary font container: its size is not a record count',
    read: (input) => {
      const parsed = parseFont(asBytes(input), { wght: 650, wdth: 112.5 });
      return parsed.ok ? validateGlyphs(parsed.font) : parsed;
    },
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'core: parseFont (variable TrueType at an instance: gvar tuples, avar 2 delta store, MVAR, HVAR)',
    covers: [
      'core/src/lib/font/gvar.ts:readGvar',
      'core/src/lib/font/mvar.ts:readMetricDeltas',
      'core/src/lib/font/variation.ts:readVerticalAdvanceDeltas',
      'core/src/lib/font/variation.ts:readTopSideBearingDeltas',
      'core/src/lib/font/sfnt.ts:readNameStrings',
    ],
    input: 'bytes',
    build: () => variableTrueTypeWithMetrics(),
    extra: [
      { name: 'a glyph of 20 000 points with 4095 size-0 tuples over one run of zero deltas', input: () => gvarTupleFanFont(4095) },
      {
        name: 'the same glyph with 90 tuples (just under the per-glyph cap: read within the time budget)',
        input: () => gvarTupleFanFont(90),
      },
    ],
    skipLinear: 'a binary font container: its size is not a record count',
    read: (input) => {
      const parsed = parseFont(asBytes(input), { wght: 650, wdth: 112.5 });
      if (!parsed.ok) return parsed;
      for (let glyph = 0; glyph < parsed.font.numGlyphs; glyph++) parsed.font.verticalAdvance(glyph);
      const named = parseFont(asBytes(input), {}, 'Bold Condensed');
      return named.ok ? validateGlyphs(named.font) : named;
    },
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'core: parseFont (CFF with seac, an arithmetic operator and a charset)',
    covers: ['core/src/lib/font/cffEncoding.ts:readCharset'],
    input: 'bytes',
    build: () => seacFont(),
    skipLinear: 'a binary font container: its size is not a record count',
    read: (input) => {
      const parsed = parseFont(asBytes(input));
      return parsed.ok ? validateGlyphs(parsed.font) : parsed;
    },
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
    extra: [
      { name: 'instance array: count far beyond the table', input: () => arrayDocument((record) => (record['count'] = 2 ** 31)) },
      {
        name: 'instance array: table of 4 MB of base64 for a count of 4',
        input: () => arrayDocument((record) => (record['transforms'] = 'A'.repeat(4_000_000))),
      },
      {
        name: 'instance array: every double NaN',
        input: () => arrayDocument((record) => (record['transforms'] = float64ToBase64(new Float64Array(24).fill(Number.NaN)))),
      },
      { name: 'instance array: table as a nested array', input: () => arrayDocument((record) => (record['transforms'] = [[[1]]])) },
      { name: 'instance array: component id __proto__', input: () => arrayDocument((record) => (record['componentId'] = '__proto__')) },
    ],
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
