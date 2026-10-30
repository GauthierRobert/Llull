/** deform_lattice — free-form deformation of a solid by moving the control points of a Bernstein lattice (01 DEF M3, FR-DEF-13, Sederberg & Parry 1986). */

import type { Vec3 } from '../../model/types';
import { resolveFrame, toLocal } from '../../geometry/deform/frame';
import { restPosition, toBoxCoordinates } from '../../geometry/deform/lattice';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, resolveTargetFrame } from './target';

/** Layers next to a lattice face the body crosses that must not move (continuity with the undeformed part). */
const DEFAULT_FIXED_LAYERS = 1;

const AXES = [0, 1, 2] as const;

type Net = readonly [number, number, number];
type Axes = readonly [Vec3, Vec3, Vec3];
type Box = { readonly min: Vec3; readonly max: Vec3 };

interface Move {
  readonly index?: readonly number[] | undefined;
  readonly near?: Vec3 | undefined;
  readonly delta: Vec3;
}

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a lattice law
 * @invariant no moves = identity; control points displaced by an affine map give that affine map (Bernstein linear precision); points outside the box do
 *   not move and the layers next to a face the body crosses are fixed, so the result stays continuous; kernel-optional: exact warp on the native kernel,
 *   mesh path on Manifold and without a kernel
 * @invariant splineDegrees: control points rest on the Greville abscissae (zero moves = identity, affine moves = that affine map); orientation: offsets stay displacements in frame coordinates
 * @failure degrees outside 1..8 or splineDegrees outside 2..degree -> DEF_LATTICE_DEGREE; orientation degenerate -> DEF_FRAME_DEGENERATE; an index outside the control net, or a move with both / neither of index and near -> DEF_LATTICE_INDEX; a fixed layer
 *   moved -> DEF_LATTICE_FIXED_MOVED; box not meeting the body -> DEF_REGION_MISSES_BODY; no move -> DEF_NO_EFFECT; det J <= 0 -> DEF_FOLDOVER
 */
