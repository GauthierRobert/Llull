/**
 * Lattice nodes of the field compiler (05 IMP 5.4-5.6): TPMS (rectangular, cylindrical or spherical cells, constant or graded wall / level), periodic strut
 * lattices (constant or graded radius) and graph lattices. Distance quality: TPMS approximate, strut and graph sets bound (graded strut radius: approximate).
 */

import type { GridSamples } from '@core/geometry/field/sampled';
import type { Vec3 } from '@core/model/types';
import { type CompileHost, Failure, type Part, degrade, worst } from './compileTypes';
import { type Frame, axisFrame, growBox, placeFrame } from './frame';
import { graphGeometry } from './graph';
import type { CellMap, GraphNode, StrutsNode, TpmsNode, VoronoiNode } from './model';
import { type PhaseGrids, surfaceMapOf } from './surfaceMap';
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

/** The lattice node fields a cell map reads. */
interface Mappable {
  readonly id: string;
  readonly cellSize: Vec3;
  readonly origin: Vec3;
  readonly rotation: Vec3;
  readonly map?: CellMap;
}

/** Cell coordinates of `node` at the frame point: rectangular, or the phases of its map (2 pi per cell) with the phase per document length of each. */
function cellCoordinates(host: CompileHost, node: Mappable, frame: Frame): CellCoordinates {
  const b = host.b;
  const map = node.map;
  if (map === undefined) return rectangularCoordinates(b, node.cellSize, placeFrame(b, frame, node.origin, node.rotation, 1));
  if (map.kind === 'cylindrical')
    return cylindricalCoordinates(b, axisFrame(b, frame, map.origin, map.axis), map.cellsAround, node.cellSize[2], map.radialCellSize);
  if (map.kind === 'surface_uv') {
    const made = surfaceMapOf(host.doc, map);
    if (!made.ok) throw new Failure({ ok: false, code: made.code, message: made.message, ids: [...made.ids, node.id] });
    const { u, v, w, scales, stretch, variation } = made.data;
    if (stretch.max > STRETCH_WARNING * stretch.min || variation > STRETCH_WARNING)
      host.warnings.push({
        code: 'IMP_MAP_STRETCH',
        ids: [node.id, map.sheetId],
        message: `the cells of '${node.id}' on sheet '${map.sheetId}' are stretched: longest to shortest edge up to ${stretch.max.toPrecision(3)}, a local cell ${variation.toPrecision(3)} times the mean one: walls are not uniform where the sheet is far from developable`,
      });
    const sample = (grid: GridSamples): number => b.sampledField(grid, frame.x, frame.y, frame.z);
    const phase = (grids: PhaseGrids): number =>
      grids.kind === 'linear' ? b.scale(sample(grids.grid), TWO_PI) : b.op('atan2', sample(grids.sin), sample(grids.cos));
    return {
      coords: [phase(u), phase(v), b.scale(sample(w), TWO_PI)],
      scales: [b.constant(scales[0]), b.constant(scales[1]), b.constant(scales[2])],
    };
  }
  host.warnings.push({
    code: 'IMP_MAP_POLE',
    ids: [node.id],
    message: `the spherical cells of '${node.id}' collapse at the poles of the axis through ${JSON.stringify(map.origin)}: walls are not uniform there`,
  });
  return sphericalCoordinates(b, placeFrame(b, frame, map.origin, [0, 0, 0], 1), map.cellsAround, map.cellsPolar, map.radialCellSize);
}

const TWO_PI = 2 * Math.PI;
/** Longest to shortest cell edge above which a surface map reports its stretch. */
const STRETCH_WARNING = 2;

/**
 * The part of a surface-mapped lattice restricted to its support: the slab 0 <= w <= layers (distance (w) in cells of depth, negative inside) and the footprint of the sheet
 * (lateral distance), in the box of the sheet grown by `layers * depth`. Other maps and rectangular lattices are returned as they are.
 */
