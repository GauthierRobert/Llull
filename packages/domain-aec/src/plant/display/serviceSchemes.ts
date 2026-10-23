/**
 * Pipe-content colour scheme tables (plant 09 VIS §5.1, TR-VIS-03), transcribed from
 * docs/plant/09-plant-visualization-review/validation/data/service_colour_schemes.json (sources S1-S3 for ASME A13.1, S8-S9 for ISO 14726).
 * Colours are NAMED categories, never sRGB values; every row carries its source ids and grade, and conflicts between sources are kept.
 * Only the rows llull maps (ASME A13.1 and ISO 14726); BS 1710 and DIN 2403 stay documentation until a later milestone.
 */

export type SchemeId = 'asme_a13_1' | 'iso_14726';

export const SCHEME_IDS: readonly SchemeId[] = ['asme_a13_1', 'iso_14726'];

/** One selectable row: what a service can be mapped to. */
export interface SchemeRow {
  readonly scheme: SchemeId;
  readonly id: string;
  /** Name `serviceMap` values use (A13.1: `water`; ISO 14726: the medium, `sea water`); ids and ISO codes are accepted as well. */
  readonly category: string;
  readonly contents: string;
  /** Named colours reported as given: `fieldColour` + `letterColour` (A13.1) or `mainColour` (ISO 14726). */
  readonly names: Readonly<Record<string, string>>;
  /** ISO 14726 two-letter code. */
  readonly code?: string;
  readonly sources: readonly string[];
  readonly grade: string;
  readonly conflict?: string;
}

const a13 = (
  id: string,
  category: string,
  contents: string,
  fieldColour: string,
  letterColour: string,
  sources: readonly string[],
  grade: string,
  conflict?: string,
): SchemeRow => ({
  scheme: 'asme_a13_1',
  id,
  category,
  contents,
  names: { fieldColour, letterColour },
  sources,
  grade,
  ...(conflict !== undefined ? { conflict } : {}),
});

const iso = (id: string, code: string, mainColour: string, category: string, grade: string, note?: string): SchemeRow => ({
  scheme: 'iso_14726',
  id,
  code,
  category,
  contents: category,
  names: { mainColour },
  sources: ['S8', 'S9'],
  grade,
  ...(note !== undefined ? { conflict: note } : {}),
});

// prettier-ignore
export const SCHEME_ROWS: readonly SchemeRow[] = [
  a13('A13-FQ', 'fire_quenching', 'fire-quenching fluids (water / foam / CO2 for fire suppression)', 'red', 'white', ['S1', 'S2', 'S3'], 'A'),
  a13('A13-TC', 'toxic_corrosive', 'toxic and corrosive fluids', 'orange', 'black', ['S1', 'S3'], 'A', 'S2 (projectmaterials chart) prints white letters on orange; field colour agrees in all three'),
  a13('A13-FO', 'flammable_oxidizing', 'flammable fluids and oxidizing fluids (oxidizing added in 2015)', 'yellow', 'black', ['S1', 'S3'], 'A', 'S2 assigns flammable to brown/white and only oxidizing to yellow; S1 and S3 agree on yellow/black for both'),
  a13('A13-CB', 'combustible', 'combustible fluids (can burn, not flammable)', 'brown', 'white', ['S1', 'S3'], 'A'),
  a13('A13-WA', 'water', 'potable, cooling, boiler feed and other water', 'green', 'white', ['S1', 'S2', 'S3'], 'A'),
  a13('A13-CA', 'compressed_air', 'compressed air', 'blue', 'white', ['S1', 'S2', 'S3'], 'A'),
  a13('A13-U1', 'user_defined_1', 'defined by the facility', 'purple', 'white', ['S1', 'S3'], 'A'),
  a13('A13-U2', 'user_defined_2', 'defined by the facility', 'white', 'black', ['S3'], 'B'),
  a13('A13-U3', 'user_defined_3', 'defined by the facility', 'gray', 'white', ['S1'], 'B'),
  a13('A13-U4', 'user_defined_4', 'defined by the facility', 'black', 'white', ['S1', 'S3'], 'B', 'S3 (Brady) lists purple/white, white/black, brown/white, black/white as the four user pairs; S1 lists purple, gray or black backgrounds with white letters'),
  iso('ISO-BK', 'BK', 'black', 'waste media', 'A'),
  iso('ISO-BU', 'BU', 'blue', 'fresh water', 'A'),
  iso('ISO-BN', 'BN', 'brown', 'fuel', 'A'),
  iso('ISO-GN', 'GN', 'green', 'sea water', 'A'),
  iso('ISO-GY', 'GY', 'grey', 'non-flammable gases', 'A'),
  iso('ISO-MN', 'MN', 'maroon', 'air and sounding pipes', 'A (medium) / C (RAL not confirmed)'),
  iso('ISO-OG', 'OG', 'orange', 'oils other than fuels', 'A'),
  iso('ISO-SR', 'SR', 'silver', 'steam', 'A'),
  iso('ISO-RD', 'RD', 'red', 'fire fighting', 'A'),
  iso('ISO-VT', 'VT', 'violet', 'acids, alkalis', 'A'),
  iso('ISO-WH', 'WH', 'white', 'air in ventilation systems', 'A'),
  iso('ISO-YE', 'YE', 'yellow', 'flammable gases', 'A', 'yellow-ochre in ISO 14726-1:1999'),
];

export const SCHEME_STANDARDS: Readonly<Record<SchemeId, string>> = {
  asme_a13_1:
    'ASME A13.1 Scheme for the Identification of Piping Systems (colours a marker band, not the pipe; llull also tints the whole pipe for review)',
  iso_14726:
    'ISO 14726:2008 Ships and marine technology - Identification colours for the content of piping systems (main colour per medium group)',
};

export const rowsOf = (scheme: SchemeId): readonly SchemeRow[] => SCHEME_ROWS.filter((row) => row.scheme === scheme);

/** The row `category` names in `scheme`: by category / medium (case-insensitive), row id or ISO code; undefined when none. */
export function findRow(scheme: SchemeId, category: string): SchemeRow | undefined {
  const wanted = category.trim().toLowerCase();
  return rowsOf(scheme).find(
    (row) => row.category.toLowerCase() === wanted || row.id.toLowerCase() === wanted || row.code?.toLowerCase() === wanted,
  );
}

/** Legend text of a row: category plus the named colours. */
export function legendOf(row: SchemeRow): string {
  const standard = row.scheme === 'asme_a13_1' ? 'A13.1' : 'ISO 14726';
  const colours = row.names['mainColour'] ?? `${row.names['letterColour']} on ${row.names['fieldColour']}`;
  return `${row.category} (${standard}: ${colours})`;
}
