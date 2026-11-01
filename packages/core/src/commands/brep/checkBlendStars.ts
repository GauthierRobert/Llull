/**
 * The corner rows of check_blends (06 BLD 13.10, 13.21, 13.33, 13.36): every corner patch face is a row of kind "corner" with a contact per edge it shares. A star sub-patch (named
 * `blend(v:...)#k`) is judged at the default g0; the plate patch of the fallback at g0Corner. The contacts of a G2 star with the blend and flat faces are G2; the edges between its
 * sub-patches (spokes) are G2 seams beyond the stretch next to the vertices (G1 within it), reported with BLD_CHECK_SPOKE_G2 under `require: "G2"` (a warn), never as BLD_CHECK_G2_JUMP.
 * @invariant pure over the kernel answers; lengths in document units
 */

import { cornerSources, measureContact, STAR_SUFFIX } from '../../geometry/blend/continuity';
import { roundSignificant } from '../../lib/significant';
import { REMEDIATION, contactFindings, spokeFinding, type Finding, type Tolerances } from './checkBlendFindings';
import type { ContactSample } from '../../geometry/blend/continuity';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import { blendNodes, filletNodes } from '../../geometry/blend/blendInfo';
import type { ShapeRecipe } from '../../model/types';
import { withBlendScaleFloor } from './checkBlendTolerances';
import type { BlendRow, Contact } from './checkBlendRows';
import { creaseRowOf, type CreaseWorld } from './checkCornerCrease';

const sig = (value: number): number => roundSignificant(value, 10);

export const roundContact = (contact: ReturnType<typeof measureContact> & object): Omit<Contact, 'edge' | 'name'> => ({
  g0Gap: sig(contact.g0Gap),
  g1AngleRad: sig(contact.g1AngleRad),
  g2Gap: sig(contact.g2Gap),
  g2Rel: sig(contact.g2Rel),
  order: contact.order,
});

export interface CornerInput {
  readonly world: CreaseWorld;
  readonly samples: number;
  readonly tolerances: Tolerances;
  readonly plateTolerances: Tolerances;
  readonly requireG2: boolean;
  /** The stretch of each spoke, from its vertex, that the corner stars of this solid declare tangent-only (data.profile.corners[].spokeReach); 0: unknown, or some star has G1 spokes. */
  readonly spokeReach?: number;
}

/** The spoke stretch every G2 corner star of `recipe` declares (the notes of its blend nodes), or 0 when there is none or one of them has G1 spokes. */
export function spokeReachOf(kernel: GeometryKernel, recipe: ShapeRecipe): number {
  const stars = [...filletNodes(recipe), ...blendNodes(recipe)].flatMap((node) =>
    (kernel.blendReport?.(node)?.notes?.corners ?? []).filter((corner) => corner.continuity === 'G2'),
  );
  if (stars.length === 0 || !stars.every((corner) => corner.spokes === 'G2-beyond-reach')) return 0;
  return Math.max(...stars.map((corner) => corner.spokeReach ?? 0));
}

/** Whether the samples of the seam `edge` of a star run from its vertex (the end that touches a contact edge with a blend or flat face) to the pole, else from the pole. */
function runsFromVertex(topology: ShapeTopology, edge: number, contactEdges: readonly number[]): boolean {
  const own = topology.edges[edge];
  if (own === undefined) return true;
  const tolerance = 1e-6 * Math.max(1, own.length);
  const touches = (point: readonly number[]): boolean =>
    contactEdges.some((other) => {
      const o = topology.edges[other];
      const near = (q: readonly number[]): boolean => Math.hypot(point[0]! - q[0]!, point[1]! - q[1]!, point[2]! - q[2]!) <= tolerance;
      return o !== undefined && (near(o.start) || near(o.end));
    });
  return !(touches(own.end) && !touches(own.start));
}

type Measured = NonNullable<ReturnType<typeof measureContact>>;

/** A trimmed corner star standing this share of the diagonal on the wrong side of the part is reported (warn); the build refuses above OVERSHOOT_FAIL_FRACTION, so a fail is only read from a foreign shape. */
const OVERSHOOT_WARN_FRACTION = 1e-6;
const OVERSHOOT_FAIL_FRACTION = 1e-3;

/**
 * BLD_CHECK_CORNER_OVERSHOOT for each corner of the blend nodes of `recipe` whose notes record an `overshoot` (the rolling-ball trim builder, 13.41): warn above 1e-6 x the diagonal, fail above
 * the build gate 1e-3 x the diagonal. A corner without the key (analytic star, plate, mixed corner) raises nothing.
 */
export function overshootFindings(
  kernel: GeometryKernel,
  recipe: ShapeRecipe,
  entityId: string,
  unit: string,
  diagonal: number,
): Finding[] {
  const found: Finding[] = [];
  for (const node of [...filletNodes(recipe), ...blendNodes(recipe)])
    for (const corner of kernel.blendReport?.(node)?.notes?.corners ?? []) {
      const value = corner.overshoot;
      if (value === undefined || !(diagonal > 0) || value <= OVERSHOOT_WARN_FRACTION * diagonal) continue;
      const fails = value > OVERSHOOT_FAIL_FRACTION * diagonal;
      found.push({
        code: 'BLD_CHECK_CORNER_OVERSHOOT',
        severity: fails ? 'fail' : 'warn',
        entityId,
        value: sig(value),
        limit: sig(fails ? OVERSHOOT_FAIL_FRACTION * diagonal : OVERSHOOT_WARN_FRACTION * diagonal),
        unit,
        remediation: REMEDIATION.BLD_CHECK_CORNER_OVERSHOOT,
        message: `the corner star at (${corner.vertex.map(sig).join(', ')}) stands ${sig(value)} ${unit} on the wrong side of the part (${sig(value / diagonal)} of its diagonal; the build gate is ${OVERSHOOT_FAIL_FRACTION})`,
      });
    }
  return found;
}