function supported(host: CompileHost, node: Mappable, part: Part, frame: Frame): Part {
  const map = node.map;
  if (map?.kind !== 'surface_uv') return part;
  const made = surfaceMapOf(host.doc, map);
  if (!made.ok) throw new Failure({ ok: false, code: made.code, message: made.message, ids: [...made.ids, node.id] });
  const { w, lateral, bounds } = made.data;
  const b = host.b;
  const normal = b.sampledField(w, frame.x, frame.y, frame.z);
  const slab = b.scale(b.max(b.neg(normal), b.shift(normal, -map.layers)), map.depth);
  const footprint = b.sampledField(lateral, frame.x, frame.y, frame.z);
  return { ...part, reg: b.max(part.reg, b.max(slab, footprint)), box: bounds };
}

/** Lipschitz bound of the field on a surface map: twice the larger of the cell aspect and the local-to-mean cell size (other maps keep their own bounds). */
function surfaceLipschitz(host: CompileHost, map: CellMap | undefined, fallback: number): number {
  if (map?.kind !== 'surface_uv') return fallback;
  const made = surfaceMapOf(host.doc, map);
  return made.ok ? 2 * Math.max(made.data.stretch.max, made.data.variation) : fallback;
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
  const flat = node.normalize === 'gradient' ? 2 : (2 * Math.PI * TPMS_FACTS[node.kind].gradBound) / smallest;
  const lipschitz = surfaceLipschitz(host, node.map, flat);
  return clipToRegion(host, supported(host, node, { reg, quality: 'approximate', lipschitz, box: null }, frame), node.region, frame);
}

/** Largest radius the periodic set may carry: the law's upper bound, else just under half the shortest strut. */
function radiusReach(node: StrutsNode, value: ScalarPart): number {
  const shortest = Math.min(...strutGeometry(node.cell, node.cellSize, 1e-6, undefined).lengths);
  return Number.isFinite(value.hi) ? Math.min(value.hi, shortest / 2) : shortest / 2;
}

/**
 * A strut lattice on a cell map: the periodic cell of `cellSize` is laid on the cells of the map (cell coordinate i times cellSize[i]), the strut set is evaluated at those
 * lengths and its distance is divided by the mean local stretch of the map (phase scale / 2 pi times cell size, averaged over the three axes). The result is approximate, not
 * a distance; a radius (number or law) is multiplied by the same stretch, capped below half the shortest strut.
 */
function mappedStruts(host: CompileHost, node: StrutsNode, frame: Frame): Part {
  const b = host.b;
  const cell = cellCoordinates(host, node, frame);
  const mapped = cell.coords.map((phase, axis) => b.scale(phase, (node.cellSize[axis] as number) / TWO_PI)) as [number, number, number];
  const stretch = b.scale(
    [0, 1, 2]
      .map((axis) => b.scale(cell.scales[axis] as number, (node.cellSize[axis] as number) / TWO_PI))
      .reduce((sum, term) => b.add(sum, term)),
    1 / 3,
  );
  const value = host.law(node.radius, frame);
  const reach = radiusReach(node, { reg: value.reg, lo: -Infinity, hi: Infinity });
  const { set } = strutGeometry(node.cell, node.cellSize, reach, undefined);
  if (Number.isFinite(value.lo) && value.lo > 0) host.features.push(value.lo);
  const radius = b.min(b.max(b.mul(value.reg, stretch), b.constant(0)), b.constant(reach));
  const reg = b.div(b.strutSet(set, mapped[0], mapped[1], mapped[2], radius), stretch);
  const lipschitz = surfaceLipschitz(host, node.map, 2);
  return clipToRegion(host, supported(host, node, { reg, quality: 'approximate', lipschitz, box: null }, frame), node.region, frame);
}

export function strutsPart(host: CompileHost, node: StrutsNode, frame: Frame): Part {
  if (node.map !== undefined) return mappedStruts(host, node, frame);
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
  host.features.push(
    set.beams.reduce((smallest, beam) => [beam.ra, beam.rb].reduce((m, r) => (r > 0 ? Math.min(m, r) : m), smallest), Infinity),
  );
  const reg = host.b.strutSet(set, frame.x, frame.y, frame.z, null);
  const part: Part = { reg, quality: 'bound', lipschitz: 1, box };
  return clipToRegion(host, part, node.region, frame);
}
