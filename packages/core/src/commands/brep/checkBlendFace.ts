/** The row of one edge blend face of check_blends: contacts with its supports, junctions with the next blend of its chain, radius law read-back, cliff edge. */

import { measureContact, type blendSource } from '../../geometry/blend/continuity';
import type { BlendFaceContacts } from '../../geometry/blend/blendInfo';
import { cliffEdgeOf } from '../../geometry/blend/cliffEdge';
import type { ShapeTopology } from '../../geometry/kernel';
import { roundSignificant } from '../../lib/significant';
import { judgeJunction, junctionsOf, supportCrease } from './blendJunctions';
import { REMEDIATION, cliffFinding, contactFindings, type Finding, type Tolerances } from './checkBlendFindings';
import { PROFILE_G0_FACTOR, withBlendScaleFloor } from './checkBlendTolerances';
import { RADIUS_LAW_TOLERANCE, checkRadius, type LawRecord } from './checkBlendRadius';
import { roundContact } from './checkBlendStars';
import type { BlendRow, Contact } from './checkBlendRows';
import type { CreaseWorld } from './checkCornerCrease';

const sig = (value: number): number => roundSignificant(value, 10);

/** What the row of a blend face reads: the exact shape with its face graph, the recipe's law records, and the tolerances of the solid. */
export interface BlendFaceWorld extends CreaseWorld {
  readonly laws: ReadonlyMap<number, LawRecord>;
  readonly contactsOf: ReadonlyMap<number, BlendFaceContacts>;
  readonly chained: (a: number, b: number) => boolean;
  readonly tolerances: Tolerances;
  readonly g0Param: number | undefined;
  readonly samples: number;
  readonly requireG2: boolean;
}

type BlendFace = ShapeTopology['faces'][number];
type Source = NonNullable<ReturnType<typeof blendSource>>;

function faceTolerancesOf(world: BlendFaceWorld, face: BlendFace): Tolerances {
  const { graph, topology, laws, tolerances, g0Param } = world;
  // width of the blend: its area over its longest edge (the contact lines)
  const longest = Math.max(
    ...graph.edgeFaces.flatMap((around, edge) => (around.includes(face.index) ? [topology.edges[edge]?.length ?? 0] : [])),
    0,
  );
  const profiled = (laws.get(face.index)?.profile?.type ?? 'circular') !== 'circular';
  const own: Tolerances = profiled ? { ...tolerances, g0: g0Param ?? tolerances.g0 * PROFILE_G0_FACTOR } : tolerances;
  return withBlendScaleFloor(own, face.area, longest);
}

function supportContacts(
  world: BlendFaceWorld,
  face: BlendFace,
  source: Source,
  faceTolerances: Tolerances,
  findings: Finding[],
): { contacts: Contact[]; unverified: number } {
  const { kernel, shape, topology, graph, samples, requireG2, entityId, unit } = world;
  const contacts: Contact[] = [];
  let unverified = 0;
  graph.edgeFaces.forEach((around, edge) => {
    if (around.length !== 2 || !around.includes(face.index)) return;
    const otherName = topology.faces[around.find((other) => other !== face.index) ?? -1]?.name;
    if (otherName === undefined || !source.supports.includes(otherName)) return;
    const measured = kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null;
    const contact = measured === null ? null : measureContact(measured, faceTolerances);
    if (contact === null) return void unverified++;
    const name = topology.edges[edge]?.name;
    contacts.push({ edge, ...(name === undefined ? {} : { name }), ...roundContact(contact) });
    findings.push(...contactFindings(entityId, face.index, edge, contact, faceTolerances, requireG2, unit));
  });
  return { contacts, unverified };
}

