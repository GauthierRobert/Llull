/**
 * CalculiX `.dat` reader (05 §5.7): the `*NODE PRINT` / `*EL PRINT` tables, the eigenvalue / buckling-factor tables and, for the dynamic
 * steps (PHY-09 TR-DYN-31), the participation factors, effective modal mass, total effective mass, fraction of totals and the modal
 * coordinates printed per steady-state frequency (fixed layout of the CalculiX test outputs beamdy8 / beamdy10bm). A modal-mass heading printed
 * without any readable row is reported in `warnings` (never silently dropped).
 */

import type { FeResultsArtifact } from '@core/model/analysis';

type Dat = NonNullable<FeResultsArtifact['dat']>;

const TITLE = /\bfor (?:set|element set)\b.*\band time\s+(\S+)/i;

/** Titles the PHY-09 readers look the frequency-step tables up by (rows: mode then x, y, z, rx, ry, rz; totals without the mode). */
export const DAT_TITLES = {
  participation: 'participation factors (mode, x, y, z, rx, ry, rz)',
  effectiveMass: 'effective modal mass (mode, x, y, z, rx, ry, rz)',
  totalMass: 'total effective mass (x, y, z, rx, ry, rz)',
  fractions: 'fraction of totals (x, y, z, rx, ry, rz)',
  modalCoordinates: 'modal coordinates (mode, frequency cycles/time, real, imaginary)',
} as const;

/**
 * Fixed-layout tables: the heading spaced out by CalculiX, the title the table is stored under, the numbers on each row, and whether the
 * table is kept without rows (the 05 eigenvalue tables are; the PHY-09 ones only once a row is read). `timeGroup`: the heading carries the
 * table time (the steady-state frequency).
 */
const FIXED_TABLES: readonly { heading: RegExp; title: string; columns: number; lazy: boolean; timeGroup?: number }[] = [
  {
    heading: /E I G E N V A L U E\s+O U T P U T/,
    title: 'eigenvalues (mode, eigenvalue, real part rad/time, frequency cycles/time, imaginary part)',
    columns: 5,
    lazy: false,
  },
  { heading: /B U C K L I N G\s+F A C T O R\s+O U T P U T/, title: 'buckling factors (mode, factor)', columns: 2, lazy: false },
  {
    heading: /P A R T I C I P A T I O N\s+F A C T O R S\s+F O R\s+F R E Q U E N C Y\s+(\S+)/,
    title: DAT_TITLES.modalCoordinates,
    columns: 4,
    lazy: true,
    timeGroup: 1,
  },
  { heading: /P A R T I C I P A T I O N\s+F A C T O R S\s*$/, title: DAT_TITLES.participation, columns: 7, lazy: true },
  { heading: /E F F E C T I V E\s+M O D A L\s+M A S S/, title: DAT_TITLES.effectiveMass, columns: 7, lazy: true },
  { heading: /T O T A L\s+E F F E C T I V E\s+M A S S/, title: DAT_TITLES.totalMass, columns: 6, lazy: true },
  { heading: /F R A C T I O N\s+O F\s+T O T A L S/, title: DAT_TITLES.fractions, columns: 6, lazy: true },
];

/** C `%e` output with a 3-digit exponent loses its `E` in CalculiX tables: `1.52172-101` is 1.52172E-101. */
const THREE_DIGIT_EXPONENT = /^([+-]?\d*\.\d+)([+-]\d{3})$/;

const numbersOf = (line: string): number[] | null => {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return null;
  const values = tokens.map((token) => Number(token.replace(THREE_DIGIT_EXPONENT, '$1E$2')));
  return values.every(Number.isFinite) ? values : null;
};

/**
 * Tables of a `.dat` file: `title` is the CalculiX heading line (e.g. `forces (fx,fy,fz) for set XMAX and time  0.1000000E+01`), `time` the
 * time in it, `rows` the numeric lines under it (node or element id first). Lines that are neither a title nor numbers end a table.
 * @failure no table -> { tables: [] }
 */
export function parseDat(text: string): Dat {
  const tables: { title: string; time: number; rows: number[][] }[] = [];
  let open: (typeof tables)[number] | null = null;
  let fixed: { table: (typeof tables)[number]; columns: number; pushed: boolean } | null = null;
  const unread = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const heading = FIXED_TABLES.find((candidate) => candidate.heading.test(line));
    if (heading !== undefined) {
      open = null;
      const time = heading.timeGroup === undefined ? 0 : Number.parseFloat(heading.heading.exec(line)?.[heading.timeGroup] ?? '');
      fixed = { table: { title: heading.title, time, rows: [] }, columns: heading.columns, pushed: !heading.lazy };
      if (!heading.lazy) tables.push(fixed.table);
      else if (heading.title !== DAT_TITLES.modalCoordinates) unread.add(heading.title);
      continue;
    }
    if (fixed !== null) {
      const values = numbersOf(line);
      if (values !== null && values.length === fixed.columns) {
        fixed.table.rows.push(values);
        if (!fixed.pushed) tables.push(fixed.table);
        fixed.pushed = true;
        unread.delete(fixed.table.title);
      } else if (fixed.table.rows.length > 0) fixed = null;
      else continue;
      if (fixed !== null) continue;
    }
    const title = TITLE.exec(line);
    if (title !== null) {
      open = { title: line.trim().replace(/\s+/g, ' '), time: Number.parseFloat(title[1] ?? ''), rows: [] };
      tables.push(open);
      continue;
    }
    if (open === null || line.trim() === '') continue;
    const values = numbersOf(line);
    if (values === null) open = null;
    else open.rows.push(values);
  }
  const warnings = [...unread].map(
    (title) =>
      `the heading of '${title.split(' (')[0]}' is present but no row of it could be read (a ccx layout this reader does not know)`,
  );
  return { tables, ...(warnings.length > 0 ? { warnings } : {}) };
}
