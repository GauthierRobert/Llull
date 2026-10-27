/** Hostile-input table: mesh file readers (STL, OBJ, PLY, 3MF), archives and the import_mesh_file command. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { inflateRaw } from '@lib/inflate';
import { parseMeshFile } from '@lib/meshFormats';
import { parseObj } from '@lib/meshFormats/obj';
import { parsePly } from '@lib/meshFormats/ply';
import { parseAsciiStl, parseBinaryStl } from '@lib/meshFormats/stl';
import { parse3mf } from '@lib/meshFormats/threeMf';
import { NO_LIMITS } from '@lib/meshFormats/types';
import { unzip } from '@lib/zipRead';
import { zipStore } from '@lib/zip';
import { asBytes, asText, orRefusal, repeated, type HostileReader } from './types';

const isOk = (result: unknown): boolean => typeof result === 'object' && result !== null && 'bodies' in result;

const objBuild = (records: number): string =>
  repeated('# mesh\n', (k) => `v ${k}.5 0 0\nv ${k}.5 1 0\nv ${k}.5 0 1\nf ${3 * k + 1} ${3 * k + 2} ${3 * k + 3}\n`, '', records);

const stlTriangle = (k: number): string =>
  ` facet normal 0 0 1\n  outer loop\n   vertex ${k} 0 0\n   vertex ${k} 1 0\n   vertex ${k} 0 1\n  endloop\n endfacet\n`;
const stlBuild = (records: number): string => repeated('solid t\n', stlTriangle, 'endsolid t\n', records);

const binaryStlBuild = (records: number): Uint8Array => {
  const out = new Uint8Array(84 + records * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, records, true);
  for (let k = 0; k < records; k++) {
    const at = 84 + k * 50;
    [0, 0, 1, k, 0, 0, k, 1, 0, k, 0, 1].forEach((value, index) => view.setFloat32(at + index * 4, value, true));
  }
  return out;
};

const plyAscii = (records: number): string =>
  repeated(
    `ply\nformat ascii 1.0\nelement vertex ${3 * records}\nproperty float x\nproperty float y\nproperty float z\nelement face ${records}\nproperty list uchar int vertex_indices\nend_header\n`,
    (k) => `${k} 0 0\n${k} 1 0\n${k} 0 1\n`,
    Array.from({ length: records }, (_, k) => `3 ${3 * k} ${3 * k + 1} ${3 * k + 2}\n`).join(''),
    records,
  );

const plyBinary = (records: number): Uint8Array => {
  const header = asBytes(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${3 * records}\nproperty float x\nproperty float y\nproperty float z\nelement face ${records}\nproperty list uchar int vertex_indices\nend_header\n`,
  );
  const out = new Uint8Array(header.length + records * (36 + 13));
  out.set(header);
  const view = new DataView(out.buffer);
  let at = header.length;
  for (let k = 0; k < records; k++) {
    for (const [x, y, z] of [
      [k, 0, 0],
      [k, 1, 0],
      [k, 0, 1],
    ] as const) {
      view.setFloat32(at, x, true);
      view.setFloat32(at + 4, y, true);
      view.setFloat32(at + 8, z, true);
      at += 12;
    }
  }
  for (let k = 0; k < records; k++) {
    out[at++] = 3;
    for (const index of [3 * k, 3 * k + 1, 3 * k + 2]) {
      view.setInt32(at, index, true);
      at += 4;
    }
  }
  return out;
};

const threeMfBuild = (records: number): Uint8Array => {
  const vertices = Array.from(
    { length: records },
    (_, k) => `<vertex x="${k}" y="0" z="0"/><vertex x="${k}" y="1" z="0"/><vertex x="${k}" y="0" z="1"/>`,
  ).join('');
  const triangles = Array.from({ length: records }, (_, k) => `<triangle v1="${3 * k}" v2="${3 * k + 1}" v3="${3 * k + 2}"/>`).join('');
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return zipStore([{ name: '3D/3dmodel.model', data: asBytes(model) }]);
};

const model = (xml: string): Uint8Array => zipStore([{ name: '3D/3dmodel.model', data: asBytes(xml) }]);

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export const MESH_READERS: readonly HostileReader[] = [
  {
    name: 'mesh: parseObj',
    covers: ['core/src/lib/meshFormats/obj.ts:parseObj'],
    input: 'text',
    build: objBuild,
    read: (input) => parseObj(asText(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: parseAsciiStl',
    covers: ['core/src/lib/meshFormats/stl.ts:parseAsciiStl'],
    input: 'text',
    build: stlBuild,
    read: (input) => parseAsciiStl(asText(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: parseBinaryStl',
    covers: ['core/src/lib/meshFormats/stl.ts:parseBinaryStl'],
    input: 'bytes',
    build: binaryStlBuild,
    read: (input) => parseBinaryStl(asBytes(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: parsePly (ascii)',
    covers: ['core/src/lib/meshFormats/ply.ts:parsePly'],
    input: 'bytes',
    build: plyAscii,
    read: (input) => parsePly(asBytes(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: parsePly (binary little endian)',
    covers: [],
    input: 'bytes',
    build: plyBinary,
    read: (input) => parsePly(asBytes(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: parse3mf',
    covers: ['core/src/lib/meshFormats/threeMf.ts:parse3mf'],
    input: 'bytes',
    build: threeMfBuild,
    extra: [
      { name: 'many unterminated tags in the model part', input: () => model('<item '.repeat(150_000)) },
      { name: 'many unterminated object elements', input: () => model('<object id="1">'.repeat(100_000)) },
      { name: 'one tag with a 2 MB attribute run', input: () => model('<item ' + 'a'.repeat(2_000_000) + '>') },
    ],
    read: (input) => parse3mf(asBytes(input), NO_LIMITS),
    accepts: isOk,
  },
  {
    name: 'mesh: parseMeshFile (sniffing, obj)',
    covers: ['core/src/lib/meshFormats/index.ts:parseMeshFile'],
    input: 'bytes',
    build: objBuild,
    read: (input) => parseMeshFile(asBytes(input)),
    accepts: isOk,
  },
  {
    name: 'mesh: import_mesh_file (execute, binary STL as base64)',
    covers: ['import_mesh_file'],
    input: 'bytes',
    build: binaryStlBuild,
    read: (input) => execute(createEmptyDocument(), 'import_mesh_file', { base64: toBase64(asBytes(input)), units: 'mm' }),
    accepts: (result) => (result as { affected: string[] }).affected.length > 0,
  },
  {
    name: 'archive: unzip (STORE entries)',
    covers: ['core/src/lib/zipRead.ts:unzip'],
    input: 'bytes',
    build: (records) => zipStore(Array.from({ length: records }, (_, k) => ({ name: `e${k}.txt`, data: asBytes(`entry ${k}`) }))),
    read: (input) => orRefusal(() => unzip(asBytes(input))),
    maxRecords: 16_000,
    accepts: (result) => Array.isArray(result),
  },
  {
    name: 'archive: inflateRaw (stored deflate blocks)',
    covers: ['core/src/lib/inflate.ts:inflateRaw'],
    input: 'bytes',
    build: (records) => {
      const out: number[] = [];
      for (let k = 0; k < records; k++) out.push(k === records - 1 ? 1 : 0, 4, 0, 0xfb, 0xff, 1, 2, 3, 4);
      return Uint8Array.from(out);
    },
    read: (input) => orRefusal(() => inflateRaw(asBytes(input))),
    accepts: (result) => result instanceof Uint8Array,
  },
];
