/**
 * Generator of the bundled open piping catalogue data (plant 01 PSC TECHNICAL_SPEC §5.2): reads the grade-A / grade-B rows of the validation
 * pack (`docs/plant/01-piping-specs-catalog/validation/data/*.json`) into the compact TypeScript modules in
 * `packages/domain-aec/src/plant/catalog/data/`. `tests/unit/plant/piping/catalogDrift.test.ts` fails when a committed module differs from the
 * pack; `npm run piping-catalog` rewrites them (LLULL_WRITE_PIPING_CATALOG=1) and formats them with prettier.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FittingRow,
  FlangeB165Row,
  FlangeEnRow,
  GasketRow,
  PipeRow,
  RatingBarRow,
  RatingPsiRow,
  ValveRow,
} from '../packages/domain-aec/src/plant/catalog/data/rowTypes';

export const DATA_MODULE_DIR = path.resolve(__dirname, '../packages/domain-aec/src/plant/catalog/data');
const PACK_DATA_DIR = path.resolve(__dirname, '../docs/plant/01-piping-specs-catalog/validation/data');

type Json = Record<string, unknown>;
const read = (file: string): Json => JSON.parse(readFileSync(path.join(PACK_DATA_DIR, file), 'utf8')) as Json;
const rowsOf = (json: Json, key: string): Json[] => json[key] as Json[];
const num = (row: Json, key: string): number => row[key] as number;
const str = (row: Json, key: string): string => row[key] as string;
const isA = (grade: unknown): boolean => typeof grade === 'string' && grade.startsWith('A');

export interface PipingData {
  readonly pipeB3610: readonly PipeRow[];
  readonly pipeB3619: readonly PipeRow[];
  readonly lr90: readonly FittingRow[];
  readonly lr45: readonly FittingRow[];
  readonly sr90: readonly FittingRow[];
  readonly teeRun: readonly FittingRow[];
  readonly reducerLength: readonly FittingRow[];
  readonly flangesB165: readonly FlangeB165Row[];
  readonly flangesEn1092: readonly FlangeEnRow[];
  readonly gasketsB1620: readonly GasketRow[];
  readonly valvesB1610: readonly ValveRow[];
  readonly ratingBar: readonly RatingBarRow[];
  readonly ratingPsi: readonly RatingPsiRow[];
}

const pipeRows = (standard: string): PipeRow[] =>
  rowsOf(read('asme_b36_pipe_schedules.json'), 'rows')
    .filter((row) => row['standard'] === standard)
    .map((row): PipeRow => [num(row, 'nps'), str(row, 'schedule'), num(row, 'odMm'), num(row, 'wallMm'), isA(row['grade'])]);

const fittingRows = (key: string, mmKey: string): FittingRow[] =>
  rowsOf(read('asme_b16_9_buttweld_fittings.json'), key).map(
    (row): FittingRow => [num(row, 'nps'), num(row, mmKey), isA(row['grade']), (row['sources'] as string[]).join('+')],
  );

const flangesB165 = (): FlangeB165Row[] =>
  rowsOf(read('asme_b16_5_wn_rf_flanges.json'), 'rows').map(
    (row): FlangeB165Row => [
      str(row, 'nps'),
      num(row, 'class'),
      num(row, 'flangeOdMm'),
      num(row, 'thicknessMinMm'),
      num(row, 'boltCircleMm'),
      num(row, 'boltCount'),
      str(row, 'boltDiameterIn'),
      num(row, 'raisedFaceDiameterMm'),
      isA(row['gradeThickness']),
      isA(row['gradeBoltPattern']),
      isA(row['gradeOdBoltCircle']),
    ],
  );

const flangesEn = (): FlangeEnRow[] => {
  const json = read('en_1092_1_flanges.json');
  const rows = (key: string, pn: number): FlangeEnRow[] =>
    rowsOf(json, key).map(
      (row): FlangeEnRow => [
        num(row, 'dn'),
        pn,
        num(row, 'dMm'),
        num(row, 'kMm'),
        num(row, 'holeMm'),
        num(row, 'holes'),
        typeof row['thicknessMm'] === 'number' ? row['thicknessMm'] : null,
        isA(row['grade']),
        false,
      ],
    );
  return [...rows('pn16', 16), ...rows('pn40', 40)];
};

const gaskets = (): GasketRow[] =>
  rowsOf(read('component_references.json')['spiralWoundGasket'] as Json, 'rows').map((row): GasketRow => {
    const dim = Object.keys(row).find((key) => key.endsWith('Mm')) as string;
    return [num(row, 'nps'), num(row, 'class'), dim.slice(0, -2), num(row, dim), isA(row['grade'])];
  });

const valves = (): ValveRow[] =>
  rowsOf(read('component_references.json')['valveFaceToFace'] as Json, 'rows').map(
    (row): ValveRow => [num(row, 'nps'), num(row, 'class'), num(row, 'faceToFaceMm'), isA(row['grade'])],
  );

/** Every bundled row, read from the pack (deterministic: file order). */
export function buildPipingData(): PipingData {
  const rating = read('asme_b16_5_pt_group_1_1.json');
  return {
    pipeB3610: pipeRows('ASME B36.10M'),
    pipeB3619: pipeRows('ASME B36.19M'),
    lr90: fittingRows('lr90', 'mm'),
    lr45: fittingRows('lr45', 'mm'),
    sr90: fittingRows('sr90', 'mm'),
    teeRun: fittingRows('teeRun', 'printedMm'),
    reducerLength: fittingRows('reducerLength', 'mm'),
    flangesB165: flangesB165(),
    flangesEn1092: flangesEn(),
    gasketsB1620: gaskets(),
    valvesB1610: valves(),
    ratingBar: rowsOf(rating, 'rows').map(
      (row): RatingBarRow => [num(row, 'class'), num(row, 'temperatureC'), num(row, 'ratingBar'), isA(row['grade'])],
    ),
    ratingPsi: rowsOf(rating, 'imperial').map(
      (row): RatingPsiRow => [num(row, 'class'), num(row, 'temperatureF'), num(row, 'ratingPsig'), isA(row['grade'])],
    ),
  };
}

