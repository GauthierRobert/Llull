/** Hostile-input table: aerospace readers (airfoil files, composite AP242, ply / bend-radius CSV, CFD result JSON, short designations). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseFlowResult } from '@aero/cfd/flowResult';
import { readComposite } from '@aero/composites/ap242/reader';
import { readStandard } from '@aero/composites/ap242/standardReader';
import { parseNotation } from '@aero/composites/notation';
import { parseNaca } from '@aero/aerodynamics/naca';
import { parseAirfoilText } from '@aero/surfacing/airfoilFormats';
import { AS4 } from '../../unit/aero/composites/fixtures';
import { exportOf, panelDoc } from '../../unit/aero/composites/ap242Support';
import { asText, repeated, type HostileReader } from './types';

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
