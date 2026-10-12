import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { colorField, defineCommand, vec3, z } from '../schema';
import { noop } from '../noop';
import { add3, distance3, dot3, scale3, sub3 } from '../../lib/vec3';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { newEntity } from '../entity/newEntity';
import {
  DEFAULT_SOLID_COLOR,
  commitSolid,
  existingLayerOrDefault,
  explicitIdField,
  explicitIdOrNext,
  explicitIdTaken,
} from './shared';
import { sketchLoop } from './sketchCurves';
import { type SectionSpec, sectionSpecFields, specPolygon } from './sectionSpecs';
import { alignRing, resampleRing } from '../../geometry/sectionRing';
import { ringNormal } from '../../geometry/skin';

const MAX_LOFT_SECTIONS = 200;

/** A section placed in 3D: its plane polygon plus the plane's origin and Euler rotation. */
interface PlacedSection {
  readonly polygon: Vec2[];
  readonly origin: Vec3;
  readonly rotation: Vec3;
}

type InlineSection = SectionSpec & { center: Vec3; rotation?: Vec3 | undefined };

function placedSections(
  doc: CadDocument,
  sectionIds: readonly string[] | undefined,
  sections: readonly InlineSection[] | undefined,
): PlacedSection[] | string {
  if ((sectionIds === undefined) === (sections === undefined))
    return 'give exactly one of sectionIds or sections';
  const count = (sectionIds ?? sections ?? []).length;
  if (count < 2 || count > MAX_LOFT_SECTIONS)
    return `a loft needs 2..${MAX_LOFT_SECTIONS} sections (got ${count})`;
  const placed: PlacedSection[] = [];
  for (let i = 0; i < count; i++) {
    if (sectionIds !== undefined) {
      const loop = sketchLoop(doc, [sectionIds[i] as string]);
      if (typeof loop === 'string') return `section ${i}: ${loop}`;
      placed.push({ polygon: loop.profile, origin: loop.origin, rotation: loop.rotation });
      continue;
    }
    const spec = (sections as readonly InlineSection[])[i] as InlineSection;
    const polygon = specPolygon(doc, spec);
    if (typeof polygon === 'string') return `section ${i}: ${polygon}`;
    placed.push({ polygon, origin: spec.center, rotation: spec.rotation ?? [0, 0, 0] });
  }
  return placed;
}

const centroid = (ring: readonly Vec3[]): Vec3 =>
  scale3(
    ring.reduce<Vec3>((sum, p) => add3(sum, p), [0, 0, 0]),
    1 / ring.length,
  );

/**
 * World rings: resampled, wound counter-clockwise about the direction of travel and cyclically
 * aligned to their predecessor (no twist); or an error message.
 */
function loftRingsOf(placed: readonly PlacedSection[]): Vec3[][] | string {
  const raw = placed.map(({ polygon, origin, rotation }) =>
    resampleRing(polygon).map(([x, y]) =>
      add3(applyEulerXYZ([x, y, 0], [0, 0, 0], rotation), origin),
    ),
  );
  const centres = raw.map(centroid);
  for (let i = 1; i < centres.length; i++) {
    if (distance3(centres[i] as Vec3, centres[i - 1] as Vec3) < 1e-6)
      return `sections ${i - 1} and ${i} share the same centre; space them along the loft`;
  }
  const rings: Vec3[][] = [];
  raw.forEach((ring, i) => {
    const ahead = centres[Math.min(i + 1, centres.length - 1)] as Vec3;
    const behind = centres[Math.max(i - 1, 0)] as Vec3;
    const travel = sub3(ahead, behind);
    const oriented =
      dot3(ringNormal(ring), travel) >= 0 ? ring : [ring[0] as Vec3, ...ring.slice(1).reverse()];
    const previous = rings[i - 1];
    rings.push(previous === undefined ? oriented : alignRing(oriented, previous));
  });
  return rings;
}

/**
 * @command loft_sections
 * @pure
 * @layer core/commands
 * @affects creates 1 loft entity positioned at the first section's centre
 * @invariant >= 2 sections with distinct centres; rings share point count, winding and start
 * @failure fewer than 2 / ambiguous / invalid sections, coincident centres, duplicate id -> no-op
 */
export const loftSections = defineCommand({
  name: 'loft_sections',
  description:
    'Loft a solid through 2+ cross-sections placed in 3D, in order: transitions such as round-to-square ' +
    'ducts, tapered and flattened bike tubes, bottle and nozzle bodies, boat hulls, aero fairings. ' +
    'Right-handed world frame, +Z up. Give either `sectionIds` (closed 2D sketches: circle, ellipse, ' +
    'rectangle, closed polyline or spline; each placed by its own work-plane position and rotation) or ' +
    'inline `sections` (each a center [x, y, z], optional plane rotation (Euler XYZ radians, [0,0,0] = ' +
    'an XY-plane section), and one of radius, radiusX+radiusY, section points or sectionId). ' +
    'Sections are resampled to the same point count and aligned so the surface does not twist; ' +
    'ruled: false (default) blends smoothly through all sections, ruled: true joins neighbours with ' +
    'straight lines. Kept exact for the OCC kernel and STEP export (B-spline skin through the sections).',
  params: z.object({
    sectionIds: z
      .array(z.string())
      .describe(
        'Ids of closed 2D sketches, in loft order, each in its own (parallel or tilted) plane.',
      )
      .optional(),
    sections: z
      .array(
        z.object({
          center: vec3('Section plane origin [x, y, z] in world coordinates.'),
          rotation: vec3(
            'Section plane rotation, Euler XYZ radians; [0, 0, 0] lays the section in the XY plane.',
          ).optional(),
          ...sectionSpecFields,
        }),
      )
      .describe('Inline sections in loft order (alternative to sectionIds).')
      .optional(),
    ruled: z
      .boolean()
      .describe(
        'true: straight lines between neighbouring sections; false (default): smooth blend.',
      )
      .optional(),
    layerId: z
      .string()
      .describe('Layer id to assign the entity to. Defaults to the document default layer.')
      .optional(),
    color: colorField(DEFAULT_SOLID_COLOR),
    id: explicitIdField(),
  }),
  run: (
    doc,
    { sectionIds, sections, ruled = false, layerId, color = DEFAULT_SOLID_COLOR, id: explicitId },
  ): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `loft_sections: ${why}; no-op.`);
    if (explicitIdTaken(doc, explicitId)) return fail(`entity id "${explicitId}" already exists`);
    const placed = placedSections(doc, sectionIds, sections);
    if (typeof placed === 'string') return fail(placed);
    const world = loftRingsOf(placed);
    if (typeof world === 'string') return fail(world);
    const origin = centroid(world[0] as Vec3[]);
    const rings = world.map((ring) => ring.map((p) => sub3(p, origin)));
    const id = explicitIdOrNext(explicitId, 'loft');
    const entity = newEntity('loft', id, { rings, ruled }, origin, color, {
      layerId: existingLayerOrDefault(doc, layerId),
    });
    const span = distance3(origin, centroid(world[world.length - 1] as Vec3[]));
    return commitSolid(
      doc,
      entity,
      `loft_sections: created ${ruled ? 'ruled' : 'smooth'} loft "${id}" through ${rings.length} sections (first-to-last centre ${span.toFixed(3)})`,
    );
  },
});
