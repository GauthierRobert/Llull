/**
 * Metric ISO fastener set as an `llull-fastener-catalog` file (test data; nothing is bundled in the package, OQ-MAT-01): ISO 4762 socket
 * head cap screws and ISO 4014 hex head bolts M4-M12 coarse, ISO 7089 washers, ISO 4032 nuts, ISO 273 clearance holes (fine / medium / coarse).
 * Every value is a typical / nominal dimension of the standard, NOT verified against the licensed text: each carries that in provenance.note.
 */

const NOTE = 'typical/nominal dimensions of the standard; unverified against the licensed text — verify before release';
const prov = (standard: string): { citation: string; note: string } => ({ citation: standard, note: NOTE });
const mm = (value: number): { value: number; unit: 'mm' } => ({ value, unit: 'mm' });

/** dash -> coarse pitch, head Ø (ISO 4762 dk max), head height (k = d), hex across flats (ISO 4014 s), hex across corners (e min), hex head height k, nut s, nut m max, washer d2, washer h */
const SIZES = {
  '4': { pitch: 0.7, dk: 7, k4762: 4, s: 7, e: 7.66, k4014: 2.8, nutM: 3.2, d2: 9, h: 0.8, hole: [4.3, 4.5, 4.8] },
  '5': { pitch: 0.8, dk: 8.5, k4762: 5, s: 8, e: 8.79, k4014: 3.5, nutM: 4.7, d2: 10, h: 1, hole: [5.3, 5.5, 5.8] },
  '6': { pitch: 1, dk: 10, k4762: 6, s: 10, e: 11.05, k4014: 4, nutM: 5.2, d2: 12, h: 1.6, hole: [6.4, 6.6, 7] },
  '8': { pitch: 1.25, dk: 13, k4762: 8, s: 13, e: 14.38, k4014: 5.3, nutM: 6.8, d2: 16, h: 1.6, hole: [8.4, 9, 10] },
  '10': { pitch: 1.5, dk: 16, k4762: 10, s: 16, e: 17.77, k4014: 6.4, nutM: 8.4, d2: 20, h: 2, hole: [10.5, 11, 12] },
  '12': { pitch: 1.75, dk: 18, k4762: 12, s: 18, e: 20.03, k4014: 7.5, nutM: 10.8, d2: 24, h: 2.5, hole: [13, 13.5, 14.5] },
} as const;

const dash = (key: string): number => Number(key);
const nominal = (value: number, standard: string): Record<string, unknown> => ({ nominal: value, unit: 'mm', provenance: prov(standard) });

function boltSizes(head: (size: (typeof SIZES)[keyof typeof SIZES]) => Record<string, unknown>): unknown[] {
  return Object.entries(SIZES).map(([key, size]) => ({
    dash: key,
    nominalDiameter: mm(dash(key)),
    thread: `M${key}x${size.pitch}`,
    threadsPerInch: 25.4 / size.pitch,
    threadLength: mm(2 * dash(key) + 6),
    dims: {
      ...head(size),
      clearanceHoleDiameter: {
        min: size.hole[0],
        nominal: size.hole[1],
        max: size.hole[2],
        options: [...size.hole],
        unit: 'mm',
        provenance: prov('ISO 273 (fine / medium / coarse; nominal = medium)'),
      },
    },
  }));
}

const boltGrammar = (prefix: string): unknown[] => [
  { kind: 'literal', text: prefix },
  { kind: 'int', name: 'diameterDash' },
  { kind: 'literal', text: 'x' },
  { kind: 'int', name: 'gripDash', scale: 1, unit: 'mm' },
];

const boltFamily = (id: string, standard: string, sizes: unknown[]): Record<string, unknown> => ({
  id,
  kind: 'bolt',
  standard: { body: 'ISO', id },
  partNumber: boltGrammar(`${id}-M`),
  gripIncrement: mm(1),
  gripMode: 'min_grip_ge_stack',
  lengthRule: { kind: 'grip_plus_thread' },
  sizes,
  availableGripDash: { min: 1, max: 150 },
  licence: 'vendor-catalogue',
  provenance: prov(standard),
});

export function isoMetricCatalogFile(): Record<string, unknown> {
  return {
    format: 'llull-fastener-catalog',
    schemaVersion: 1,
    title: 'ISO metric fasteners M4-M12 (typical/nominal, unverified; test fixture)',
    families: [
      boltFamily(
        'ISO4762',
        'ISO 4762 socket head cap screw',
        boltSizes((size) => ({ headDiameter: nominal(size.dk, 'ISO 4762 dk max'), headHeight: nominal(size.k4762, 'ISO 4762 k = d') })),
      ),
      boltFamily(
        'ISO4014',
        'ISO 4014 hex head bolt',
        boltSizes((size) => ({
          headDiameter: nominal(size.e, 'ISO 4014 e min (across corners)'),
          acrossFlats: nominal(size.s, 'ISO 4014 s'),
          headHeight: nominal(size.k4014, 'ISO 4014 k'),
        })),
      ),
      {
        id: 'ISO4032',
        kind: 'nut',
        standard: { body: 'ISO', id: 'ISO 4032' },
        partNumber: [
          { kind: 'literal', text: 'ISO4032-M' },
          { kind: 'int', name: 'diameterDash' },
        ],
        sizes: Object.entries(SIZES).map(([key, size]) => ({
          dash: key,
          nominalDiameter: mm(dash(key)),
          thread: `M${key}x${size.pitch}`,
          dims: { height: nominal(size.nutM, 'ISO 4032 m max'), acrossFlats: nominal(size.s, 'ISO 4032 s max') },
        })),
        licence: 'vendor-catalogue',
        provenance: prov('ISO 4032 hexagon nut style 1'),
      },
      {
        id: 'ISO7089',
        kind: 'washer',
        standard: { body: 'ISO', id: 'ISO 7089' },
        partNumber: [
          { kind: 'literal', text: 'ISO7089-M' },
          { kind: 'int', name: 'diameterDash' },
        ],
        sizes: Object.entries(SIZES).map(([key, size]) => ({
          dash: key,
          nominalDiameter: mm(dash(key)),
          dims: {
            od: nominal(size.d2, 'ISO 7089 d2'),
            thickness: { options: [size.h], nominal: size.h, unit: 'mm', provenance: prov('ISO 7089 h') },
          },
        })),
        licence: 'vendor-catalogue',
        provenance: prov('ISO 7089 plain washer, normal series, product grade A'),
      },
    ],
  };
}
