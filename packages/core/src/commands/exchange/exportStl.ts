/**
 * export_stl: read-only serialisation to STL (document returned unchanged, output in `data`).
 *
 * @layer core/commands
 */

import type { Vec3 } from '../../model/types';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { collectExportParts, exportSummary, type ExportPart } from '../../geometry/entityTriangles';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';

const formatVec3 = (v: Vec3): string => v.join(' ');

function buildAsciiStl(tris: Triangle[], solidName: string): string {
  return asciiSolidBlock(tris, solidName).join('\n');
}

/** One `solid <name>` … `endsolid <name>` block, as lines. */
function asciiSolidBlock(tris: Triangle[], solidName: string): string[] {
  const lines = [`solid ${solidName}`];
  for (const [v0, v1, v2] of tris) {
    lines.push(
      `  facet normal ${formatVec3(facetNormal(v0, v1, v2))}`,
      '    outer loop',
      `      vertex ${formatVec3(v0)}`,
      `      vertex ${formatVec3(v1)}`,
      `      vertex ${formatVec3(v2)}`,
      '    endloop',
      '  endfacet',
    );
  }
  lines.push(`endsolid ${solidName}`);
  return lines;
}

/** ASCII STL with one named `solid` block per non-empty entity (name, else id). */
function buildPerEntityAsciiStl(parts: readonly ExportPart[]): string {
  const blocks = parts
    .filter((part) => part.tris.length > 0)
    .map((part) => asciiSolidBlock(part.tris, cleanSolidName(part.name ?? part.id)));
  return blocks.length > 0 ? blocks.flat().join('\n') : buildAsciiStl([], 'llull');
}

/** Single-line solid name: control characters and line breaks would corrupt the ASCII records. */
function cleanSolidName(name: string | undefined): string {
  return (name ?? '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim() || 'llull';
}

/** Binary STL: 80-byte label header (never "solid ...", which trips ASCII sniffers), u32 count, 50 bytes per facet. */
function buildBinaryStl(tris: Triangle[], headerText: string): Uint8Array {
  const buf = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < headerText.length && i < 80; i += 1) {
    buf[i] = headerText.charCodeAt(i) & 0x7f;
  }
  view.setUint32(80, tris.length, true);
  let offset = 84;
  for (const [v0, v1, v2] of tris) {
    for (const component of [...facetNormal(v0, v1, v2), ...v0, ...v1, ...v2]) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
    offset += 2; // attribute byte count, always 0
  }
  return buf;
}

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
    'name: optional solid name embedded in the STL header (default: the entity name when exactly one named ' +
    'entity is exported, else "llull"). perEntity: one named solid block per entity (ASCII). ' +
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
    perEntity: z
      .boolean()
      .optional()
      .describe(
        'ASCII only: write one "solid <entity name or id>" … "endsolid" block per entity (names from ' +
          'set_entity_name, else the entity id) instead of one merged solid; `name` is then ignored. ' +
          'Default false. Binary STL has no per-solid names.',
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
    const collected = collectExportParts(doc, params.entityIds);
    const tris = collected.parts.flatMap((part) => part.tris);
    const triangleCount = tris.length;
    const nonEmpty = collected.parts.filter((part) => part.tris.length > 0);
    // A lone named entity names its solid; several entities need `name` or `perEntity`.
    const solidName = cleanSolidName(
      params.name ?? (nonEmpty.length === 1 ? nonEmpty[0]?.name : undefined),
    );
    const summary = exportSummary('export_stl', fmt, { ...collected, tris });
    const data: ExportStlData =
      fmt === 'ascii'
        ? {
            format: 'ascii',
            triangleCount,
            stl:
              params.perEntity === true
                ? buildPerEntityAsciiStl(collected.parts)
                : buildAsciiStl(tris, solidName),
          }
        : {
            format: 'binary',
            triangleCount,
            stlBase64: uint8ArrayToBase64(
              buildBinaryStl(tris, /^solid/i.test(solidName) ? `llull ${solidName}` : solidName),
            ),
          };
    return report(doc, summary, data);
  },
});
