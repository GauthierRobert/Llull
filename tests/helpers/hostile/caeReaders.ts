/** Hostile-input table: CAE result readers (CalculiX .dat / .frd / .sta, Nastran OP2, field tables). */
import { pretensionErrors } from '@cae/contact/pretensionValidate';
import { parseHistorySeries } from '@cae/explicit/historyArtifact';
import { parseSta } from '@cae/nonlinear/solverLog';
import { parseDat } from '@cae/results/datReader';
import { parseFrd } from '@cae/results/frdReader';
import { readOp2 } from '@cae/results/op2Reader';
import { parseFrdNodes } from '@cae/shell/shellResults';
import { parseFieldTable } from '@cae/thermomech/tableImport';
import { Op2Builder, displacementRow } from '../../unit/cae/op2Fixture';
import { asBytes, asText, repeated, type HostileReader } from './types';

const sci = (value: number): string => value.toExponential(5).toUpperCase().padStart(12);

const datBuild = (records: number): string =>
  repeated(
    '\n     E I G E N V A L U E   O U T P U T\n\n MODE NO    EIGENVALUE                       FREQUENCY\n                                     REAL PART            IMAGINARY PART\n                           (RAD/TIME)      (CYCLES/TIME     (RAD/TIME)\n\n',
    (k) => `      ${k + 1}   0.1736497E+07   0.1317762E+04   0.2097284E+03   0.0000000E+00\n`,
    '\n displacements (vx,vy,vz) for set N1 and time  0.1000000E+01\n\n         2  0.1E+00  0.0E+00  0.0E+00\n',
    records,
  );
const datNodePrint = (records: number): string =>
  repeated(
    '',
    (k) => ` displacements (vx,vy,vz) for set S${k} and time  0.${k}E+00\n\n         ${k + 1}  0.1E+00  0.2E+00  0.3E+00\n\n`,
    '',
    records,
  );

const frdSet = (k: number): string =>
  [
    `    1PSTEP${String(k).padStart(25)}${String(1).padStart(12)}${String(1).padStart(12)}`,
    `  100CL ${String(101 + k).padStart(4)}${sci(k + 0.5)}${' '.repeat(12)}`,
    ' -4  DISP        4    1',
    ' -5  D1          1    2    1    0',
    ' -5  D2          1    2    2    0',
    ' -5  D3          1    2    3    0',
    ` -1${String(k + 1).padStart(10)}${sci(1.5)}${sci(0)}${sci(-2)}`,
    ' -3',
    '',
  ].join('\n');
const frdBuild = (records: number): string => repeated('', frdSet, '', records);
const frdNodeBlock = (records: number): string =>
  repeated(
    '    2C                            3                                     1\n',
    (k) => ` -1${String(k + 1).padStart(10)}${sci(k)}${sci(1)}${sci(2)}\n`,
    ' -3\n',
    records,
  );

const staBuild = (records: number): string =>
  repeated(
    ' SUMMARY OF JOB INFORMATION\n  STEP      INC     ATT   ITRS     TOT TIME     STEP TIME      INC TIME\n',
    (k) => `     1${String(k + 1).padStart(9)}       1      3  ${sci(k / 1000)}${sci(0.5)}${sci(0.1)}\n`,
    '',
    records,
  );

const historyRequests = [{ id: 'th-1.1', name: 'h', kind: 'part', part: 0, quantities: ['mass'] }] as const;

const historiesBuild = (records: number): string =>
  repeated(
    '{"version":1,"series":[',
    (k) => `${k > 0 ? ',' : ''}{"name":"h","quantity":"mass","components":1,"times":[${k + 1}],"values":[${k}]}`,
    ']}',
    records,
  );

const tableBuild = (records: number): string => repeated('x,y,z,T\n', (k) => `${k}.5,${k},0,${20 + (k % 50)}\n`, '', records);

const op2Build = (records: number): Uint8Array => {
  const builder = new Op2Builder(true);
  const rows = Array.from({ length: records }, (_, k) => displacementRow(k + 1, [0.5 * k, 0, 0, 0, 0, 0])).flat();
  builder.table('OUGV1', [{ approach: 11, tableCode: 1, subcase: 1, numWide: 8, data: rows }]);
  return builder.build();
};

