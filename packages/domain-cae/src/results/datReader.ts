/** CalculiX `.dat` reader (05 §5.7): the `*NODE PRINT` / `*EL PRINT` tables. */

import type { FeResultsArtifact } from '@core/model/analysis';

type Dat = NonNullable<FeResultsArtifact['dat']>;

const TITLE = /\bfor (?:set|element set)\b.*\band time\s+(\S+)/i;

const numbersOf = (line: string): number[] | null => {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return null;
  const values = tokens.map(Number);
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
  for (const line of text.split(/\r?\n/)) {
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
