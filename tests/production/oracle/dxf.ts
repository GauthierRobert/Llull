/**
 * @layer tests/production/oracle
 *
 * Minimal, independent DXF (ASCII, R12+) reader: header extents, layer table and entities with
 * their layer, points and text — what a draughtsman sees when the file opens in AutoCAD.
 * R12 POLYLINE/VERTEX/SEQEND chains are folded into one entity with all vertices.
 */

export interface DxfEntity {
  type: string;
  layer: string;
  /** Points from 10/20 (+ 11/21 for LINE ends; every VERTEX for polylines). */
  points: [number, number][];
  /** Text content (group 1) for TEXT / MTEXT / ATTRIB. */
  text: string;
  /** Closed flag (group 70 bit 1) for polylines. */
  closed: boolean;
}

export interface DxfFile {
  header: Record<string, number[]>;
  layers: string[];
  entities: DxfEntity[];
  errors: string[];
}

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const result: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number((lines[i] ?? '').trim());
    if (!Number.isInteger(code)) return result;
    result.push([code, (lines[i + 1] ?? '').trim()]);
  }
  return result;
}

/** Split the pair stream into `0`-delimited records inside each SECTION. */
function sections(all: Pair[]): Map<string, Pair[][]> {
  const result = new Map<string, Pair[][]>();
  let name: string | null = null;
  let records: Pair[][] = [];
  for (let i = 0; i < all.length; i++) {
    const [code, value] = all[i] ?? [0, ''];
    if (code === 0 && value === 'SECTION') {
      name = all[i + 1]?.[1] ?? '';
      records = [];
      i++;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      if (name !== null) result.set(name, records);
      name = null;
      continue;
    }
    if (name === null) continue;
    if (code === 0) records.push([[code, value]]);
    else records[records.length - 1]?.push([code, value]);
  }
  return result;
}

export function parseDxf(text: string): DxfFile {
  const errors: string[] = [];
  const all = pairs(text);
  if (all.length === 0) errors.push('no group-code pairs');
  if (all[all.length - 1]?.[1] !== 'EOF') errors.push('missing EOF');
  const bySection = sections(all);
  const header = parseHeader(bySection.get('HEADER') ?? []);
  const layers = (bySection.get('TABLES') ?? [])
    .filter((record) => record[0]?.[1] === 'LAYER')
    .map((record) => record.find(([code]) => code === 2)?.[1] ?? '')
    .filter((name) => name !== '');
  const entities = foldPolylines((bySection.get('ENTITIES') ?? []).map(toEntity));
  if (!bySection.has('ENTITIES')) errors.push('missing ENTITIES section');
  for (const entity of entities) {
    if (entity.layer !== '' && !layers.includes(entity.layer) && entity.layer !== '0') {
      errors.push(`${entity.type} on undeclared layer ${entity.layer}`);
    }
  }
  return { header, layers, entities, errors };
}

/** HEADER is one record list starting at `9 $VAR`; collect the numbers after each variable. */
function parseHeader(records: Pair[][]): Record<string, number[]> {
  const header: Record<string, number[]> = {};
  let variable: string | null = null;
  for (const record of records) {
    for (const [code, value] of record) {
      if (code === 9) {
        variable = value;
        header[variable] = [];
      } else if (variable !== null && code >= 10 && code <= 70) {
        header[variable]?.push(Number(value));
      }
    }
  }
  return header;
}

function toEntity(record: Pair[]): DxfEntity {
  const value = (code: number): string => record.find(([c]) => c === code)?.[1] ?? '';
  const xs = record.filter(([code]) => code === 10 || code === 11).map(([, v]) => Number(v));
  const ys = record.filter(([code]) => code === 20 || code === 21).map(([, v]) => Number(v));
  const points: [number, number][] = xs.map((x, i) => [x, ys[i] ?? 0]);
  return {
    type: value(0),
    layer: value(8),
    points,
    text: value(1),
    closed: (Number(value(70)) & 1) === 1,
  };
}

function foldPolylines(raw: DxfEntity[]): DxfEntity[] {
  const result: DxfEntity[] = [];
  let open: DxfEntity | null = null;
  for (const entity of raw) {
    if (entity.type === 'POLYLINE') {
      open = { ...entity, points: [] };
      result.push(open);
    } else if (entity.type === 'VERTEX' && open) {
      open.points.push(...entity.points);
    } else if (entity.type === 'SEQEND') {
      open = null;
    } else result.push(entity);
  }
  return result;
}

/** Plan extents of every entity point. */
export function entityExtents(file: DxfFile): { min: [number, number]; max: [number, number] } {
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const entity of file.entities) {
    for (const [x, y] of entity.points) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
  }
  return { min, max };
}
