/**
 * Guard of a fillet step against a round the solid already has (BLD M0, TECHNICAL_SPEC 13.26): a circular fillet run along the rim of a round of radius r1 with a radius r2 > r1 is a spindle torus; OCCT answers with an approximating
 * B-spline that is not tangent to the round (0.044 rad for r1 1 / r2 2, 0.029 for r1 2 / r2 3, measured with the exact face projection: server/tests/nativeFilletKink.test.ts). The new edge-blend faces of the step that rest on a curved face the source already had
 * are read back at the check_blends default and a contact of a NEW face against a curved face that EXISTED before the step (an earlier round, imported or not) that is not G1 is refused by name, or, with allowNonTangent, built and reported.
 * @invariant only the faces this step created are measured (the cost follows the step, an old kink never refuses a later step); only a contact against a curved face of the source counts (corner plates and profile-chain junctions keep their own rules)
 * @failure such a contact over the G1 limit -> BLD_FILLET_NOT_TANGENT (path from the caller) with the measured angle, the edge and the faces, the document unchanged; with allowNonTangent the result is returned with data.nonTangent and a warning
 */

import type { CadDocument, MeshSolidEntity, ShapeRecipe } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { blendSource } from '../../geometry/blend/continuity';
import { currentContext } from '../context';
import { blendRejection } from './blendCodes';
import { checkBlendFaces } from './checkBlends';
import type { Finding } from './checkBlendFindings';

/** A contact of a new blend face against an earlier blend face that is not tangent. */
export interface Kink {
  readonly angleRad: number;
  readonly limitRad: number;
  readonly edge: number;
  readonly face: string;
  readonly against: string;
}

type Measure = (kernel: GeometryKernel, entity: MeshSolidEntity, only: ReadonlySet<string>, unit: string) => Finding[];

const isEdgeBlend = (name: string | undefined): name is string => name !== undefined && name.startsWith('blend(e(');

/** The worst non-tangent contact of the new edge-blend faces of `committed` (the result of a fillet step on `source`) against curved faces `source` already had (its rounds, imported or not), else null. */
export function findKink(
  doc: CadDocument,
  committed: CommandResult,
  source: ShapeRecipe,
  ctx: ExecutionContext | undefined,
  measure: Measure = checkBlendFaces,
): Kink | null {
  const created = committed.affected[0];
  const entity = created === undefined ? undefined : committed.document.entities[created];
  if (committed.document === doc || entity?.kind !== 'mesh' || entity.brep === undefined) return null;
  const kernel = (ctx ?? currentContext()).kernel;
  const query = kernel?.faceQuery;
  if (kernel === null || query === undefined) return null;
  const before = kernel.evaluate(source);
  const after = kernel.evaluate(entity.brep);
  if (before === null || after === null) return null;
  const earlier = kernel.topology(before)?.faces ?? [];
  const known = new Set(earlier.map((face) => face.name).filter((name): name is string => name !== undefined));
  const curved = new Set(earlier.filter((face) => face.name !== undefined && face.normal === undefined).map((face) => face.name as string));
  const topology = kernel.topology(after);
  const graph = query.faceGraph(after);
  if (topology === null || graph === null || curved.size === 0) return null;
  // a new blend can only fail to be tangent to a round when it rests on a curved face the solid already had: blends between planes (a first step) are exact and are not read back
  const fresh = new Set(
    topology.faces.flatMap((face) => {
      const supports =
        face.name !== undefined && isEdgeBlend(face.name) && !known.has(face.name) ? (blendSource(face.name)?.supports ?? []) : [];
      return face.name !== undefined && supports.some((support) => curved.has(support)) ? [face.name] : [];
    }),
  );
  if (fresh.size === 0) return null;
  let worst: Kink | null = null;
  for (const finding of measure(kernel, entity, fresh, doc.units)) {
    if (finding.code !== 'BLD_CHECK_G1_ANGLE' || finding.severity !== 'fail' || finding.face === undefined || finding.edge === undefined)
      continue;
    const against = (graph.edgeFaces[finding.edge] ?? []).find((face) => face !== finding.face);
    const againstName = against === undefined ? undefined : topology.faces[against]?.name;
    const faceName = topology.faces[finding.face]?.name;
    if (againstName === undefined || !curved.has(againstName) || faceName === undefined || !fresh.has(faceName)) continue;
    const angleRad = finding.value ?? 0;
    if (worst === null || angleRad > worst.angleRad)
      worst = { angleRad, limitRad: finding.limit ?? 0, edge: finding.edge, face: faceName, against: againstName };
  }
  return worst;
}

const text = (kink: Kink): string =>
  `the new blend ${kink.face} meets the blend ${kink.against} the solid already has along edge ${kink.edge} with a normal angle of ${kink.angleRad} rad (limit ${kink.limitRad}): OCCT approximates a fillet larger than the round it runs onto and the approximation is not tangent`;

/** The refusal of a kinked step. */
export function kinkRefusal(doc: CadDocument, command: string, id: string, kink: Kink, path: string): CommandResult {
  return blendRejection(
    doc,
    command,
    'BLD_FILLET_NOT_TANGENT',
    `${text(kink)}; use a radius up to that of the round, round the edges in one step, or pass allowNonTangent: true to build it anyway`,
    [id],
    [path],
    { angleRad: kink.angleRad, limitRad: kink.limitRad, edge: kink.edge, face: kink.face, against: kink.against },
  );
}

/** `committed` with the kink reported (allowNonTangent): a warning in the summary and `data.nonTangent`. */
export function kinkReported(committed: CommandResult, kink: Kink): CommandResult {
  return {
    ...committed,
    summary: `${committed.summary} Warning (allowNonTangent): ${text(kink)}.`,
    data: { ...(committed.data as object | undefined), nonTangent: kink },
  };
}
