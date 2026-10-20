/** VTK XML UnstructuredGrid (`.vtu`) of a mesh artifact and, optionally, its results (05 §4 `fea_export format vtu`, M5). Pure; ASCII or inline base64 arrays. */

import type { FeElementType, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { num } from '../decks/format';
import { vonMises } from './fields';

/** VTK cell type of each element type; quadratic elements keep the corner-then-mid-edge node order shared by Abaqus and VTK. */
const CELL_TYPES: Readonly<Record<FeElementType, number>> = {
  C3D4: 10,
  C3D10: 24,
  CPS3: 5,
  CPS4: 9,
  CPS6: 22,
  CPS8: 23,
  S3: 5,
  S4: 9,
  S6: 22,
  S8: 23,
};

export type VtuEncoding = 'ascii' | 'base64';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const group = (a << 16) | (b << 8) | c;
    out += BASE64.charAt((group >> 18) & 63) + BASE64.charAt((group >> 12) & 63);
    out += at + 1 < bytes.length ? BASE64.charAt((group >> 6) & 63) : '=';
    out += at + 2 < bytes.length ? BASE64.charAt(group & 63) : '=';
  }
  return out;
}

type ArrayType = 'Float64' | 'Int32' | 'UInt8';

/** Inline binary block: base64 of the UInt32 byte count, then base64 of the little-endian data (VTK encodes them separately, no compression). */
function binary(type: ArrayType, values: readonly number[]): string {
  const size = type === 'Float64' ? 8 : type === 'Int32' ? 4 : 1;
  const data = new Uint8Array(values.length * size);
  const view = new DataView(data.buffer);
  values.forEach((value, index) => {
    if (type === 'Float64') view.setFloat64(index * 8, value, true);
    else if (type === 'Int32') view.setInt32(index * 4, value, true);
    else view.setUint8(index, value);
  });
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, data.length, true);
  return `${base64(header)}${base64(data)}`;
}

/** One `<DataArray>` element. */
function dataArray(
  name: string,
  type: ArrayType,
  components: number,
  values: readonly number[],
  encoding: VtuEncoding,
  indent: string,
): string {
  const attributes = `type="${type}" Name="${name}" NumberOfComponents="${components}"`;
  if (encoding === 'base64') return `${indent}<DataArray ${attributes} format="binary">${binary(type, values)}</DataArray>`;
  const body = type === 'Float64' ? values.map(num).join(' ') : values.join(' ');
  return `${indent}<DataArray ${attributes} format="ascii">${body}</DataArray>`;
}

/** `name` as an XML attribute value: only letters, digits and underscores survive. */
const arrayName = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * VTU text of `mesh`: points (node order of the artifact), one cell per element with the part index in the cell array `part` and the element id in
 * `element_id`; with `results`, point arrays per result set `k` (1-based, artifact order): `U_k` (displacement vector), `von_mises_k` and `S_k` (sxx, syy,
 * szz, sxy, syz, szx) where the set has STRESS, and for a modal / buckling set `mode_k` the same `U_k`. Nodes without a value get 0.
 * @invariant byte-identical for identical inputs; every cell node exists (an element with an unknown node is dropped and counted in `dropped`)
 */
export function writeVtu(
  mesh: FeMeshArtifact,
  results: FeResultsArtifact | null,
  encoding: VtuEncoding = 'ascii',
): { readonly text: string; readonly cells: number; readonly dropped: number } {
  const index = new Map(mesh.nodes.map((node, position) => [node[0], position] as const));
  const parts = [...new Set(mesh.blocks.map((block) => block.entityId))];
  const connectivity: number[] = [];
  const offsets: number[] = [];
  const types: number[] = [];
  const partIndex: number[] = [];
  const elementIds: number[] = [];
  let dropped = 0;
  for (const block of mesh.blocks)
    for (const [id = 0, ...nodes] of block.elements) {
      const positions = nodes.map((node) => index.get(node));
      if (positions.some((position) => position === undefined)) {
        dropped++;
        continue;
      }
      connectivity.push(...(positions as number[]));
      offsets.push(connectivity.length);
      types.push(CELL_TYPES[block.type]);
      partIndex.push(parts.indexOf(block.entityId));
      elementIds.push(id);
    }
  const pointArrays: string[] = [];
  results?.steps.forEach((step, position) => {
    const k = position + 1;
    const pick = (field: string, width: number): number[] =>
      mesh.nodes.flatMap((node) => {
        const values = step.fields[field]?.values[String(node[0])] ?? [];
        return Array.from({ length: width }, (_, component) => values[component] ?? 0);
      });
    if (step.fields['DISP'] !== undefined) pointArrays.push(dataArray(`U_${k}`, 'Float64', 3, pick('DISP', 3), encoding, '        '));
    if (step.fields['STRESS'] !== undefined) {
      pointArrays.push(dataArray(`S_${k}`, 'Float64', 6, pick('STRESS', 6), encoding, '        '));
      const mises = mesh.nodes.map((node) => vonMises(step.fields['STRESS']?.values[String(node[0])] ?? []));
      pointArrays.push(dataArray(`von_mises_${k}`, 'Float64', 1, mises, encoding, '        '));
    }
  });
  const lines = [
    '<?xml version="1.0"?>',
    `<!-- llull ${arrayName(mesh.unitSystem)} ${mesh.nodes.length} nodes ${types.length} cells; parts: ${parts.map(arrayName).join(', ')} -->`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    '  <UnstructuredGrid>',
    `    <Piece NumberOfPoints="${mesh.nodes.length}" NumberOfCells="${types.length}">`,
    '      <Points>',
    dataArray(
      'Points',
      'Float64',
      3,
      mesh.nodes.flatMap((node) => [node[1], node[2], node[3]]),
      encoding,
      '        ',
    ),
    '      </Points>',
    '      <Cells>',
    dataArray('connectivity', 'Int32', 1, connectivity, encoding, '        '),
    dataArray('offsets', 'Int32', 1, offsets, encoding, '        '),
    dataArray('types', 'UInt8', 1, types, encoding, '        '),
    '      </Cells>',
    '      <CellData>',
    dataArray('part', 'Int32', 1, partIndex, encoding, '        '),
    dataArray('element_id', 'Int32', 1, elementIds, encoding, '        '),
    '      </CellData>',
    ...(pointArrays.length === 0 ? [] : ['      <PointData>', ...pointArrays, '      </PointData>']),
    '    </Piece>',
    '  </UnstructuredGrid>',
    '</VTKFile>',
  ];
  return { text: `${lines.join('\n')}\n`, cells: types.length, dropped };
}
