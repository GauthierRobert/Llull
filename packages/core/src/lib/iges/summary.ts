/**
 * What an IGES file claims about itself (aerospace 04 XCH M4, TR-XCH-12, TECHNICAL_SPEC §5.5): Start / Global / Directory Entry / Terminate
 * sections of the fixed 80-column format read without OpenCascade. The Global section gives the unit (exact factor to millimetres), the model
 * resolution and the sending system; the Directory Entry section gives the entity census and which types a translator ignores.
 * @invariant pure; never throws (garbage yields zero entities and `valid: false`)
 */

export interface IgesGlobal {
  readonly productId: string;
  readonly fileName: string;
  readonly system: string;
  readonly unitFlag: number | null;
  readonly unitName: string | null;
  /** Exact factor of the file unit to millimetres; null when the file names no recognised unit. */
  readonly mmPerUnit: number | null;
  /** Minimum user-intended resolution, in file units (Global field 19 of the standard); null when absent. */
  readonly resolution: number | null;
  readonly maxCoordinate: number | null;
  readonly author: string;
  readonly date: string;
}

export interface IgesSummary {
  readonly valid: boolean;
  readonly global: IgesGlobal;
  readonly entities: number;
  /** Entity type number -> count (Directory Entry section). */
  readonly census: Readonly<Record<string, number>>;
  /** Entity types an IGES-to-B-rep translator does not turn into geometry (annotation, presentation, properties), with counts and names. */
  readonly untranslated: Readonly<Record<string, number>>;
  readonly geometricEntities: number;
}

/** IGES units flag (Global field 14) -> name and millimetres per unit. */
const UNITS: Readonly<Record<number, readonly [string, number]>> = {
  1: ['inch', 25.4],
  2: ['mm', 1],
  4: ['foot', 304.8],
  5: ['mile', 1_609_344],
  6: ['m', 1000],
  7: ['km', 1_000_000],
  8: ['mil', 0.0254],
  9: ['micron', 0.001],
  10: ['cm', 10],
  11: ['microinch', 0.0000254],
};

const NAMES: Readonly<Record<number, string>> = {
  100: 'circular arc',
  102: 'composite curve',
  104: 'conic arc',
  106: 'copious data',
  108: 'plane',
  110: 'line',
  112: 'parametric spline curve',
  114: 'parametric spline surface',
  116: 'point',
  118: 'ruled surface',
  120: 'surface of revolution',
  122: 'tabulated cylinder',
  124: 'transformation matrix',
  126: 'rational B-spline curve',
  128: 'rational B-spline surface',
  130: 'offset curve',
  140: 'offset surface',
  141: 'boundary',
  142: 'curve on a parametric surface',
  143: 'bounded surface',
  144: 'trimmed parametric surface',
  186: 'manifold solid B-rep object',
  190: 'plane surface',
  192: 'right circular cylindrical surface',
  194: 'right circular conical surface',
  196: 'spherical surface',
  198: 'toroidal surface',
  202: 'angular dimension',
  206: 'diameter dimension',
  210: 'general label',
  212: 'general note',
  214: 'leader (arrow)',
  216: 'linear dimension',
  218: 'ordinate dimension',
  222: 'radius dimension',
  230: 'sectioned area',
  308: 'subfigure definition',
  314: 'color definition',
  402: 'associativity instance',
  406: 'property',
  408: 'singular subfigure instance',
  410: 'view',
  502: 'vertex list',
  504: 'edge list',
  508: 'loop',
  510: 'face',
  514: 'shell',
};

/** Types that carry geometry or topology a translator can use (the rest is annotation, colour, grouping and properties). */
const GEOMETRIC = (type: number): boolean =>
  (type >= 100 && type <= 198 && type !== 124) || (type >= 502 && type <= 514) || type === 308 || type === 408;