/** Appends the corner rows and findings of one solid; returns how many contacts the kernel could not measure. */
export function checkCornerPatches(input: CornerInput, blends: BlendRow[], findings: Finding[]): number {
  const { world, samples, tolerances, plateTolerances, requireG2 } = input;
  const spokeReach = input.spokeReach ?? 0;
  const { kernel, shape, topology, graph, entityId, unit } = world;
  let unverified = 0;
  const longestEdgeOf = (face: number): number =>
    Math.max(...graph.edgeFaces.flatMap((around, edge) => (around.includes(face) ? [topology.edges[edge]?.length ?? 0] : [])), 0);
  const isStar = (face: number): boolean => STAR_SUFFIX.test(topology.faces[face]?.name ?? '');
  for (const face of topology.faces) {
    const sources = face.name === undefined ? null : cornerSources(face.name);
    if (sources === null || face.name === undefined) continue;
    const star = STAR_SUFFIX.test(face.name);
    // a star sub-patch is read at the blend scale like a blend face: a curvature-continuous star meets a plane to the noise of its interpolation, not exactly
    const cornerTolerances = star ? withBlendScaleFloor(tolerances, face.area, longestEdgeOf(face.index)) : plateTolerances;
    const contacts: Contact[] = [];
    const seams: Array<{ edge: number; measure: Measured; samples: readonly ContactSample[] }> = [];
    graph.edgeFaces.forEach((around, edge) => {
      if (around.length !== 2 || !around.includes(face.index)) return;
      const measured = kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null;
      // the spoke of a star that continues an edge of the part left sharp at the corner: judged by its shape, not as a tangent contact (13.33)
      const crease = measured === null ? null : creaseRowOf(world, measured, face.index, edge, cornerTolerances);
      if (crease !== null) {
        contacts.push(crease.contact);
        findings.push(...crease.findings);
        return;
      }
      // G0 over the whole contact (end points included); G1 on the open interior, the end points judged apart (three faces meet there).
      const last = (measured?.length ?? 0) - 1;
      const interior =
        measured === null
          ? null
          : measureContact(
              measured.map((sample, at) => (at === 0 || at === last ? { ...sample, g1: 0 } : sample)),
              cornerTolerances,
            );
      const ends =
        measured === null
          ? null
          : measureContact(
              measured.filter((_, at) => at === 0 || at === last),
              cornerTolerances,
            );
      if (interior === null || ends === null) return void unverified++;
      const name = topology.edges[edge]?.name;
      contacts.push({ edge, ...(name === undefined ? {} : { name }), ...roundContact(interior), g1EndAngleRad: sig(ends.g1AngleRad) });
      // a spoke of a star is held back: whether its curvature jump is a failure depends on the contacts of the whole sub-patch (below)
      const seam = star && around.every(isStar);
      if (seam) seams.push({ edge, measure: interior, samples: measured ?? [] });
      findings.push(
        ...contactFindings(entityId, face.index, edge, interior, cornerTolerances, requireG2, unit).filter(
          (found) => found.code !== 'BLD_CHECK_G2_JUMP' || (requireG2 && !seam),
        ),
      );
      if (ends.g1AngleRad > cornerTolerances.g1AngleRad)
        findings.push({
          entityId,
          face: face.index,
          edge,
          code: 'BLD_CHECK_G1_ANGLE',
          severity: 'warn',
          value: sig(ends.g1AngleRad),
          limit: sig(cornerTolerances.g1AngleRad),
          unit: 'rad',
          remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
          message: `the normals differ by ${sig(ends.g1AngleRad)} rad at an end point of edge ${edge} (corner patch ${face.index}, where three faces meet)`,
        });
    });
    // The star is a G2 star when its contacts with the blend and flat faces (the edges that are not seams) all read G2: then its seams are a warn of their own code. A star whose contacts do not
    // read G2 (a G1 star) keeps the plain BLD_CHECK_G2_JUMP on its seams, a fail under require G2.
    const outer = contacts.filter((contact) => !seams.some((seam) => seam.edge === contact.edge));
    if (requireG2 && outer.length > 0 && outer.every((contact) => contact.order === 'G2'))
      for (const seam of seams) {
        const contactEdges = outer.map((contact) => contact.edge);
        const fromVertex = runsFromVertex(topology, seam.edge, contactEdges);
        findings.push(...spokeFinding(entityId, face.index, seam.edge, seam.samples, spokeReach, fromVertex, cornerTolerances, unit));
      }
    else if (requireG2)
      for (const seam of seams)
        findings.push(
          ...contactFindings(entityId, face.index, seam.edge, seam.measure, cornerTolerances, true, unit).filter(
            (found) => found.code === 'BLD_CHECK_G2_JUMP',
          ),
        );
    blends.push({
      entityId,
      face: face.index,
      name: face.name,
      kind: 'corner',
      sourceEdges: [...sources],
      contacts,
      profile: star ? 'star' : 'patch',
    });
  }
  return unverified;
}