function chainJunctions(
  world: BlendFaceWorld,
  face: BlendFace,
  faceTolerances: Tolerances,
  findings: Finding[],
): { junctions: Contact[]; missed: number } {
  const { kernel, shape, topology, graph, samples, entityId, unit } = world;
  const junctions: Contact[] = [];
  let missed = 0;
  for (const junction of junctionsOf(topology, graph, face.index, world.chained)) {
    const across = kernel.faceQuery?.edgeContinuity(shape, junction.edge, samples) ?? null;
    // Across a crease of the part (a mitre) each blend is tangent to its own support at one end of the junction, so the normals differ there by the
    // crease of the SUPPORT faces (read from them, not from the blends under test): the junction is held to g1AngleRad beyond it, and each end to the
    // crease of the supports it touches. A smooth chain has no crease and keeps the plain rule.
    const neighbourFace = topology.faces.findIndex((candidate) => candidate.name === junction.neighbour);
    const crease = supportCrease(
      topology,
      graph,
      face.index,
      neighbourFace,
      junction.edge,
      (edge) => kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null,
    );
    const verdict = judgeJunction(across ?? [], crease, faceTolerances.g1AngleRad);
    const jointTolerances: Tolerances = { ...faceTolerances, g1AngleRad: verdict.limit };
    const joint = across === null ? null : measureContact(across, jointTolerances);
    if (joint === null) {
      missed++;
      continue;
    }
    const name = topology.edges[junction.edge]?.name;
    junctions.push({
      edge: junction.edge,
      ...(name === undefined ? {} : { name }),
      neighbour: junction.neighbour,
      ...(crease > 0 ? { creaseRad: sig(crease) } : {}),
      ...roundContact(joint),
    });
    findings.push(...contactFindings(entityId, face.index, junction.edge, joint, jointTolerances, false, unit));
    if (verdict.endsOff > faceTolerances.g1AngleRad)
      findings.push({
        entityId,
        face: face.index,
        edge: junction.edge,
        code: 'BLD_CHECK_G1_ANGLE',
        severity: 'fail',
        value: sig(verdict.endsOff),
        limit: sig(faceTolerances.g1AngleRad),
        unit: 'rad',
        remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
        message: `an end of junction edge ${junction.edge} differs by ${sig(verdict.endsOff)} rad from the ${sig(crease)} rad crease of the supports there (blend face ${face.index})`,
      });
  }
  return { junctions, missed };
}

function radiusReadback(world: BlendFaceWorld, face: BlendFace, findings: Finding[]): ReturnType<typeof checkRadius> | null {
  const { kernel, shape, laws, contactsOf, samples, entityId, unit } = world;
  const located = contactsOf.get(face.index);
  const readback = located === undefined ? null : checkRadius(kernel, shape, located, laws.get(face.index), samples);
  for (const deviation of readback?.deviations ?? [])
    findings.push({
      code: 'BLD_CHECK_RADIUS_LAW',
      severity: 'fail',
      entityId,
      face: face.index,
      value: deviation.deviation,
      limit: sig(RADIUS_LAW_TOLERANCE * deviation.expected),
      unit,
      remediation: REMEDIATION.BLD_CHECK_RADIUS_LAW,
      message: `blend face ${face.index} has radius ${deviation.actual} ${unit} at t = ${deviation.t} where the law gives ${deviation.expected}`,
    });
  return readback;
}

/**
 * The row of blend face `face` (named `name`, made from `source`) appended to `blends`, its findings appended to `findings`.
 * Returns the contact lines the kernel could not measure and the chain junctions it could not measure.
 */
export function checkBlendFace(
  world: BlendFaceWorld,
  face: BlendFace,
  name: string,
  source: Source,
  blends: BlendRow[],
  findings: Finding[],
): { unverified: number; missed: number } {
  const { kernel, shape, topology, graph, laws, samples, entityId, unit } = world;
  const faceTolerances = faceTolerancesOf(world, face);
  const { contacts, unverified } = supportContacts(world, face, source, faceTolerances, findings);
  const { junctions, missed } = chainJunctions(world, face, faceTolerances, findings);
  if (missed > 0)
    findings.push({
      code: 'BLD_CHECK_UNVERIFIED_CONTACT',
      severity: 'warn',
      entityId,
      face: face.index,
      unit,
      remediation: REMEDIATION.BLD_CHECK_UNVERIFIED_CONTACT,
      message: `${missed} junction(s) of blend face ${face.index} (${name}) with the next blend of its chain could not be measured by the kernel`,
    });
  const jointSource = laws.get(face.index)?.source;
  const readback = radiusReadback(world, face, findings);
  const cliffEdge = cliffEdgeOf(kernel, shape, topology, graph, face.index, samples);
  if (cliffEdge !== null) findings.push(cliffFinding(entityId, face.index, name, cliffEdge));
  blends.push({
    entityId,
    face: face.index,
    name,
    kind: 'edge',
    sourceEdges: [source.edge],
    contacts,
    ...(junctions.length === 0 ? {} : { junctions }),
    profile: laws.get(face.index)?.profile?.type ?? 'circular',
    ...(readback?.radius == null ? {} : { radius: readback.radius, lawChecked: readback.lawChecked }),
    ...(readback?.lawNote === undefined ? {} : { lawNote: readback.lawNote }),
    ...(jointSource === undefined ? {} : { source: jointSource }),
  });
  if (unverified > 0 || contacts.length === 0)
    findings.push({
      code: 'BLD_CHECK_UNVERIFIED_CONTACT',
      severity: 'warn',
      entityId,
      face: face.index,
      unit,
      remediation: REMEDIATION.BLD_CHECK_UNVERIFIED_CONTACT,
      message:
        contacts.length === 0
          ? `blend face ${face.index} (${name}) has no contact line against its support faces: nothing was measured`
          : `${unverified} contact line(s) of blend face ${face.index} could not be measured by the kernel`,
    });
  return { unverified, missed };
}
