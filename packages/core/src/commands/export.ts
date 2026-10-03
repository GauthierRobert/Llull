/**
 * Export commands — read-only serialisation of the document to external formats.
 *
 * Each command returns the SAME document reference, affected:[], and a `data`
 * field containing the serialised output. They are safe to call at any time
 * without side effects.
 *
 * @layer core/commands
 */

import type { Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { uint8ArrayToBase64 } from '../lib/base64';
import { collectExportTriangles } from './exportTriangulate';
import { facetNormal, type Triangle } from './exportMath';

export type { Triangle } from './exportMath';
export { entityToTriangles } from './exportTriangulate';

function formatVec3(v: Vec3): string {
  return `${v[0]} ${v[1]} ${v[2]}`;
}

function buildAsciiStl(tris: Triangle[], solidName: string): string {
  const lines: string[] = [`solid ${solidName}`];
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    lines.push(`  facet normal ${formatVec3(n)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${formatVec3(v0)}`);
    lines.push(`      vertex ${formatVec3(v1)}`);
    lines.push(`      vertex ${formatVec3(v2)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// STL binary serialisation
// ---------------------------------------------------------------------------

function buildBinaryStl(tris: Triangle[], headerText: string): Uint8Array {
  const count = tris.length;
  // 80-byte header + 4-byte count + count × 50-byte triangles
  const buf = new Uint8Array(84 + count * 50);
  const view = new DataView(buf.buffer);

  // Header: ASCII solid name in the first 80 bytes (truncated; remainder stays zero).
  // STL binary headers conventionally carry a label/comment (never "solid ...", which
  // would trip ASCII-vs-binary sniffers — callers pass a plain name).
  for (let i = 0; i < headerText.length && i < 80; i += 1) {
    buf[i] = headerText.charCodeAt(i) & 0x7f;
  }
  // Triangle count at offset 80
  view.setUint32(80, count, true); // little-endian

  let offset = 84;
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    // normal (3 × float32)
    view.setFloat32(offset, n[0], true);
    offset += 4;
    view.setFloat32(offset, n[1], true);
    offset += 4;
    view.setFloat32(offset, n[2], true);
    offset += 4;
    // v0 (3 × float32)
    view.setFloat32(offset, v0[0], true);
    offset += 4;
    view.setFloat32(offset, v0[1], true);
    offset += 4;
    view.setFloat32(offset, v0[2], true);
    offset += 4;
    // v1 (3 × float32)
    view.setFloat32(offset, v1[0], true);
    offset += 4;
    view.setFloat32(offset, v1[1], true);
    offset += 4;
    view.setFloat32(offset, v1[2], true);
    offset += 4;
    // v2 (3 × float32)
    view.setFloat32(offset, v2[0], true);
    offset += 4;
    view.setFloat32(offset, v2[1], true);
    offset += 4;
    view.setFloat32(offset, v2[2], true);
    offset += 4;
    // attribute byte count (2 bytes, always 0)
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buf;
}

// ---------------------------------------------------------------------------
// ExportStl data shape (exported so tests can type-narrow)
// ---------------------------------------------------------------------------

export interface ExportStlData {
  /** Resolved format used ('ascii' | 'binary'). */
  format: 'ascii' | 'binary';
  /** Total number of triangles exported. */
  triangleCount: number;
  /** Present for format='ascii': the full ASCII STL text. */
  stl?: string;
  /** Present for format='binary': base64-encoded binary STL bytes. */
  stlBase64?: string;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * @command export_stl
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.triangleCount >= 0; data.format matches the requested format;
 *            ASCII STL wraps content in 'solid <name>'…'endsolid <name>';
 *            binary STL is 84 + triangleCount*50 bytes, base64-encoded in stlBase64
 * @failure 2D-only entities or unknown ids are silently skipped;
 *          empty selection or all-2D document → valid empty solid, triangleCount:0;
 *          never throws for user error
 */
export const exportStl = defineCommand({
  name: 'export_stl',
  annotations: { readOnly: true },
  description:
    'Export the document (or a subset of entities) to STL format — the standard triangle-mesh ' +
    'interchange format accepted by slicers, mesh editors, and 3D printers. ' +
    'Produces a triangle tessellation in world space for every exportable 3D solid entity. ' +
    '2D shape entities (line, polyline, arc, circle, rectangle, text, dimension, etc.) are ' +
    'silently skipped — STL is a solid/mesh format. ' +
    'Returns the UNCHANGED document, affected:[], and a data object with: ' +
    '  format ("ascii"|"binary"), triangleCount (number of exported triangles), ' +
    '  stl (ASCII STL string — when format="ascii"), ' +
    '  stlBase64 (base64-encoded binary STL bytes — when format="binary"). ' +
    'Supported entity kinds: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, mesh. ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'format: "ascii" (default, human-readable) or "binary" (more compact, required by some importers). ' +
    'name: optional solid name embedded in the STL header (default "llull"). ' +
    'Does NOT modify the document.',
  params: z.object({
    format: z
      .enum(['ascii', 'binary'])
      .optional()
      .describe(
        'STL output format. "ascii" (default): returns data.stl as a human-readable ASCII STL string. ' +
          '"binary": returns data.stlBase64 as a base64-encoded binary STL blob ' +
          '(84-byte header + 50 bytes per triangle). Most slicers accept both; ' +
          'binary is more compact for large meshes.',
      ),
    entityIds: z
      .array(z.string())
      .optional()
      .describe(
        'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D-only entities in the list are silently skipped. ' +
          'Unknown ids are also silently skipped with a note in summary.',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Solid name to embed in the STL header (ASCII: "solid <name>"…"endsolid <name>"; ' +
          'binary: first bytes of the 80-byte header). Default: "llull". ' +
          'Use a meaningful name to help downstream tools identify the mesh.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const fmt: 'ascii' | 'binary' = params.format === 'binary' ? 'binary' : 'ascii';
    const solidName = params.name ?? 'llull';
    const requestedIds = params.entityIds;

    const { tris: allTris, skipped2D, unknownIds } = collectExportTriangles(doc, requestedIds);

    const triangleCount = allTris.length;

    // Build summary
    const parts: string[] = [
      `export_stl: ${triangleCount} triangle${triangleCount !== 1 ? 's' : ''} exported (format=${fmt}).`,
    ];
    if (skipped2D > 0) parts.push(`${skipped2D} 2D entit${skipped2D !== 1 ? 'ies' : 'y'} skipped.`);
    if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);
    const summary = parts.join(' ');

    if (fmt === 'ascii') {
      const stl = buildAsciiStl(allTris, solidName);
      const data: ExportStlData = { format: 'ascii', triangleCount, stl };
      return { document: doc, summary, affected: [], data };
    } else {
      const bytes = buildBinaryStl(allTris, solidName);
      const stlBase64 = uint8ArrayToBase64(bytes);
      const data: ExportStlData = { format: 'binary', triangleCount, stlBase64 };
      return { document: doc, summary, affected: [], data };
    }
  },
});
