/**
 * @layer tests/production/oracle
 *
 * Independent steel section table: nominal depth h (mm) and mass (kg/m) from the producers'
 * published tables (EN 10365 rolled I/H sections, EN 10210 hot-finished CHS). Deliberately NOT
 * read from llull's catalogue, so a catalogue error shows up as a tonnage mismatch.
 */

interface SectionFacts {
  /** Overall depth (outside diameter for CHS), mm. */
  h: number;
  kgPerM: number;
}

const SECTIONS: Record<string, SectionFacts> = {
  IPE200: { h: 200, kgPerM: 22.4 },
  IPE240: { h: 240, kgPerM: 30.7 },
  IPE270: { h: 270, kgPerM: 36.1 },
  IPE300: { h: 300, kgPerM: 42.2 },
  IPE330: { h: 330, kgPerM: 49.1 },
  IPE360: { h: 360, kgPerM: 57.1 },
  IPE400: { h: 400, kgPerM: 66.3 },
  IPE450: { h: 450, kgPerM: 77.6 },
  IPE500: { h: 500, kgPerM: 90.7 },
  HEA160: { h: 152, kgPerM: 30.4 },
  HEA200: { h: 190, kgPerM: 42.3 },
  HEA220: { h: 210, kgPerM: 50.5 },
  HEA240: { h: 230, kgPerM: 60.3 },
  HEA260: { h: 250, kgPerM: 68.2 },
  HEA300: { h: 290, kgPerM: 88.3 },
  HEB160: { h: 160, kgPerM: 42.6 },
  HEB200: { h: 200, kgPerM: 61.3 },
  HEB220: { h: 220, kgPerM: 71.5 },
  HEB240: { h: 240, kgPerM: 83.2 },
  HEB260: { h: 260, kgPerM: 93.0 },
  HEB300: { h: 300, kgPerM: 117 },
  'CHS88.9x4': { h: 88.9, kgPerM: 8.38 },
  'CHS114.3x5': { h: 114.3, kgPerM: 13.5 },
  'CHS139.7x5': { h: 139.7, kgPerM: 16.6 },
  'CHS168.3x6.3': { h: 168.3, kgPerM: 25.2 },
};

const normalize = (name: string): string => name.replace(/\s+/g, '').toUpperCase();
const BY_KEY = new Map(Object.entries(SECTIONS).map(([name, facts]) => [normalize(name), facts]));

/** Section facts by catalogue name ("hea 200" and "HEA200" both match), or null if not tabulated. */
export function section(name: string): SectionFacts | null {
  return BY_KEY.get(normalize(name)) ?? null;
}

/** Process-pipe outside diameters (EN 10220 / ASME B36.10) by nominal size DN. */
export const PIPE_OD: Record<number, number> = {
  25: 33.7,
  50: 60.3,
  80: 88.9,
  100: 114.3,
  150: 168.3,
  200: 219.1,
  250: 273.0,
  300: 323.9,
};