export const deformLattice = defineCommand({
  name: 'deform_lattice',
  annotations: { readsMeshTriangles: true },
  description:
    'Free-form deformation of a 3D solid or mesh: a regular lattice of control points (degrees [l, m, n], l + 1 by m + 1 by n + 1 points, 1..8 per axis) fills a box ' +
    'in the frame; moving control points bends the space inside the box smoothly (Bernstein polynomials, Sederberg & Parry 1986) and the body with it. ' +
    'Use it for bottles, grips, organic bulges, cambered shapes. Control point (i, j, k) sits at box.min + (i / l, j / m, k / n) x box size; moves name it by index [i, j, k] ' +
    'or by near (a world point: the nearest control point of the undisplaced lattice) and give delta, a displacement in frame coordinates (document units). ' +
    'splineDegrees [p, q, r] switches the basis to a uniform clamped B-spline (local control: a control point acts only on the spans around it); orientation {uAxis, vAxis} turns the box to its own axes. Without box the lattice fills the body bounds (along those axes). Frame default: the world axes at the origin, so box and delta are in world coordinates. ' +
    'With no moves nothing changes; moving all points by one affine map applies that map exactly. Points outside the box do not move, so the layers of control points ' +
    'next to a box face that the body crosses are fixed (fixedLayers, default 1) to keep the body continuous. Higher degrees give local control but need more moves. ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). Refuses a degree outside 1..8 (DEF_LATTICE_DEGREE), an index outside the net ' +
    '(DEF_LATTICE_INDEX), a move of a fixed layer (DEF_LATTICE_FIXED_MOVED), a spline degree outside 2..the axis degree (DEF_LATTICE_DEGREE), a degenerate orientation (DEF_FRAME_DEGENERATE), a lattice that folds the body (DEF_FOLDOVER: det J <= 0; reduce the moves) and a box that misses ' +
    'the body (DEF_REGION_MISSES_BODY). Then call analyze_deformation (det J range and its Bernstein bound) and check_deformation.',
  params: z.object({
    ...bodyParams,
    degrees: z
      .array(z.number())
      .length(3)
      .describe(
        'Lattice degrees [l, m, n] along the frame x, y, z axes, integers 1..8 (the lattice has (l + 1)(m + 1)(n + 1) control points).',
      ),
    box: z
      .union([
        z.literal('bounds'),
        z.object({
          min: vec3('Lattice box corner with the smallest coordinates, frame coordinates, document units.'),
          max: vec3('Lattice box corner with the largest coordinates, frame coordinates, document units; every component must exceed min.'),
        }),
      ])
      .describe(
        'Box the lattice fills, in frame coordinates: {min, max}, or "bounds" (default) for the body bounds in the frame plus a margin of 1e-6 of the diagonal.',
      )
      .optional(),
    moves: z
      .array(
        z.object({
          index: z
            .array(z.number())
            .length(3)
            .describe('Control point [i, j, k] to move, integers 0..l, 0..m, 0..n. Give index or near, not both.')
            .optional(),
          near: vec3(
            'World point: the control point nearest to it (in the undisplaced lattice) is moved. Give index or near, not both.',
          ).optional(),
          delta: vec3('Displacement added to the control point, frame coordinates, document units.'),
        }),
      )
      .max(5000)
      .describe('Control point displacements; several moves of one point add up. Default: none (no change).')
      .optional(),
    splineDegrees: z
      .array(z.number())
      .length(3)
      .describe(
        'B-spline lattice: degrees [p, q, r] of the basis along the box axes, integers from 2 to the lattice degree of the axis (a uniform clamped knot vector; the control net keeps degrees + 1 points per axis). ' +
          'A control point then acts only on the p + 1 knot spans around it (local control: moving one point leaves the rest of the body alone), where the default Bernstein lattice (omit this) acts everywhere. ' +
          'p equal to the lattice degree is the Bernstein lattice. Control points rest on the Greville abscissae of the knots (index [i, j, k] and near use those positions).',
      )
      .optional(),
    orientation: z
      .object({
        uAxis: vec3('Direction of the first box axis (the lattice index i runs along it), frame coordinates, unitless; non-zero.'),
        vAxis: vec3(
          'Direction giving the second box axis: its component perpendicular to uAxis is used, unitless; must not be parallel to uAxis. The third axis is uAxis cross vAxis.',
        ),
      })
      .describe(
        'Oriented box: the lattice follows its own axes instead of the frame axes (a slanted rib, a twisted blade root). box.min / box.max are then measured along these axes from the frame origin ' +
          '(box "bounds" is the body bounds in them); moves and deltas stay displacements in frame coordinates. Default: the box is aligned with the frame.',
      )
      .optional(),
    fixedLayers: z
      .number()
      .describe(
        'Layers of control points next to each box face the body crosses that must stay put, integer >= 0 (default 1: continuous; 2: tangent-continuous). Faces the body does not reach are free.',
      )
      .optional(),
    frame: z
      .object({
        origin: vec3('Frame origin, a world point in document units. Default [0, 0, 0].').optional(),
        axis: vec3('Frame z axis, unitless (normalised). Default [0, 0, 1].').optional(),
        reference: vec3(
          'Direction giving the frame x axis, unitless; must not be parallel to axis. Default: the first world axis not parallel to axis.',
        ).optional(),
      })
      .describe('Frame the box, moves and deltas are expressed in; default the world axes.')
      .optional(),
    output: outputParam.optional(),
  }),
  run: (
    doc,
    { id, ids, keepSource, degrees, splineDegrees, orientation, box, moves = [], fixedLayers = DEFAULT_FIXED_LAYERS, frame, output },
    ctx,
  ): CommandResult =>
    runDeform(doc, ctx, {
      command: 'deform_lattice',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'deformed with a lattice',
      output,
      plan: (target): DeformPlan | Refusal => {
        const bad = degrees.findIndex((degree) => !Number.isInteger(degree) || degree < 1 || degree > 8);
        if (bad >= 0)
          return {
            code: 'DEF_LATTICE_DEGREE',
            message: `degree ${String(degrees[bad])} must be an integer in 1..8`,
            paths: [`params.degrees.${bad}`],
          };
        const splineBad = splineDegrees?.findIndex((p, a) => !Number.isInteger(p) || p < 2 || p > (degrees[a] as number)) ?? -1;
        if (splineBad >= 0)
          return {
            code: 'DEF_LATTICE_DEGREE',
            message: `spline degree ${String(splineDegrees?.[splineBad])} must be an integer from 2 to the lattice degree ${String(degrees[splineBad])} of its axis`,
            paths: [`params.splineDegrees.${splineBad}`],
          };
        const axes = orientation === undefined ? undefined : boxAxes(orientation.uAxis as Vec3, orientation.vAxis as Vec3);
        if (orientation !== undefined && axes === null)
          return {
            code: 'DEF_FRAME_DEGENERATE',
            message: 'the box axes are degenerate: uAxis is zero or vAxis is parallel to it',
            paths: ['params.orientation'],
          };
        if (!Number.isInteger(fixedLayers) || fixedLayers < 0)
          return {
            code: 'DEF_LATTICE_FIXED_MOVED',
            message: `fixedLayers ${fixedLayers} must be an integer >= 0`,
            paths: ['params.fixedLayers'],
          };
        const axis = frame?.axis ?? [0, 0, 1];
        const resolved = resolveTargetFrame(
          target,
          {
            origin: frame?.origin ?? [0, 0, 0],
            axis,
            reference: frame?.reference ?? (Math.abs(axis[0]) < 0.99 * Math.hypot(...axis) ? [1, 0, 0] : [0, 1, 0]),
          },
          'centre',
        );
        if ('code' in resolved) return resolved;
        const local = resolveFrame(resolved.frame);
        // the body's extent along the box axes (the frame extent for a frame-aligned box)
        const bodyExtent: Box =
          axes === undefined || axes === null || local === null ? resolved.extent : extentAlong(target.mesh.positions, local, axes);
        const margin = 1e-6 * Math.hypot(...AXES.map((a) => bodyExtent.max[a] - bodyExtent.min[a]));
        const lattice: Box = (box === 'bounds' ? undefined : box) ?? {
          min: AXES.map((a) => bodyExtent.min[a] - margin) as unknown as Vec3,
          max: AXES.map((a) => bodyExtent.max[a] + margin) as unknown as Vec3,
        };
        if (!AXES.every((a) => lattice.max[a] > lattice.min[a]))
          return { code: 'DEF_REGION_INVALID', message: 'box.max must exceed box.min on every axis', paths: ['params.box'] };
        if (!AXES.every((a) => lattice.max[a] > bodyExtent.min[a] && lattice.min[a] < bodyExtent.max[a]))
          return { code: 'DEF_REGION_MISSES_BODY', message: 'the lattice box does not meet the body', paths: ['params.box'] };
        const net = degrees as unknown as Net;
        const offsets: Array<{ index: Net; delta: Vec3 }> = [];
        for (const [position, move] of (moves as readonly Move[]).entries()) {
          const found = controlPointOf(move, position, net, lattice, local === null ? null : (p) => toLocal(local, p), {
            splineDegrees,
            axes,
          });
          if ('code' in found) return found;
          offsets.push({ index: found.at, delta: move.delta });
        }
        if (!offsets.some((entry) => entry.delta.some((component) => component !== 0)))
          return { code: 'DEF_NO_EFFECT', message: 'no move displaces a control point', paths: ['params.moves'] };
        const fixed = fixedViolation(offsets, net, lattice, bodyExtent, fixedLayers);
        if (fixed !== null) return fixed;
        return {
          law: {
            kind: 'lattice',
            box: lattice,
            degrees: net,
            offsets,
            ...(splineDegrees === undefined ? {} : { splineDegrees: splineDegrees as unknown as Net }),
            ...(axes === undefined || axes === null ? {} : { axes }),
          },
          frame: resolved.frame,
          extent: resolved.extent,
          defaulted: [...resolved.defaulted.filter((name) => name === 'origin'), ...(box === undefined || box === 'bounds' ? ['box'] : [])],
        };
      },
    }),
});

