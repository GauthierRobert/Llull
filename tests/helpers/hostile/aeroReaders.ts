/** Hostile-input table: aerospace readers (airfoil files, composite AP242, ply / bend-radius CSV, CFD result JSON, short designations). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseFlowResult } from '@aero/cfd/flowResult';
import { FIELD_HEADER_BYTES, flowFieldHeader, parseFlowQueryAnswer } from '@aero/cfd/queryOutput';
import { readComposite } from '@aero/composites/ap242/reader';
import { readStandard } from '@aero/composites/ap242/standardReader';
import { parseNotation } from '@aero/composites/notation';
import { parseNaca } from '@aero/aerodynamics/naca';
import { parseAirfoilText } from '@aero/surfacing/airfoilFormats';
import { AS4 } from '../../unit/aero/composites/fixtures';
import { exportOf, panelDoc } from '../../unit/aero/composites/ap242Support';
import { asBytes, asText, repeated, type HostileInput, type HostileReader } from './types';

const FASTENER_CATALOG = path.resolve(
  __dirname,
  '../../../docs/aerospace/08-materials-standards-libraries/validation/fastener_catalog_llull.json',
);

/** `JSON.parse` whose syntax / depth errors are refusals (the command takes the parsed object). */
const recordOf = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return {};
    throw error;
  }
};

const created = (result: unknown): boolean => (result as { affected: string[] }).affected.length > 0;

const airfoilBuild = (records: number): string =>
  repeated('NACA test\n', (k) => `${(1 - k / (records + 5)).toFixed(6)} ${(0.01 * Math.sin(k)).toFixed(6)}\n`, '', records + 5);
const lednicerBuild = (records: number): string => {
  const rows = Array.from({ length: records + 3 }, (_, k) => `${(k / (records + 3)).toFixed(6)} ${(0.01 * Math.sin(k)).toFixed(6)}\n`);
  return `NACA lednicer\n${rows.length}. ${rows.length}.\n\n${rows.join('')}\n${rows.join('')}`;
};

let panelStep: string | null = null;
/** The composite panel exported once through `export_composite_ap242` (the fake XDE writer of the AP242 suites). */
const panelText = (): string => {
  panelStep ??= exportOf(panelDoc().doc).data.step;
  return panelStep;
};
/** The exported file with `records` extra instances before `ENDSEC;`. */
const compositeBuild = (records: number): string => {
  const base = panelText();
  const at = base.lastIndexOf('ENDSEC;');
  const filler = Array.from({ length: records }, (_, k) => `#${800000 + k} = CARTESIAN_POINT('f${k}',(${k}.,0.,1.E-3));\n`).join('');
  return base.slice(0, at) + filler + base.slice(at);
};

const plyCsv = (records: number): string =>
  repeated('ply,sequence,order,material,orientation,rosette\n', (k) => `P${k},S${k},${k},${AS4.name},${(k % 4) * 45},R0\n`, '', records);
const bendCsv = (records: number): string =>
  repeated(
    'material,temper,thickness,minInsideRadius,units,bendAngle,source,verification\n',
    (k) => `Al${k},T${k % 5},${1 + (k % 7)},1.5,mm,90,Handbook 2020,unverified\n`,
    '',
    records,
  );

const flowJson = (records: number): string =>
  JSON.stringify({ version: 1, caseId: 'c', history: Array.from({ length: records }, (_, k) => ({ step: k, timeS: k, dragN: 1, cd: 1 })) });

const probeJson = (records: number): string =>
  JSON.stringify({
    probes: Array.from({ length: records }, (_, k) => ({
      pointM: [k, 0, 0],
      velocityMS: [1, 0, 0],
      speedMS: 1,
      pressurePa: 0,
      miss: null,
    })),
  });

