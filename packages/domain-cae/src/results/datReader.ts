/** CalculiX `.dat` reader (05 §5.7): the `*NODE PRINT` / `*EL PRINT` tables and the eigenvalue / buckling-factor tables. */

import type { FeResultsArtifact } from '@core/model/analysis';

type Dat = NonNullable<FeResultsArtifact['dat']>;

const TITLE = /\bfor (?:set|element set)\b.*\band time\s+(\S+)/i;

/** Eigenvalue tables: the heading spaced out by CalculiX, the title the table is stored under, and the numbers on each row. */
const EIGEN_TABLES = [
  {
    heading: /E I G E N V A L U E\s+O U T P U T/,
    title: 'eigenvalues (mode, eigenvalue, real part rad/time, frequency cycles/time, imaginary part)',
    columns: 5,
  },
  { heading: /B U C K L I N G\s+F A C T O R\s+O U T P U T/, title: 'buckling factors (mode, factor)', columns: 2 },
] as const;

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
  let eigen: { table: (typeof tables)[number]; columns: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = EIGEN_TABLES.find((candidate) => candidate.heading.test(line));
    if (heading !== undefined) {
      open = null;
      eigen = { table: { title: heading.title, time: 0, rows: [] }, columns: heading.columns };
      tables.push(eigen.table);
      continue;
    }
    if (eigen !== null) {
      const values = numbersOf(line);
      if (values !== null && values.length === eigen.columns) eigen.table.rows.push(values);
      else if (eigen.table.rows.length > 0) eigen = null;
      else continue;
      if (eigen !== null) continue;
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
  return { tables };
}
