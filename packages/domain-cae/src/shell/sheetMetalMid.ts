/**
 * Midsurface fast path of a sheet-metal part (05 §5.2 step 6, 07 FTR recipes): every flat's outline (with its cutouts) on the mid plane of the
 * sheet, and every bend as a faceted cylinder strip of the mid radius joining the two flats. Reads `CadDocument.sheetMetal` (core model data only:
 * the `sheetmetal` plugin is not imported).
 */

import type { CadDocument } from '@core/model/types';
import type { Frame3, SheetMetalPart, SheetNode } from '@core/model/sheetMetal';
import type { Vec2, Vec3 } from '@core/model/vectors';
import { applyMat3, matFromAxisAngle } from '@lib/axisRotation';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import type { MidFace, Midsurface, MidsurfaceRefusal } from './types';

type FlatNode = Extract<SheetNode, { type: 'flat' }>;
type BendNode = Extract<SheetNode, { type: 'bend' }>;

/** Largest angle one faceted bend strip spans (radians): 15 degrees keeps the chord within 0.9 % of the mid radius. */
const STRIP_ANGLE = Math.PI / 12;

/** The sheet-metal part that describes `entityId` (its derived folded solid, or the solid it was converted from). */
export function sheetMetalPartOf(doc: CadDocument, entityId: string): SheetMetalPart | undefined {
  return Object.values(doc.sheetMetal?.parts ?? {}).find((part) => part.id === entityId || part.sourceEntity === entityId);
}

function frameYDir(frame: Frame3): Vec3 {
  return normalize3(cross3(frame.normal, frame.xDir));
}

const onFrame = (frame: Frame3, zMid: number, [x, y]: Vec2): Vec3 =>
  add3(add3(add3(frame.origin, scale3(normalize3(frame.xDir), x)), scale3(frameYDir(frame), y)), scale3(normalize3(frame.normal), zMid));

/** Newell normal of a closed polygon (not normalised). */
function polygonNormal(points: readonly Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0];
  points.forEach((a, index) => {
    const b = points[(index + 1) % points.length] ?? a;
    n = add3(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  });
  return n;
}

/** `points` ordered counter-clockwise about `normal`. */
export function orientedAbout(points: readonly Vec3[], normal: Vec3): Vec3[] {
  return dot3(polygonNormal(points), normal) < 0 ? [...points].reverse() : [...points];
}

function flatFace(flat: FlatNode, zMid: number, thickness: number): MidFace {
  const normal = normalize3(flat.frame.normal);
  return {
    outer: orientedAbout(
      flat.outline.map((point) => onFrame(flat.frame, zMid, point)),
      normal,
    ),
    holes: flat.cutouts.map((cutout) =>
      orientedAbout(
        cutout.points.map((point) => onFrame(flat.frame, zMid, point)),
        normal,
      ).reverse(),
    ),
    normal,
    thickness,
    source: `flat ${flat.id}`,
  };
}