/** An LLFD field file of 2 x 2 x `cells / 4` cells (at least 2 layers), `mirrors` symmetry planes, cell data zero. */
function fieldFile(records: number, mirrors = 0, grid?: readonly [number, number, number]): Uint8Array {
  const [nx, ny, nz] = grid ?? [2, 2, Math.max(2, records)];
  const cells = nx * ny * nz;
  const bytes = new Uint8Array(grid === undefined ? 56 + 16 * mirrors + 17 * cells : FIELD_HEADER_BYTES);
  bytes.set([76, 76, 70, 68]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  [nx, ny, nz].forEach((n, k) => view.setUint32(8 + 4 * k, n, true));
  view.setFloat64(20, 0.125, true);
  view.setUint32(52, mirrors, true);
  return bytes;
}

/** The host's view of a field file: its head and its size. */
const fieldHeaderOf = (input: HostileInput): unknown => {
  const bytes = asBytes(input);
  return flowFieldHeader(bytes.subarray(0, FIELD_HEADER_BYTES), bytes.length);
};

/** An LLST file of `lines` empty lines (what a streamline query.json of zero-point lines describes). */
function emptyLines(lines: number): Uint8Array {
  const bytes = new Uint8Array(16 + 4 * (lines + 1));
  bytes.set([76, 76, 83, 84]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, lines, true);
  return bytes;
}

const sliceAnswer = (records: number): string =>
  JSON.stringify({
    slice: {
      file: 'slice.bin',
      field: 'speed',
      samples: 2,
      spacingM: 1,
      originM: [0, 0, 0],
      axisU: [1, 0, 0],
      axisV: [0, 1, 0],
      validSamples: 4,
      min: 0,
      max: 1,
    },
    notes: Array.from({ length: records }, (_, k) => k),
  });

const SLICE_FILE = ((): Uint8Array => {
  const bytes = new Uint8Array(72 + 16);
  bytes.set([76, 76, 83, 76]);
  new DataView(bytes.buffer).setUint32(8, 2, true);
  return bytes;
})();

const streamlineAnswer = (records: number): string =>
  JSON.stringify({
    streamlines: {
      file: 'streamlines.bin',
      device: 'cpu',
      deterministic: true,
      precision: 'f64',
      points: 0,
      lines: Array.from({ length: records }, (_, seed) => ({ seed, points: 0, lengthM: 0, stopBackward: 'wall', stopForward: 'wall' })),
    },
  });

export const AERO_READERS: readonly HostileReader[] = [
  {
    name: 'aero: import_fastener_catalog (execute, JSON catalog)',
    covers: ['import_fastener_catalog'],
    input: 'text',
    build: () => readFileSync(FASTENER_CATALOG, 'utf8'),
    skipLinear: 'a schema-validated JSON file: the sample is a fixed catalog, not a scalable record list',
    read: (input) => execute(createEmptyDocument(), 'import_fastener_catalog', { catalog: recordOf(asText(input)) }),
    accepts: (result) => (result as { summary: string }).summary.startsWith('Imported'),
  },
  {
    name: 'aero: parseAirfoilText (Selig)',
    covers: ['domain-aero/src/surfacing/airfoilFormats.ts:parseAirfoilText', 'import_airfoil'],
    input: 'text',
    build: airfoilBuild,
    read: (input) => parseAirfoilText(asText(input), 'auto'),
    accepts: (result) => typeof result !== 'string',
  },
  {
    name: 'aero: parseAirfoilText (Lednicer)',
    covers: [],
    input: 'text',
    build: lednicerBuild,
    read: (input) => parseAirfoilText(asText(input), 'lednicer'),
    accepts: (result) => typeof result !== 'string',
  },
  {
    name: 'aero: import_airfoil (execute)',
    covers: [],
    input: 'text',
    build: (records) => airfoilBuild(Math.min(records, 1500)),
    skipLinear: 'the command refuses more than 2000 points up front',
    read: (input) => execute(createEmptyDocument(), 'import_airfoil', { text: asText(input) }),
    accepts: created,
  },
  {
    name: 'aero: readComposite (AP242 composite file)',
    covers: ['domain-aero/src/composites/ap242/reader.ts:readComposite', 'import_composite_ap242'],
    input: 'text',
    build: compositeBuild,
    read: (input) => readComposite(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'aero: readStandard (CAx-IF composite structure)',
    covers: ['domain-aero/src/composites/ap242/standardReader.ts:readStandard'],
    input: 'text',
    build: compositeBuild,
    read: (input) => readStandard(asText(input)),
    accepts: (result) => typeof result === 'object' && result !== null,
  },
  {
    name: 'aero: import_ply_table (execute)',
    covers: ['import_ply_table'],
    input: 'text',
    build: plyCsv,
    read: (input) => execute(panelDoc().doc, 'import_ply_table', { part: 'Panel', csv: asText(input), replace: true }),
    accepts: created,
    maxRecords: 4000,
  },
  {
    name: 'aero: import_bend_radius_table (execute, csv)',
    covers: ['import_bend_radius_table'],
    input: 'text',
    build: bendCsv,
    read: (input) => execute(createEmptyDocument(), 'import_bend_radius_table', { csv: asText(input) }),
    accepts: (result) => (result as { summary: string }).summary.includes('imported'),
  },
  {
    name: 'aero: parseFlowResult (CFD result.json)',
    covers: ['domain-aero/src/cfd/flowResult.ts:parseFlowResult'],
    input: 'text',
    build: flowJson,
    nest: (depth) => '['.repeat(depth) + ']'.repeat(depth),
    read: (input) => parseFlowResult(asText(input)),
    accepts: (result) => typeof result === 'string' && result.includes('result.json'),
  },
  {
    name: 'aero: parseFlowQueryAnswer (CFD flow-query query.json)',
    covers: ['domain-aero/src/cfd/queryOutput.ts:parseFlowQueryAnswer'],
    input: 'text',
    build: probeJson,
    nest: (depth) => '['.repeat(depth) + ']'.repeat(depth),
    read: (input) => parseFlowQueryAnswer('probe', asText(input), new Uint8Array()),
    accepts: (result) => typeof result === 'object' && result !== null && (result as { op: string }).op === 'probe',
  },
  {
    name: 'aero: parseFlowQueryAnswer (CFD slice query.json + LLSL)',
    covers: [],
    input: 'text',
    build: sliceAnswer,
    nest: (depth) => '['.repeat(depth) + ']'.repeat(depth),
    read: (input) => parseFlowQueryAnswer('slice', asText(input), SLICE_FILE),
    accepts: (result) => typeof result === 'object' && result !== null && (result as { op: string }).op === 'slice',
  },
  {
    name: 'aero: parseFlowQueryAnswer (CFD streamlines query.json + LLST)',
    covers: [],
    input: 'text',
    build: streamlineAnswer,
    nest: (depth) => '['.repeat(depth) + ']'.repeat(depth),
    // the file matches the line count the text announces (a count of "seed" keys: linear in the input)
    read: (input) => {
      const text = asText(input);
      return parseFlowQueryAnswer('streamlines', text, emptyLines(text.split('"seed"').length - 1));
    },
    accepts: (result) => typeof result === 'object' && result !== null && (result as { op: string }).op === 'streamlines',
  },
  {
    name: 'aero: flowFieldHeader (CFD field.bin head + size)',
    covers: ['domain-aero/src/cfd/queryOutput.ts:flowFieldHeader'],
    input: 'bytes',
    build: (records) => fieldFile(records),
    read: fieldHeaderOf,
    accepts: (result) => typeof result === 'object' && result !== null && (result as { nx: number }).nx === 2,
    extra: [
      { name: 'truncated header', input: () => fieldFile(4).subarray(0, 40) },
      { name: 'huge nx * ny * nz in a small file', input: () => fieldFile(0, 0, [4_000_000_000, 4_000_000_000, 4_000_000_000]) },
      { name: 'more than three symmetry planes', input: () => fieldFile(4, 9) },
      { name: 'cell data one byte short', input: () => fieldFile(4).subarray(0, fieldFile(4).length - 1) },
    ],
  },
  {
    name: 'aero: parseNotation (stacking string)',
    covers: ['domain-aero/src/composites/notation.ts:parseNotation'],
    input: 'text',
    build: (records) => `[${Array.from({ length: records }, (_, k) => `${(k % 4) * 45}`).join('/')}]s`,
    nest: (depth) => '['.repeat(depth) + '0' + ']_2'.repeat(depth),
    read: (input) => parseNotation(asText(input)),
    accepts: (result) => (result as { ok: boolean }).ok,
    maxRecords: 600,
  },
  {
    name: 'aero: parseNaca (designation)',
    covers: ['domain-aero/src/aerodynamics/naca.ts:parseNaca'],
    input: 'text',
    build: (records) => `NACA${' '.repeat(records)}2412`,
    read: (input) => parseNaca(asText(input)),
    accepts: (result) => typeof result !== 'string',
  },
];