const boltJson = (index: number, id = 'b' + index, section = '{"point":[0,0,0],"normal":[0,0,1]}'): string =>
  '"' +
  id +
  '":{"id":"' +
  id +
  '","name":"n' +
  index +
  '","entityId":"part","section":' +
  section +
  ',"preload":{"kind":"force","value":1},"preloadStepId":"s1","lockAfter":true}';
const pretensionText = (records: number): string => {
  const ids = Array.from({ length: records }, (_, k) => k);
  return '{"bolts":{' + ids.map((k) => boltJson(k)).join(',') + '},"order":[' + ids.map((k) => '"b' + k + '"').join(',') + ']}';
};
/** The load validation of a pretension slice (a JSON text here): it must report errors, never throw. */
const readPretension = (text: string): string[] => {
  try {
    return pretensionErrors({ type: 'nonlinear_static', pretension: JSON.parse(text), nonlinear: { stepOrder: ['s1'] } }, 'case', {
      part: {},
    });
  } catch {
    return ['not JSON'];
  }
};

export const CAE_READERS: readonly HostileReader[] = [
  {
    name: 'cae: pretensionErrors (bolt pretension slice of a loaded case)',
    covers: ['domain-cae/src/contact/pretensionValidate.ts:pretensionErrors'],
    input: 'text',
    build: pretensionText,
    read: (input) => readPretension(asText(input)),
    accepts: (result) => (result as string[]).length === 0,
    extra: [
      { name: 'order is not an array', input: () => '{"bolts":{},"order":"b0"}' },
      { name: 'reserved key', input: () => '{"bolts":{' + boltJson(0, '__proto__') + '},"order":["__proto__"]}' },
      {
        name: 'infinite section point',
        input: () => '{"bolts":{' + boltJson(0, 'b0', '{"point":[1e999,0,0],"normal":[0,0,1]}') + '},"order":["b0"]}',
      },
    ],
  },
  {
    name: 'cae: parseDat (eigenvalue and node-print tables)',
    covers: ['domain-cae/src/results/datReader.ts:parseDat'],
    input: 'text',
    build: datBuild,
    read: (input) => parseDat(asText(input)),
    accepts: (result) => (result as { tables: unknown[] }).tables.length > 0,
  },
  {
    name: 'cae: parseDat (many node-print tables)',
    covers: [],
    input: 'text',
    build: datNodePrint,
    read: (input) => parseDat(asText(input)),
    accepts: (result) => (result as { tables: unknown[] }).tables.length === 3,
  },
  {
    name: 'cae: parseFrd (one result set per record)',
    covers: ['domain-cae/src/results/frdReader.ts:parseFrd'],
    input: 'text',
    build: frdBuild,
    read: (input) => parseFrd(asText(input)),
    accepts: (result) => (result as unknown[]).length === 3,
  },
  {
    name: 'cae: parseFrdNodes (2C block)',
    covers: ['domain-cae/src/shell/shellResults.ts:parseFrdNodes'],
    input: 'text',
    build: frdNodeBlock,
    read: (input) => parseFrdNodes(asText(input)),
    accepts: (result) => (result as Map<number, unknown>).size === 3,
  },
  {
    name: 'cae: parseSta',
    covers: ['domain-cae/src/nonlinear/solverLog.ts:parseSta'],
    input: 'text',
    build: staBuild,
    read: (input) => parseSta(asText(input)),
    accepts: (result) => (result as unknown[]).length === 3,
  },
  {
    name: 'cae: parseHistorySeries (histories.json of an explicit run)',
    covers: ['domain-cae/src/explicit/historyArtifact.ts:parseHistorySeries'],
    input: 'text',
    build: historiesBuild,
    read: (input) => parseHistorySeries(asText(input), historyRequests, { length: 'mm', energy: 'mJ' }),
    accepts: (result) => Array.isArray(result) && result.length === 3,
  },
  {
    name: 'cae: parseFieldTable (x,y,z,T csv)',
    covers: ['domain-cae/src/thermomech/tableImport.ts:parseFieldTable'],
    input: 'text',
    build: tableBuild,
    read: (input) => parseFieldTable(asText(input), 'mm', 'degC'),
    accepts: (result) => (result as { ok: boolean }).ok,
  },
  {
    name: 'cae: readOp2 (displacement table)',
    covers: ['domain-cae/src/results/op2Reader.ts:readOp2'],
    input: 'bytes',
    build: op2Build,
    read: (input) => readOp2(asBytes(input)),
    accepts: (result) => (result as { displacements: unknown[] }).displacements.length === 1,
  },
];
