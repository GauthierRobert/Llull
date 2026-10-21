/** mesh_to_solid: rebuild a constant-section mesh (imported prism) as an editable extrusion recipe. */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { defineCommand, z } from '../schema';
import { noop } from '../noop';
import { execute } from '../execute';
import { kernelUnavailable } from '../kernelRefusal';
import { referenceLossSuffix, withoutEntities } from '../entity/entityOps';
import { boundsOfPoints } from '../../geometry/bounds';
import { entityToTriangles } from '../../geometry/entityTriangles';
import { recognizePrism, type PrismSection } from '../../geometry/prismRecognition';
import { solidTriangles } from '../../geometry/solidTriangles';
import { applyEulerXYZ } from '../../lib/eulerRotation';

/** Hole tools stick out of the solid by this fraction of its depth on both ends, so the subtraction is never coplanar. */
const TOOL_OVERSHOOT = 0.25;
const BOUNDS_TOLERANCE = 1e-5;

const fmt = (v: Vec3): string => `[${v.map((c) => Number(c.toPrecision(6))).join(', ')}]`;

/** True when the extrusion `built` occupies the same box as `source` (guards the frame conversion of the outline). */
function sameBox(built: Entity, source: readonly (readonly [Vec3, Vec3, Vec3])[]): boolean {
  const mine = boundsOfPoints(solidTriangles(built).flat());
  const theirs = boundsOfPoints(source.flat());
  const size = Math.max(...theirs.max.map((hi, i) => hi - (theirs.min[i] as number)));
  return [0, 1, 2].every(
    (i) =>
      Math.abs((mine.min[i] as number) - (theirs.min[i] as number)) <= BOUNDS_TOLERANCE * size &&
      Math.abs((mine.max[i] as number) - (theirs.max[i] as number)) <= BOUNDS_TOLERANCE * size,
  );
}

function rebuild(
  doc: CadDocument,
  source: Entity,
  section: PrismSection,
  world: readonly (readonly [Vec3, Vec3, Vec3])[],
): { document: CadDocument; id: string } | string {
  const base = execute(doc, 'extrude_profile', {
    profile: section.outer,
    depth: section.depth,
    position: section.position,
    rotation: section.rotation,
    color: source.color,
  });
  const baseId = base.affected[0];
  const built = baseId === undefined ? undefined : base.document.entities[baseId];
  if (baseId === undefined || built === undefined) return base.summary;
  if (!sameBox(built, world)) return 'the recovered outline does not reproduce the mesh bounds';
  let current = base.document;
  let currentId = baseId;
  const overshoot = section.depth * TOOL_OVERSHOOT;
  for (const hole of section.holes) {
    const start = applyEulerXYZ([0, 0, -overshoot], [0, 0, 0], section.rotation);
    const tool = execute(current, 'extrude_profile', {
      profile: hole,
      depth: section.depth + 2 * overshoot,
      position: [section.position[0] + start[0], section.position[1] + start[1], section.position[2] + start[2]],
      rotation: section.rotation,
      color: source.color,
    });
    const toolId = tool.affected[0];
    if (toolId === undefined) return tool.summary;
    const cut = execute(tool.document, 'boolean', { op: 'subtract', a: currentId, b: toolId });
    const cutId = cut.affected[0];
    if (cutId === undefined) return cut.summary;
    current = cut.document;
    currentId = cutId;
  }
  return { document: current, id: currentId };
}

/**
 * @affects replaces mesh `id` by 1 extrusion entity (no holes) or 1 mesh entity with an extrude + boolean-subtract recipe (holes); the
 *   source is kept with keepSource
 * @invariant the result has the section outline and depth recovered from the mesh; its bounds equal the mesh bounds
 * @failure missing id, non-mesh entity, no constant section (sphere, taper, several regions, open mesh), holes without a kernel -> no-op
 */
export const meshToSolid = defineCommand({
  name: 'mesh_to_solid',
  description:
    'Rebuild a mesh solid (from import_mesh / the CLI tool import_step) that is a constant-section prism as an editable extrusion: it looks for an axis ' +
    'along which every vertex lies on two parallel planes and all side faces are parallel to the axis, extracts the outline polygon of ' +
    'the section (outer loop and holes) and recreates it as an extrude_profile solid (plus a boolean subtract of an extruded tool per hole, ' +
    'which needs the geometry kernel). The mesh is replaced by the new solid, which keeps its colour; use keepSource to keep the mesh too. ' +
    'Refuses, leaving the document unchanged, when the mesh is not a closed constant section (spheres, tapers, stepped or curved-profile ' +
    'parts: the outline is read from mesh edges, so arcs come back as polygons), has several separate regions or islands inside holes.',
  params: z.object({
    id: z.string().describe('Id of the mesh entity (kind "mesh") to rebuild.'),
    keepSource: z.boolean().optional().describe('Keep the source mesh next to the new solid. Default false (the mesh is replaced).'),
  }),
  run: (doc, { id, keepSource = false }, ctx): CommandResult => {
    const source = doc.entities[id];
    if (source === undefined) return noop(doc, `mesh_to_solid: entity '${id}' not found; no-op.`);
    if (source.kind !== 'mesh') return noop(doc, `mesh_to_solid: entity '${id}' is a ${source.kind}, not a mesh; no-op.`);
    const world = entityToTriangles(source, doc);
    const section = recognizePrism(world);
    if ('reason' in section) return noop(doc, `mesh_to_solid: '${id}' is not a constant-section prism: ${section.reason}; no-op.`);
    if (section.holes.length > 0 && (ctx ?? currentContext()).kernel === null) return noop(doc, kernelUnavailable('mesh_to_solid'));
    const rebuilt = rebuild(doc, source, section, world);
    if (typeof rebuilt === 'string') return noop(doc, `mesh_to_solid: could not rebuild '${id}': ${rebuilt}`);
    const finished = rebuilt.document.entities[rebuilt.id];
    const styled: CadDocument =
      finished === undefined
        ? rebuilt.document
        : {
            ...rebuilt.document,
            entities: {
              ...rebuilt.document.entities,
              [rebuilt.id]: { ...finished, layerId: source.layerId, ...(source.name !== undefined ? { name: source.name } : {}) },
            },
          };
    const result = keepSource ? styled : withoutEntities(styled, new Set([id])).document;
    return {
      document: result,
      summary:
        `mesh_to_solid: rebuilt mesh '${id}' as ${finished?.kind ?? 'solid'} '${rebuilt.id}': ${section.outer.length}-point outline` +
        (section.holes.length > 0 ? ` with ${section.holes.length} hole(s) subtracted` : '') +
        `, depth ${Number(section.depth.toPrecision(6))} along axis ${fmt(section.axis)}.` +
        (keepSource ? ` Source mesh kept.` : ` Source mesh removed.${referenceLossSuffix(styled, result)}`),
      affected: [rebuilt.id],
    };
  },
});
