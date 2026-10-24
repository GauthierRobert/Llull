/**
 * The bundled open piping catalogue `llull-open-piping` and its rating table (TR-PSC-02): expanded once from the generated data modules
 * (grade A / B rows of the 01 PSC validation pack). Every dimension carries its pack source id and `verified` = grade A; anything else is
 * reported `unverified` (AF-32). Standards without a free source (B16.11, olets, EN 10253, B16.47 …) are NOT here: they are import-only (D9).
 */

import { parseNps, parseDn } from './nominal';
import type { ComponentFamily, ComponentSize, Dim, NominalSize, PipingCatalog, Provenance, RatingTable } from './types';
import { PIPE_B36_10M } from './data/pipeB3610';
import { PIPE_B36_19M } from './data/pipeB3619';
import { LR45, LR90, REDUCER_LENGTH, SR90, TEE_RUN } from './data/fittingsB169';
import { FLANGES_B16_5, FLANGES_EN_1092 } from './data/flanges';
import { GASKETS_B16_20, VALVES_B16_10 } from './data/gasketsValves';
import { RATING_BAR_B16_5_G11, RATING_PSI_B16_5_G11 } from './data/ratings';
import type { PipeRow } from './data/rowTypes';

export const BUNDLED_CATALOG_ID = 'llull-open-piping';
export const BUNDLED_CATALOG_VERSION = '1.0.0';
export const BUNDLED_RATING_TABLE_ID = 'asme-b16.5-group-1.1';
const MM_PER_INCH = 25.4;
const PACK = 'docs/plant/01-piping-specs-catalog/validation/data';

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const mmDim = (value: number, verified: boolean, provenance: Provenance): Dim => ({ value, unit: 'mm', verified, provenance });
const nps = (key: string | number): NominalSize => parseNps(key) as NominalSize;

const pipeFamily = (id: string, standard: string, rows: readonly PipeRow[]): ComponentFamily => ({
  id,
  type: 'pipe',
  standard,
  dimensionalStandard: 'ASME',
  ends: ['BE', 'PE'],
  sizes: rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row[0] - b.row[0] || a.index - b.index)
    .map(({ row: [size, schedule, odMm, wallMm, verified] }): ComponentSize => {
      const provenance: Provenance = {
        sourceId: verified ? 'S1+S2' : 'S1',
        citation: `${standard} via fluids 1.3.1 (MIT)${verified ? ' cross-checked with formulab 0.72.3 (MIT)' : ''}; ${PACK}/asme_b36_pipe_schedules.json`,
      };
      return {
        size: nps(size),
        schedule,
        dims: { outsideDiameter: mmDim(odMm, verified, provenance), wall: mmDim(wallMm, verified, provenance) },
      };
    }),
});

const b169Provenance = (sources: string): Provenance => ({
  sourceId: sources,
  citation: `ASME B16.9 as quoted by public tables (${sources}); ${PACK}/asme_b16_9_buttweld_fittings.json`,
});

const fittingFamily = (
  id: string,
  type: ComponentFamily['type'],
  rows: ReadonlyArray<readonly [number, number, boolean, string]>,
  dim: string,
  radius?: 'LR' | 'SR',
): ComponentFamily => ({
  id,
  type,
  standard: 'ASME B16.9',
  dimensionalStandard: 'ASME',
  ...(radius === undefined ? {} : { radius }),
  ends: ['BW'],
  sizes: rows.map(([size, mm, verified, sources]) => ({ size: nps(size), dims: { [dim]: mmDim(mm, verified, b169Provenance(sources)) } })),
});

const flangeB165Family = (): ComponentFamily => ({
  id: 'asme-b16.5-wn-rf',
  type: 'flangeWeldNeck',
  standard: 'ASME B16.5',
  dimensionalStandard: 'ASME',
  ends: ['FL'],
  sizes: FLANGES_B16_5.map(
    ([
      size,
      ratingClass,
      od,
      thickness,
      boltCircle,
      boltCount,
      boltDiameterIn,
      raisedFace,
      thicknessOk,
      patternOk,
      odOk,
    ]): ComponentSize => {
      const bolt = (parseNps(boltDiameterIn)?.value ?? 0) * MM_PER_INCH;
      const provenance = (verified: boolean): Provenance => ({
        sourceId: verified ? 'S2+S3' : 'S2',
        citation: `ASME B16.5 weld-neck RF flange via formulab 0.72.3 (MIT)${verified ? ' cross-checked' : ''}; ${PACK}/asme_b16_5_wn_rf_flanges.json`,
      });
      return {
        size: nps(size),
        class: ratingClass,
        facing: 'RF',
        dims: {
          outsideDiameter: mmDim(od, odOk, { ...provenance(odOk), ...(odOk ? { sourceId: 'S2+S4' } : {}) }),
          thickness: mmDim(thickness, thicknessOk, provenance(thicknessOk)),
          boltCircle: mmDim(boltCircle, odOk, provenance(odOk)),
          boltCount: { value: boltCount, unit: 'count', verified: patternOk, provenance: provenance(patternOk) },
          boltDiameter: mmDim(round6(bolt), patternOk, provenance(patternOk)),
          raisedFaceDiameter: mmDim(raisedFace, odOk, provenance(odOk)),
        },
      };
    },
  ),
});