interface ModuleSpec {
  readonly types: readonly string[];
  /** Exported constant -> [row type, key of PipingData]. */
  readonly constants: Readonly<Record<string, readonly [string, keyof PipingData]>>;
}

/** One generated module per data group: file name (without extension) and the constants it exports. */
export const MODULES: Readonly<Record<string, ModuleSpec>> = {
  pipeB3610: { types: ['PipeRow'], constants: { PIPE_B36_10M: ['PipeRow', 'pipeB3610'] } },
  pipeB3619: { types: ['PipeRow'], constants: { PIPE_B36_19M: ['PipeRow', 'pipeB3619'] } },
  fittingsB169: {
    types: ['FittingRow'],
    constants: {
      LR90: ['FittingRow', 'lr90'],
      LR45: ['FittingRow', 'lr45'],
      SR90: ['FittingRow', 'sr90'],
      TEE_RUN: ['FittingRow', 'teeRun'],
      REDUCER_LENGTH: ['FittingRow', 'reducerLength'],
    },
  },
  flanges: {
    types: ['FlangeB165Row', 'FlangeEnRow'],
    constants: { FLANGES_B16_5: ['FlangeB165Row', 'flangesB165'], FLANGES_EN_1092: ['FlangeEnRow', 'flangesEn1092'] },
  },
  gasketsValves: {
    types: ['GasketRow', 'ValveRow'],
    constants: { GASKETS_B16_20: ['GasketRow', 'gasketsB1620'], VALVES_B16_10: ['ValveRow', 'valvesB1610'] },
  },
  ratings: {
    types: ['RatingBarRow', 'RatingPsiRow'],
    constants: { RATING_BAR_B16_5_G11: ['RatingBarRow', 'ratingBar'], RATING_PSI_B16_5_G11: ['RatingPsiRow', 'ratingPsi'] },
  },
};

/** TypeScript source of one module (unformatted: run prettier). */
export function renderModule(name: string, data: PipingData): string {
  const spec = MODULES[name] as ModuleSpec;
  const body = Object.entries(spec.constants).map(
    ([constant, [type, key]]) => `export const ${constant}: readonly ${type}[] = ${JSON.stringify(data[key])};`,
  );
  return [
    '/** Generated by scripts/pipingCatalogGen.ts from docs/plant/01-piping-specs-catalog/validation/data; do not edit. */',
    `import type { ${spec.types.join(', ')} } from './rowTypes';`,
    ...body,
    '',
  ].join('\n');
}
