/**
 * The corner rows of check_blends (06 BLD 13.10, 13.21, 13.33, 13.36): every corner patch face is a row of kind "corner" with a contact per edge it shares. A star sub-patch (named
 * `blend(v:...)#k`) is judged at the default g0; the plate patch of the fallback at g0Corner. The contacts of a G2 star with the blend and flat faces are G2; the edges between its
 * sub-patches (spokes) are G2 seams beyond the stretch next to the vertices (G1 within it), reported with BLD_CHECK_SPOKE_G2 under `require: "G2"` (a warn), never as BLD_CHECK_G2_JUMP.
 * @invariant pure over the kernel answers; lengths in document units
 */

import { cornerSources, measureContact, STAR_SUFFIX } from '../../geometry/blend/continuity';
import { roundSignificant } from '../../lib/significant';
import { REMEDIATION, contactFindings, spokeFinding, type Finding, type Tolerances } from './checkBlendFindings';
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
}

type Measured = NonNullable<ReturnType<typeof measureContact>>;

/** Appends the corner rows and findings of one solid; returns how many contacts the kernel could not measure. */
export function checkCornerPatches(input: CornerInput, blends: BlendRow[], findings: Finding[]): number {
  const { world, samples, tolerances, plateTolerances, requireG2 } = input;
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
    const seams: Array<{ edge: number; measure: Measured }> = [];
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
      if (seam) seams.push({ edge, measure: interior });
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
      for (const seam of seams) findings.push(...spokeFinding(entityId, face.index, seam.edge, seam.measure, cornerTolerances, unit));
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
