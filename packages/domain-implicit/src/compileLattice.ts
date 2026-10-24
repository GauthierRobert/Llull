/**
 * Lattice nodes of the field compiler (05 IMP 5.4-5.6): TPMS (rectangular, cylindrical or spherical cells, constant or graded wall / level), periodic strut
 * lattices (constant or graded radius) and graph lattices. Distance quality: TPMS approximate, strut and graph sets bound (graded strut radius: approximate).
 */

import type { Vec3 } from '@core/model/types';
import { type CompileHost, Failure, type Part, degrade, worst } from './compileTypes';
import { type Frame, axisFrame, growBox, placeFrame } from './frame';
import { graphGeometry } from './graph';
import type { GraphNode, StrutsNode, TpmsNode, VoronoiNode } from './model';
import type { ScalarPart } from './scalar';
import { strutGeometry } from './struts';
import { voronoiGeometry } from './voronoi';
import {
  type CellCoordinates,
  TPMS_FACTS,
  cylindricalCoordinates,
  rectangularCoordinates,
  sphericalCoordinates,
  tpmsRegisters,
} from './tpms';

/** `part` kept where the region field is negative (max of the two), or `part` itself without a region. */
function clipToRegion(host: CompileHost, part: Part, region: string | undefined, frame: Frame): Part {
  if (region === undefined) return part;
  const bounds = host.field(region, frame);
  return {
    reg: host.b.max(part.reg, bounds.reg),
    quality: worst(degrade(part.quality), degrade(bounds.quality)),
    lipschitz: Math.max(part.lipschitz, bounds.lipschitz),
    box: bounds.box,
  };
}

function cellCoordinates(host: CompileHost, node: TpmsNode, frame: Frame): CellCoordinates {
  const b = host.b;
  const map = node.map;
  if (map === undefined) return rectangularCoordinates(b, node.cellSize, placeFrame(b, frame, node.origin, node.rotation, 1));
  if (map.kind === 'cylindrical')
    return cylindricalCoordinates(b, axisFrame(b, frame, map.origin, map.axis), map.cellsAround, node.cellSize[2], map.radialCellSize);
  host.warnings.push({
    code: 'IMP_MAP_POLE',
    ids: [node.id],
    message: `the spherical cells of '${node.id}' collapse at the poles of the axis through ${JSON.stringify(map.origin)}: walls are not uniform there`,
  });
  return sphericalCoordinates(b, placeFrame(b, frame, map.origin, [0, 0, 0], 1), map.cellsAround, map.cellsPolar, map.radialCellSize);
}

const sheetFeature = (value: ScalarPart): number => (Number.isFinite(value.lo) ? value.lo / 2 : Infinity);

export function tpmsPart(host: CompileHost, node: TpmsNode, frame: Frame): Part {
  const b = host.b;
  const { field, gradient } = tpmsRegisters(b, node.kind, cellCoordinates(host, node, frame));
  const value = host.law(node.control.value, frame);
  const graded = typeof node.control.value === 'string';
  const smallest = Math.min(...node.cellSize);
  let reg: number;
  if (node.form === 'network') {
    const level = graded ? b.sub(field, value.reg) : b.shift(field, -value.lo);
    reg = node.normalize === 'gradient' ? b.div(level, gradient) : level;
    host.features.push(smallest / 4);
  } else if (node.normalize === 'gradient') {
    reg = graded ? b.sub(b.div(b.abs(field), gradient), b.scale(value.reg, 0.5)) : b.shift(b.div(b.abs(field), gradient), -value.lo / 2);
    host.features.push(sheetFeature(value));
  } else {
    reg = graded ? b.sub(b.abs(field), value.reg) : b.shift(b.abs(field), -value.lo);
    host.features.push(smallest / 8);
  }
  const lipschitz = node.normalize === 'gradient' ? 2 : (2 * Math.PI * TPMS_FACTS[node.kind].gradBound) / smallest;
  return clipToRegion(host, { reg, quality: 'approximate', lipschitz, box: null }, node.region, frame);
}

/** Largest radius the periodic set may carry: the law's upper bound, else just under half the shortest strut. */
function radiusReach(node: StrutsNode, value: ScalarPart): number {
  const shortest = Math.min(...strutGeometry(node.cell, node.cellSize, 1e-6, undefined).lengths);
  return Number.isFinite(value.hi) ? Math.min(value.hi, shortest / 2) : shortest / 2;
}

export function strutsPart(host: CompileHost, node: StrutsNode, frame: Frame): Part {
  const b = host.b;
  const local = placeFrame(b, frame, node.origin, node.rotation, 1);
  const value = host.law(node.radius, frame);
  if (typeof node.radius === 'number') {
    const { set } = strutGeometry(node.cell, node.cellSize, node.radius, node.nodeRadius);
    host.features.push(node.radius);
    const reg = b.strutSet(set, local.x, local.y, local.z, null);
    return clipToRegion(host, { reg, quality: 'bound', lipschitz: 1, box: null }, node.region, frame);
  }
  const reach = radiusReach(node, value);
  const { set } = strutGeometry(node.cell, node.cellSize, reach, undefined);
  if (Number.isFinite(value.lo) && value.lo > 0) host.features.push(value.lo);
  const radius = b.min(b.max(value.reg, b.constant(0)), b.constant(reach));
  const reg = b.strutSet(set, local.x, local.y, local.z, radius);
  return clipToRegion(host, { reg, quality: 'approximate', lipschitz: 1, box: null }, node.region, frame);
}

export function graphPart(host: CompileHost, node: GraphNode | VoronoiNode, frame: Frame): Part {
  const result = node.op === 'voronoi' ? voronoiGeometry(node) : graphGeometry(host.doc, node);
  if (!result.ok) throw new Failure({ ok: false, code: result.code, message: result.message, ids: [...result.ids, node.id] });
  const { set, radiusMax } = result.graph;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of set.nodes)
    for (const axis of [0, 1, 2] as const) {
      lo[axis] = Math.min(lo[axis], p[axis]);
      hi[axis] = Math.max(hi[axis], p[axis]);
    }
  const box = growBox({ min: lo as Vec3, max: hi as Vec3 }, radiusMax);
  host.features.push(Math.min(...set.beams.flatMap((beam) => [beam.ra, beam.rb]).filter((r) => r > 0)));
  const reg = host.b.strutSet(set, frame.x, frame.y, frame.z, null);
  const part: Part = { reg, quality: 'bound', lipschitz: 1, box };
  return clipToRegion(host, part, node.region, frame);
}
