/** Folded-solid pieces of the formed features on one flat: flanged-hole lips (revolved) and beads (extruded arch + revolved round ends). */

import type { Vec2, Vec3 } from '@core/model/types';
import type { Frame3, SheetMetalPart } from '@core/model/sheetMetal';
import type { ShapeRecipe } from '@core/model/types';
import { add3, scale3 } from '@lib/vec3';
import { eulerFromAxes } from '@lib/eulerRotation';
import { basisOf, frameEuler, frameToWorld } from './frames';
import { type Section, beadFootprint, beadGeometry, lipGeometry, mirrorSection } from './formGeometry';
import { type Piece, leaf, solidPiece } from './foldPiece';
import { formsOf } from './graph';

export interface FormPieces {
  /** Solids subtracted from the flat itself (bead troughs). */
  readonly tools: ShapeRecipe[];
  /** Footprints cut from the flat in the displayed mesh only (the exact recipe uses `tools`). */
  readonly meshHoles: Vec2[][];
  /** Solids added to the part (lips, bead arches). */
  readonly pieces: Piece[];
}

const FULL_TURN = 2 * Math.PI;
const LIP_SEGMENTS = 48;
const CAP_SEGMENTS = 24;

const revolution = (
  id: string,
  section: Section,
  angle: number,
  segments: number,
  position: Vec3,
  rotation: Vec3,
): ReturnType<typeof leaf> =>
  leaf(id, 'revolution', { profile: section.profile, curves: section.curves, axis: [0, 0, 1], angle, segments }, position, rotation);

/**
 * Pieces of every form node placed on `flatId`.
 * @param bottom local z of the bottom face of the material
 */
export function formPieces(
  partId: string,
  part: SheetMetalPart,
  flatId: string,
  frame: Frame3,
  thickness: number,
  bottom: number,
): FormPieces {
  const basis = basisOf(frame);
  const tools: ShapeRecipe[] = [];
  const meshHoles: Vec2[][] = [];
  const pieces: Piece[] = [];
  const side = (direction: 'up' | 'down', section: Section): Section => (direction === 'up' ? section : mirrorSection(section, thickness));
  for (const node of formsOf(part).filter((candidate) => candidate.on === flatId)) {
    const { form } = node;
    const name = `${partId}:${node.id}`;
    if (form.kind === 'flanged_hole') {
      const lip = lipGeometry(form, thickness);
      if (lip === null) continue;
      const entity = revolution(
        name,
        side(form.direction, lip.section),
        FULL_TURN,
        LIP_SEGMENTS,
        frameToWorld(frame, form.center, bottom),
        frameEuler(frame),
      );
      pieces.push(solidPiece(entity));
      continue;
    }
    const bead = beadGeometry(form, thickness);
    const length = Math.hypot(form.end[0] - form.start[0], form.end[1] - form.start[1]);
    if (bead === null || !(length > 0)) continue;
    const u2: Vec2 = [(form.end[0] - form.start[0]) / length, (form.end[1] - form.start[1]) / length];
    const u = add3(scale3(basis.x, u2[0]), scale3(basis.y, u2[1]));
    const across = add3(scale3(basis.x, -u2[1]), scale3(basis.y, u2[0]));
    const [arch, halfArch, tool, halfTool] = [bead.arch, bead.halfArch, bead.tool, bead.halfTool].map((section) =>
      side(form.direction, section),
    ) as [Section, Section, Section, Section];
    const at = (point: Vec2): Vec3 => frameToWorld(frame, point, bottom);
    const extrusion = (suffix: string, section: Section): ReturnType<typeof leaf> =>
      leaf(
        `${name}${suffix}`,
        'extrusion',
        { profile: section.profile, curves: section.curves, depth: length },
        at(form.start),
        eulerFromAxes(across, basis.z, u),
      );
    const cap = (suffix: string, section: Section, point: Vec2, forward: boolean): ReturnType<typeof leaf> =>
      revolution(
        `${name}${suffix}`,
        section,
        Math.PI,
        CAP_SEGMENTS,
        at(point),
        forward ? eulerFromAxes(scale3(across, -1), u, basis.z) : eulerFromAxes(across, scale3(u, -1), basis.z),
      );
    pieces.push(solidPiece(extrusion('', arch)));
    tools.push({ op: 'solid', entity: extrusion(':tool', tool) });
    if (form.endShape === 'round') {
      pieces.push(solidPiece(cap(':end', halfArch, form.end, true)), solidPiece(cap(':start', halfArch, form.start, false)));
      tools.push(
        { op: 'solid', entity: cap(':tool-end', halfTool, form.end, true) },
        { op: 'solid', entity: cap(':tool-start', halfTool, form.start, false) },
      );
    }
    meshHoles.push(beadFootprint(form.start, form.end, bead.footprintHalfWidth, form.endShape));
  }
  return { tools, meshHoles, pieces };
}