/** Faceted mid strips of one bend, or a note when the bend cannot be built from its two flats. */
function bendFaces(
  bend: BendNode,
  from: FlatNode,
  to: FlatNode,
  zMid: number,
  thickness: number,
  stripLength?: number,
): MidFace[] | string {
  const [p, q] = bend.lineInFrom;
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (!(length > 0)) return `bend ${bend.id} has a zero-length bend line`;
  const a0 = onFrame(from.frame, zMid, p);
  const b0 = onFrame(from.frame, zMid, q);
  const axis = normalize3(sub3(b0, a0));
  const a1 = add3(to.frame.origin, scale3(normalize3(to.frame.normal), zMid));
  const b1 = add3(a1, scale3(normalize3(to.frame.xDir), length));
  const outward = normalize3(cross3(normalize3(from.frame.normal), axis));
  const n0 = normalize3(from.frame.normal);
  const tangent1 = frameYDir(to.frame);
  const theta = Math.atan2(dot3(cross3(outward, tangent1), axis), dot3(outward, tangent1));
  const chordVector = sub3(a1, a0);
  const chord = len3(sub3(chordVector, scale3(axis, dot3(chordVector, axis))));
  if (Math.abs(theta) < 1e-9) {
    if (chord < 1e-9 * Math.max(1, length)) return [];
    const strip = [a0, b0, b1, a1];
    return [{ outer: orientedAbout(strip, n0), holes: [], normal: n0, thickness, source: `bend ${bend.id} (flat)` }];
  }
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const centre = add3(a0, scale3(normalize3(cross3(axis, outward)), radius * Math.sign(theta)));
  // At most 15 degrees per strip, and no more strips than the mesh can resolve: a strip shorter than the element size only adds slivers.
  const byMesh = stripLength !== undefined && stripLength > 0 ? Math.ceil((radius * Math.abs(theta)) / stripLength) : Infinity;
  const strips = Math.max(1, Math.min(Math.ceil(Math.abs(theta) / STRIP_ANGLE), byMesh));
  const along = sub3(b0, a0);
  const at = (k: number): Vec3 => add3(centre, applyMat3(matFromAxisAngle(axis, (theta * k) / strips), sub3(a0, centre)));
  const end = at(strips);
  if (len3(sub3(end, a1)) > Math.max(1e-6 * radius, 1e-3 * thickness))
    return `bend ${bend.id}: the mid arc ends ${len3(sub3(end, a1)).toPrecision(3)} away from flat ${to.id}`;
  const faces: MidFace[] = [];
  for (let k = 0; k < strips; k++) {
    const start = k === 0 ? a0 : at(k);
    const stop = k === strips - 1 ? a1 : at(k + 1);
    const normal = normalize3(applyMat3(matFromAxisAngle(axis, (theta * (k + 0.5)) / strips), n0));
    const strip = [start, add3(start, along), add3(stop, along), stop];
    faces.push({ outer: orientedAbout(strip, normal), holes: [], normal, thickness, source: `bend ${bend.id} strip ${k + 1}/${strips}` });
  }
  return faces;
}

/**
 * Midsurface of a sheet-metal part: flats on the mid plane (z = zBottom + T / 2 of each flat frame) and bends as strips of at most 15 degrees
 * on the mid radius. Forms (flanged holes, beads) are not on the midsurface: each is a warning.
 * @failure part without a rule / thickness -> FEA_MIDSURFACE_FAILED; a bend whose arc does not reach its child flat -> FEA_MIDSURFACE_FAILED
 */
export function sheetMetalMidsurface(
  doc: CadDocument,
  entityId: string,
  part: SheetMetalPart,
  stripLength?: number,
): Midsurface | MidsurfaceRefusal {
  const rule = doc.sheetMetal?.rules[part.rule];
  if (rule === undefined || !(rule.thickness > 0))
    return { code: 'FEA_MIDSURFACE_FAILED', message: `sheet-metal part '${part.id}' has no rule '${part.rule}' with a thickness` };
  const thickness = rule.thickness;
  const zMid = part.side === 'up' ? thickness / 2 : part.side === 'down' ? -thickness / 2 : 0;
  const faces: MidFace[] = [];
  const warnings: string[] = [];
  const flatOf = (id: string): FlatNode | undefined => {
    const node = part.nodes[id];
    return node?.type === 'flat' ? node : undefined;
  };
  for (const id of part.order) {
    const node = part.nodes[id];
    if (node?.type === 'flat') faces.push(flatFace(node, zMid, thickness));
    else if (node?.type === 'bend') {
      const from = flatOf(node.from);
      const to = flatOf(node.to);
      if (from === undefined || to === undefined)
        return { code: 'FEA_MIDSURFACE_FAILED', message: `bend ${node.id} of '${part.id}' does not join two flats` };
      const strips = bendFaces(node, from, to, zMid, thickness, stripLength);
      if (typeof strips === 'string') return { code: 'FEA_MIDSURFACE_FAILED', message: `sheet-metal part '${part.id}': ${strips}` };
      faces.push(...strips);
    } else if (node?.type === 'form')
      warnings.push(`form ${node.id} (${node.form.kind}) is not on the midsurface: the flat is meshed without its lip / bead`);
  }
  if (faces.length === 0) return { code: 'FEA_MIDSURFACE_FAILED', message: `sheet-metal part '${part.id}' has no flat` };
  return { entityId, method: 'sheet_metal', faces, thicknesses: [thickness], coverage: 1, unpairedFaces: [], warnings };
}