/** The Hollerith strings and numbers of the Global section (`nHtext` and free fields, `,` `;` or the delimiters the file declares). */
function globalFields(text: string): string[] {
  let separator = ',';
  let terminator = ';';
  let rest = text;
  const declared = /^\s*(?:(\d+)H(.)|(?=,))/.exec(rest);
  if (declared?.[1] === '1' && declared[2] !== undefined) {
    separator = declared[2];
    rest = rest.slice(declared[0].length);
    if (rest.startsWith(separator)) rest = rest.slice(1);
  } else if (declared !== null && declared[0] !== '') rest = rest.slice(declared[0].length + 1);
  else if (rest.startsWith(',')) rest = rest.slice(1);
  const second = /^\s*(\d+)H(.)/.exec(rest);
  if (second?.[1] === '1' && second[2] !== undefined) {
    terminator = second[2];
    rest = rest.slice(second[0].length);
    if (rest.startsWith(separator)) rest = rest.slice(1);
  } else if (rest.startsWith(separator)) rest = rest.slice(1);
  const fields: string[] = [];
  let at = 0;
  while (at <= rest.length) {
    const hollerith = /^\s*(\d+)H/.exec(rest.slice(at));
    if (hollerith?.[1] !== undefined) {
      const length = Number(hollerith[1]);
      const start = at + hollerith[0].length;
      fields.push(rest.slice(start, start + length));
      at = start + length;
      while (at < rest.length && rest[at] !== separator && rest[at] !== terminator) at++;
    } else {
      let end = at;
      while (end < rest.length && rest[end] !== separator && rest[end] !== terminator) end++;
      fields.push(rest.slice(at, end).trim());
      at = end;
    }
    if (at >= rest.length || rest[at] === terminator) break;
    at++;
  }
  return fields;
}

const numberOrNull = (field: string | undefined): number | null => {
  if (field === undefined || field === '') return null;
  const value = Number(field.replace(/[dD]/, 'e'));
  return Number.isFinite(value) ? value : null;
};

/** Census, unit and resolution of an IGES text. */
export function summarizeIges(text: string): IgesSummary {
  const lines = text.split(/\r?\n/);
  let globalText = '';
  let terminated = false;
  const census: Record<string, number> = {};
  let directoryLines = 0;
  let entities = 0;
  for (const line of lines) {
    if (line.length < 73) continue;
    const section = line[72];
    if (section === 'G') globalText += line.slice(0, 72).trimEnd();
    else if (section === 'T') terminated = true;
    else if (section === 'D') {
      directoryLines++;
      if (directoryLines % 2 === 1) {
        const type = Number(line.slice(0, 8));
        if (Number.isInteger(type) && type > 0) {
          census[String(type)] = (census[String(type)] ?? 0) + 1;
          entities++;
        }
      }
    }
  }
  const fields = globalFields(globalText);
  const flag = numberOrNull(fields[11]);
  const unit = flag === null ? undefined : UNITS[flag];
  const untranslated: Record<string, number> = {};
  let geometric = 0;
  for (const [key, count] of Object.entries(census)) {
    if (GEOMETRIC(Number(key))) geometric += count;
    else untranslated[NAMES[Number(key)] === undefined ? key : `${key} ${NAMES[Number(key)]}`] = count;
  }
  return {
    valid: terminated && entities > 0 && fields.length >= 12,
    global: {
      productId: fields[0] ?? '',
      fileName: fields[1] ?? '',
      system: fields[2] ?? '',
      unitFlag: flag,
      unitName: unit?.[0] ?? (fields[12] === undefined || fields[12] === '' ? null : fields[12]),
      mmPerUnit: unit?.[1] ?? null,
      resolution: numberOrNull(fields[16]),
      maxCoordinate: numberOrNull(fields[17]),
      author: fields[18] ?? '',
      date: fields[15] ?? '',
    },
    entities,
    census: Object.fromEntries(Object.entries(census).sort(([a], [b]) => Number(a) - Number(b))),
    untranslated,
    geometricEntities: geometric,
  };
}