/** The control point a move names. */
function controlPointOf(
  move: Move,
  position: number,
  net: Net,
  box: Box,
  toFrame: ((p: Vec3) => Vec3) | null,
  basis: { splineDegrees: readonly number[] | undefined; axes: Axes | null | undefined },
): { at: Net } | Refusal {
  const path = `params.moves.${position}`;
  if ((move.index === undefined) === (move.near === undefined))
    return { code: 'DEF_LATTICE_INDEX', message: `move ${position} needs exactly one of index and near`, paths: [path] };
  if (move.index !== undefined) {
    const at = move.index as unknown as [number, number, number];
    if (!AXES.every((a) => Number.isInteger(at[a]) && at[a] >= 0 && at[a] <= net[a]))
      return {
        code: 'DEF_LATTICE_INDEX',
        message: `index [${at.join(', ')}] lies outside the control net 0..${net[0]} x 0..${net[1]} x 0..${net[2]}`,
        paths: [`${path}.index`],
      };
    return { at };
  }
  if (toFrame === null || move.near === undefined)
    return { code: 'DEF_FRAME_DEGENERATE', message: 'the frame is degenerate', paths: ['params.frame'] };
  const rest = { degrees: net, ...(basis.splineDegrees === undefined ? {} : { splineDegrees: basis.splineDegrees as unknown as Net }) };
  const q = basis.axes == null ? toFrame(move.near) : toBoxCoordinates({ axes: basis.axes }, toFrame(move.near));
  const nearest = AXES.map((a) => {
    const s = (q[a] - box.min[a]) / (box.max[a] - box.min[a]);
    if (basis.splineDegrees === undefined) return Math.min(net[a], Math.max(0, Math.round(s * net[a])));
    // the nearest rest position (Greville abscissa) of the axis
    let best = 0;
    for (let i = 1; i <= net[a]; i++) if (Math.abs(restPosition(rest, a, i) - s) < Math.abs(restPosition(rest, a, best) - s)) best = i;
    return best;
  });
  return { at: nearest as unknown as Net };
}