const flangeEnFamily = (): ComponentFamily => ({
  id: 'en-1092-1-wn',
  type: 'flangeWeldNeck',
  standard: 'EN 1092-1',
  dimensionalStandard: 'EN',
  ends: ['FL'],
  sizes: FLANGES_EN_1092.map(([dn, pn, od, boltCircle, hole, holes, thickness, odOk, holesOk]): ComponentSize => {
    const provenance = (verified: boolean): Provenance => ({
      sourceId: verified ? 'S13+S14' : 'S13',
      citation: `EN 1092-1 connection dimensions via dodo tablez/Flange_DIN-PN16.csv (LGPL-3.0)${verified ? ' and Wermac' : ''}; ${PACK}/en_1092_1_flanges.json`,
    });
    return {
      size: parseDn(dn) as NominalSize,
      pn,
      dims: {
        outsideDiameter: mmDim(od, odOk, provenance(odOk)),
        boltCircle: mmDim(boltCircle, odOk, provenance(odOk)),
        boltHole: mmDim(hole, holesOk, provenance(holesOk)),
        boltCount: { value: holes, unit: 'count', verified: holesOk, provenance: provenance(holesOk) },
        ...(thickness === null
          ? {}
          : { thickness: mmDim(thickness, false, { sourceId: 'S15', citation: 'Ahlsell listing, EN 1092-1 PN40 DN100' }) }),
      },
    };
  }),
});

const gasketFamily = (): ComponentFamily => {
  const sizes = new Map<string, ComponentSize>();
  for (const [size, ratingClass, dim, mm, verified] of GASKETS_B16_20) {
    const key = `${size}|${ratingClass}`;
    const provenance: Provenance = {
      sourceId: 'S22+S23+S24',
      citation: `ASME B16.20 spiral-wound gasket tables (Wermac, Garlock); ${PACK}/component_references.json`,
    };
    const existing = sizes.get(key);
    const dims = { ...existing?.dims, [dim]: mmDim(mm, verified, provenance) };
    sizes.set(key, { size: nps(size), class: ratingClass, dims });
  }
  return {
    id: 'asme-b16.20-spiral-wound',
    type: 'gasketSpiralWound',
    standard: 'ASME B16.20',
    dimensionalStandard: 'ASME',
    ends: ['FL'],
    sizes: [...sizes.values()],
  };
};

const valveFamily = (): ComponentFamily => ({
  id: 'asme-b16.10-gate-rf',
  type: 'valveGate',
  standard: 'ASME B16.10',
  dimensionalStandard: 'ASME',
  ends: ['FL'],
  sizes: VALVES_B16_10.map(([size, ratingClass, faceToFace, verified]) => ({
    size: nps(size),
    class: ratingClass,
    facing: 'RF',
    dims: {
      faceToFace: mmDim(faceToFace, verified, {
        sourceId: 'S20+S21',
        citation: `ASME B16.10 Class 150 RF gate valve face-to-face (Project Materials, Wermac); ${PACK}/component_references.json`,
      }),
    },
  })),
});

const reducerFamily = (): ComponentFamily => ({
  ...fittingFamily('asme-b16.9-reducer-concentric', 'reducerConcentric', REDUCER_LENGTH, 'length'),
});

function buildCatalog(): PipingCatalog {
  const families: ComponentFamily[] = [
    pipeFamily('asme-b36.10m', 'ASME B36.10M', PIPE_B36_10M),
    pipeFamily('asme-b36.19m', 'ASME B36.19M', PIPE_B36_19M),
    fittingFamily('asme-b16.9-lr90', 'elbow90', LR90, 'centreToEnd', 'LR'),
    fittingFamily('asme-b16.9-sr90', 'elbow90', SR90, 'centreToEnd', 'SR'),
    fittingFamily('asme-b16.9-lr45', 'elbow45', LR45, 'centreToEnd', 'LR'),
    fittingFamily('asme-b16.9-tee', 'tee', TEE_RUN, 'centreToEndRun'),
    reducerFamily(),
    flangeB165Family(),
    flangeEnFamily(),
    gasketFamily(),
    valveFamily(),
  ];
  return {
    format: 'llull-piping-catalog',
    schemaVersion: 1,
    id: BUNDLED_CATALOG_ID,
    version: BUNDLED_CATALOG_VERSION,
    title: 'llull open piping catalogue: transcribed grade A / B rows of the 01 PSC validation pack (every value cites its source)',
    licence: 'open-data',
    families,
  };
}

let catalog: PipingCatalog | undefined;
let rating: RatingTable | undefined;

/** The bundled catalogue (built on first use). */
export const bundledCatalog = (): PipingCatalog => (catalog ??= buildCatalog());

/** Standards llull has no free source for: import-only (D9). */
export const IMPORT_ONLY_STANDARDS: readonly string[] = [
  'ASME B16.11 (socket-weld / threaded fittings)',
  'MSS SP-97 (olets)',
  'EN 10253 (butt-weld fittings)',
  'ASME B16.47 (large-diameter flanges)',
  'ASME B16.9 caps and reducing tees',
];

/** The bundled B16.5 group 1.1 rating table. */
export function bundledRatingTable(): RatingTable {
  return (rating ??= {
    id: BUNDLED_RATING_TABLE_ID,
    standard: 'ASME B16.5',
    materialGroup: '1.1',
    minTemperatureC: -29,
    rows: RATING_BAR_B16_5_G11.map(([ratingClass, temperatureC, bar, verified]) => ({
      ratingClass,
      temperatureC,
      bar: {
        value: bar,
        unit: 'bar',
        verified,
        provenance: {
          sourceId: verified ? 'S5+S6' : 'S5',
          citation: `ASME B16.5 Table 2-1.1 as quoted by public tables; ${PACK}/asme_b16_5_pt_group_1_1.json`,
        },
      },
    })),
    imperialRows: RATING_PSI_B16_5_G11.map(([ratingClass, temperatureF, psi, verified]) => ({ ratingClass, temperatureF, psi, verified })),
  });
}
