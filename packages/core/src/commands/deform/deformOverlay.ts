/** deform_overlay — read-only geometry for the viewport overlays of a deformed body: frame, region slab, lattice net, flow curves, flow sheets, reference shape (01 DEF M4, FR-DEF-21). */

import type { CadDocument } from '../../model/types';
import { resolveFrame } from '../../geometry/deform/frame';
import { deformOverlay } from '../../geometry/deform/overlay';
import { referenceWire } from '../../geometry/deform/referenceWire';
import { REFERENCE_FIELDS } from '../../geometry/deform/referenceShape';
import type { Vec3 } from '../../model/vectors';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { defRejection } from './codes';
import { deformNodeOf } from './sourceMesh';
import { compareToParam, idParam } from './schema';

/** Centre and half-diagonal of the vertices of a mesh, or the unit box when it has none. */
function boundsOf(positions: ReadonlyArray<number>): { centre: Vec3; radius: number } {
  if (positions.length < 3) return { centre: [0, 0, 0], radius: 1 };
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a] as number, positions[i + a] as number);
      high[a] = Math.max(high[a] as number, positions[i + a] as number);
    }
  const size = [0, 1, 2].map((a) => (high[a] as number) - (low[a] as number));
  return {
    centre: [0, 1, 2].map((a) => ((low[a] as number) + (high[a] as number)) / 2) as unknown as Vec3,
    radius: Math.max(0.5 * Math.hypot(size[0] as number, size[1] as number, size[2] as number), 1e-9),
  };
}

/**
 * @affects none (read-only); data = frame axes, region planes, lattice net (rest and displaced), flow base / target curves, flow sheets, reference wire, all in world coordinates
 * @invariant computed on read from the recipe's outermost deform node and the mesh bounds, nothing stored; a viewport draws exactly these polylines (no geometry is derived in the UI)
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; no deform node -> DEF_NOT_DEFORMED; degenerate recorded frame -> DEF_FRAME_DEGENERATE; compareTo missing a field -> DEF_COMPARE_INVALID
 */
export const deformOverlayQuery = defineCommand({
  name: 'deform_overlay',
  annotations: { readOnly: true },
  description:
    'Geometry to DRAW a deformation for review, in world coordinates (document units): data.frame {origin, x, y, z, length} (the deformation frame axes), data.region {start, end, infinite, falloff, startCentre, endCentre, radius} ' +
    '(the slab the law acts on; infinite = the law holds on the whole axis), data.lattice {degrees, splineDegrees, oriented, rest[], moved[], box[8], displaced} (deform_lattice: control points at rest and displaced, i-major then j then k; ' +
    'splineDegrees non-null = B-spline lattice, oriented = a box with its own axes), data.flow {target[], base} (flow_along_curve: the target curve stations and, with baseCurve, the base curve), data.sheet {nx, ny, target[], base} ' +
    '(flow_on_surface: the tabulated target sheet nodes i-major and the base sheet when the base is a sheet), data.reference [[points]] (compareTo: wire of the analytic reference surface, cut to the size of the body). ' +
    'Fields that do not apply to the law are null. Read-only; computed from the recipe, nothing is stored. Next: analyze_deformation for the numbers behind the picture.',
  params: z.object({
    id: idParam.describe('Id of the deformed mesh entity (the id a deformation command returned in affected).'),
    compareTo: compareToParam.optional(),
  }),
  run: (doc: CadDocument, { id, compareTo }): CommandResult => {
    const fail = (code: string, message: string, path: string[]): CommandResult =>
      defRejection(doc, 'deform_overlay', code, message, [id], path);
    const entity = doc.entities[id];
    if (entity === undefined) return fail('DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`, ['params.id']);
    const node = deformNodeOf(entity);
    if (node === null)
      return fail('DEF_NOT_DEFORMED', `entity '${id}' (kind '${entity.kind}') has no deform node in its recipe`, ['params.id']);
    const frame = resolveFrame(node.frame);
    if (frame === null)
      return fail('DEF_FRAME_DEGENERATE', 'the recorded frame axis is zero or the reference is parallel to it', ['params.id']);
    const bounds = boundsOf(entity.kind === 'mesh' ? entity.mesh.positions : []);
    let reference: Vec3[][] | null = null;
    if (compareTo !== undefined) {
      reference = referenceWire(compareTo, bounds);
      if (reference === null)
        return fail('DEF_COMPARE_INVALID', `compareTo needs ${REFERENCE_FIELDS[compareTo.kind].join(', ')} for kind '${compareTo.kind}'`, [
          'params.compareTo',
        ]);
    }
    const overlay = deformOverlay(node.law, node.region, frame, bounds.radius);
    const parts = [
      'frame',
      ...(overlay.region === null ? [] : [overlay.region.infinite ? 'infinite region' : 'region']),
      ...(overlay.lattice === null
        ? []
        : [
            `lattice ${overlay.lattice.degrees.join('x')}${overlay.lattice.splineDegrees === null ? '' : ' B-spline'}${overlay.lattice.oriented ? ' oriented' : ''}`,
          ]),
      ...(overlay.flow === null ? [] : [overlay.flow.base === null ? 'target curve' : 'base and target curves']),
      ...(overlay.sheet === null ? [] : [overlay.sheet.base === null ? 'target sheet' : 'base and target sheets']),
      ...(reference === null ? [] : [`${compareTo?.kind ?? 'reference'} reference`]),
    ];
    return report(doc, `deform_overlay: '${id}' ${node.law.kind}: ${parts.join(', ')} (world coordinates, ${doc.units}).`, {
      id,
      unit: doc.units,
      ...overlay,
      reference,
    });
  },
});
