/** PLY reader: ascii, binary_little_endian, binary_big_endian; vertex x y z and the face index list are read, every other property is dropped. */

import { type MeshParseFailure, type ParsedMeshFile, parseFailure } from './types';

type ScalarType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';

const ALIASES: Readonly<Record<string, ScalarType>> = {
  char: 'char',
  int8: 'char',
  uchar: 'uchar',
  uint8: 'uchar',
  short: 'short',
  int16: 'short',
  ushort: 'ushort',
  uint16: 'ushort',
  int: 'int',
  int32: 'int',
  uint: 'uint',
  uint32: 'uint',
  float: 'float',
  float32: 'float',
  double: 'double',
  float64: 'double',
};
const SIZE: Readonly<Record<ScalarType, number>> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

interface Property {
  readonly name: string;
  readonly type: ScalarType;
  readonly listCount?: ScalarType;
}
interface Element {
  readonly name: string;
  readonly count: number;
  readonly properties: Property[];
}

interface Cursor {
  next(type: ScalarType): number;
}

function binaryCursor(bytes: Uint8Array, start: number, little: boolean): Cursor {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  return {
    next(type) {
      if (at + SIZE[type] > bytes.length) throw new Error('unexpected end of PLY data');
      const offset = at;
      at += SIZE[type];
      switch (type) {
        case 'char':
          return view.getInt8(offset);
        case 'uchar':
          return view.getUint8(offset);
        case 'short':
          return view.getInt16(offset, little);
        case 'ushort':
          return view.getUint16(offset, little);
        case 'int':
          return view.getInt32(offset, little);
        case 'uint':
          return view.getUint32(offset, little);
        case 'float':
          return view.getFloat32(offset, little);
        case 'double':
          return view.getFloat64(offset, little);
      }
    },
  };
}

function asciiCursor(text: string): Cursor {
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  let at = 0;
  return {
    next() {
      const value = Number(tokens[at++]);
      if (!Number.isFinite(value)) throw new Error('bad number in PLY body');
      return value;
    },
  };
}

function parseHeader(head: string, size: number): { format: string; elements: Element[] } | string {
  const lines = head.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== 'ply') return 'missing "ply" magic';
  let format = '';
  const elements: Element[] = [];
  for (const line of lines.slice(1)) {
    const [keyword, ...rest] = line.split(/\s+/);
    if (keyword === 'format') format = rest[0] ?? '';
    else if (keyword === 'element') elements.push({ name: rest[0] ?? '', count: Number(rest[1]), properties: [] });
    else if (keyword === 'property' && elements.length > 0) {
      const target = elements[elements.length - 1] as Element;
      if (rest[0] === 'list') {
        const countType = ALIASES[rest[1] ?? ''];
        const itemType = ALIASES[rest[2] ?? ''];
        if (countType === undefined || itemType === undefined) return `bad list property "${line}"`;
        target.properties.push({ name: rest[3] ?? '', type: itemType, listCount: countType });
      } else {
        const type = ALIASES[rest[0] ?? ''];
        if (type === undefined) return `unknown property type in "${line}"`;
        target.properties.push({ name: rest[1] ?? '', type });
      }
    }
  }
  if (!elements.every((e) => Number.isInteger(e.count) && e.count >= 0)) return 'bad element count';
  // every row costs at least one byte (binary) or one token (ascii): a larger count cannot be real
  const oversized = elements.find((e) => e.count > size);
  return oversized !== undefined ? `element ${oversized.name} claims ${oversized.count} rows in a ${size} byte file` : { format, elements };
}

function readElements(elements: Element[], cursor: Cursor): { positions: number[]; triangles: number[]; dropped: string[] } {
  const positions: number[] = [];
  const triangles: number[] = [];
  const dropped = new Set<string>();
  for (const element of elements) {
    if (element.properties.length === 0) continue;
    for (let row = 0; row < element.count; row++) {
      const xyz: Record<string, number> = {};
      for (const property of element.properties) {
        if (property.listCount !== undefined) {
          const length = cursor.next(property.listCount);
          const items = Array.from({ length }, () => cursor.next(property.type));
          if (element.name === 'face' && (property.name === 'vertex_indices' || property.name === 'vertex_index')) {
            for (let k = 1; k + 1 < items.length; k++) triangles.push(items[0] as number, items[k] as number, items[k + 1] as number);
          } else dropped.add(`${element.name}.${property.name}`);
        } else {
          const value = cursor.next(property.type);
          if (element.name === 'vertex' && ['x', 'y', 'z'].includes(property.name)) xyz[property.name] = value;
          else dropped.add(`${element.name}.${property.name}`);
        }
      }
      if (element.name === 'vertex') positions.push(xyz['x'] ?? NaN, xyz['y'] ?? NaN, xyz['z'] ?? NaN);
    }
  }
  return { positions, triangles, dropped: [...dropped].sort() };
}

export function parsePly(bytes: Uint8Array): ParsedMeshFile | MeshParseFailure {
  const marker = 'end_header';
  const headText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const markerAt = /^end_header\s*$/m.exec(headText)?.index ?? -1;
  if (markerAt < 0) return parseFailure('MESH_IMPORT_PARSE', 'PLY header has no end_header');
  let bodyStart = markerAt + marker.length;
  if (headText[bodyStart] === '\r') bodyStart++;
  if (headText[bodyStart] === '\n') bodyStart++;
  const header = parseHeader(headText.slice(0, markerAt), bytes.length);
  if (typeof header === 'string') return parseFailure('MESH_IMPORT_PARSE', `PLY header: ${header}`);
  try {
    const cursor =
      header.format === 'ascii'
        ? asciiCursor(new TextDecoder().decode(bytes.subarray(bodyStart)))
        : header.format === 'binary_little_endian' || header.format === 'binary_big_endian'
          ? binaryCursor(bytes, bodyStart, header.format === 'binary_little_endian')
          : null;
    if (cursor === null) {
      return parseFailure('MESH_IMPORT_PARSE', `PLY format "${header.format}" is not ascii, binary_little_endian or binary_big_endian`);
    }
    const { positions, triangles, dropped } = readElements(header.elements, cursor);
    const vertexCount = positions.length / 3;
    if (!positions.every(Number.isFinite)) return parseFailure('MESH_IMPORT_PARSE', 'PLY vertices lack x, y or z');
    if (triangles.some((i) => !Number.isInteger(i) || i < 0 || i >= vertexCount)) {
      return parseFailure('MESH_IMPORT_PARSE', `PLY face index outside 0..${vertexCount - 1}`);
    }
    return { format: 'ply', bodies: [{ positions, triangles, groups: [] }], dropped };
  } catch (error) {
    return parseFailure('MESH_IMPORT_PARSE', error instanceof Error ? error.message : 'unreadable PLY body');
  }
}