/** A move of one of the `layers` outer layers next to a face of the box that the body crosses. */
function fixedViolation(
  offsets: ReadonlyArray<{ index: Net; delta: Vec3 }>,
  net: Net,
  box: Box,
  extent: Box,
  layers: number,
): Refusal | null {
  const crossed = AXES.map((a) => ({
    low: extent.min[a] < box.min[a] && box.min[a] < extent.max[a],
    high: extent.min[a] < box.max[a] && box.max[a] < extent.max[a],
  }));
  for (const [position, { index, delta }] of offsets.entries()) {
    if (delta.every((component) => component === 0)) continue;
    for (const a of AXES) {
      const at = index[a];
      if ((crossed[a]?.low === true && at < layers) || (crossed[a]?.high === true && at > net[a] - layers))
        return {
          code: 'DEF_LATTICE_FIXED_MOVED',
          message: `control point [${index.join(', ')}] lies in the ${layers} fixed layer(s) next to a lattice face the body crosses; the body would tear there. Keep those layers still, or enlarge the box`,
          paths: [`params.moves.${position}`],
        };
    }
  }
  return null;
}

/** Orthonormal box axes from a first direction and a hint for the second (its component across the first), or null when degenerate. */
function boxAxes(u: Vec3, hint: Vec3): Axes | null {
  if (!(len3(u) > 0)) return null;
  const first = normalize3(u);
  const across = sub3(hint, scale3(first, dot3(hint, first)));
  if (!(len3(across) > 1e-9 * Math.max(len3(hint), 1e-300))) return null;
  const second = normalize3(across);
  return [first, second, cross3(first, second)];
}

/** Extent of the world points `positions` in the box coordinates (the box axes, expressed in the frame, about the frame origin). */
function extentAlong(positions: ReadonlyArray<number>, frame: NonNullable<ReturnType<typeof resolveFrame>>, axes: Axes): Box {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const c = toBoxCoordinates({ axes }, toLocal(frame, [positions[i] as number, positions[i + 1] as number, positions[i + 2] as number]));
    for (const a of AXES) {
      min[a] = Math.min(min[a], c[a]);
      max[a] = Math.max(max[a], c[a]);
    }
  }
  return { min, max };
}
