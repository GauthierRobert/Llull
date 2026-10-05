/**
 * Pipes and cable trays resting on beams: a run bears on a beam where it crosses the beam in plan
 * with its underside at the beam's top of steel; each support takes the run weight over half the
 * span to the neighbouring supports (the end supports also the overhang to the run end).
 * @layer domain-aec
 * @pure
 */

import type { CableTrayElement, PipeElement } from '@core/model/building';
import { type ModelUnits, type SteelBar } from './steelMemberBars';
import { addPointLoad, type BeamLoads } from './steelBeamLoads';
import type { ColumnNode } from './steelFraming';
import { pipeWeightPerMetre } from './pipeWeight';
import { carriedByEnds, pipeRunOf, weightSupportsOf } from './pipeSupportLayout';
import { applySupportedPipe } from './steelSupportLoads';

export interface LineLoadParams {
  /** kg/m³ of the pipe contents (1000 = water, 0 = empty). */
  readonly pipeContentDensity: number;
  /** kg/m of a cable tray including its cables. */
  readonly cableTrayWeight: number;
}

export interface LineRunReport {
  readonly id: string;
  readonly mark: string;
  readonly kind: 'pipe' | 'tray';
  readonly label: string;
  /** Weight per metre, kN/m. */
  readonly weightPerMetre: number;
  readonly lengthM: number;
  readonly supports: number;
  /** 'supports' = carried by the pipe's add_pipe_support supports; 'resting' = lying on top of steel; 'nozzles' = both ends carried by equipment / headers within the table span. */
  readonly basis: 'resting' | 'supports' | 'nozzles';
  /** Weight delivered to beams and columns, kN. */
  readonly carriedKn: number;
}

export interface LineLoadResult {
  readonly runs: LineRunReport[];
  readonly warnings: string[];
  /** Pipe loads delivered to columns by supports: column id → nodes for the column check. */
  readonly columnNodes: Array<readonly [string, ColumnNode]>;
}

interface Run {
  readonly id: string;
  readonly mark: string;
  readonly kind: 'pipe' | 'tray';
  readonly label: string;
  /** Absolute centreline, mm. */
  readonly points: ReadonlyArray<readonly [number, number, number]>;
  /** Distance from the centreline to the underside, mm. */
  readonly halfDepth: number;
  readonly weightPerMetre: number;
  /** The pipe element (absent for trays). */
  readonly pipe?: PipeElement;
}

interface Support {
  /** Arc length along the run, mm. */
  readonly s: number;
  readonly beam: BeamLoads;
  /** Position along the beam, mm. */
  readonly at: number;
}

/** Pipe underside within this of the beam top of steel rests on it, mm. */
const SUPPORT_TOLERANCE = 10;
/** A crossing this far beyond the beam end still counts, mm. */
const END_TOLERANCE = 50;
/** Supports of one run closer than this share one tributary, mm. */
const GROUP_DISTANCE = 100;
const NEARLY_HORIZONTAL = 0.1;

function runOf(
  units: ModelUnits,
  element: PipeElement | CableTrayElement,
  params: LineLoadParams,
): Run {
  const { toMm, elevationMm } = units;
  const base = elevationMm(element.levelId);
  const points = element.points.map((point): [number, number, number] => [
    toMm(point[0] ?? 0),
    toMm(point[1] ?? 0),
    base + toMm(point[2] ?? 0),
  ]);
  if (element.category === 'pipe') {
    const diameter = toMm(element.diameter);
    return {
      id: element.id,
      mark: element.mark,
      kind: 'pipe',
      label: `${element.service} Ø${Math.round(diameter * 10) / 10}`,
      points,
      halfDepth: diameter / 2,
      weightPerMetre: pipeWeightPerMetre(diameter, params.pipeContentDensity),
      pipe: element,
    };
  }
  return {
    id: element.id,
    mark: element.mark,
    kind: 'tray',
    label: `${element.system} tray ${Math.round(toMm(element.width))} wide`,
    points,
    halfDepth: toMm(element.height) / 2,
    weightPerMetre: (params.cableTrayWeight * 9.80665) / 1000,
  };
}

function runsOf(units: ModelUnits, params: LineLoadParams): Run[] {
  const { building } = units;
  return building.elementOrder.flatMap((id) => {
    const element = building.elements[id];
    return element?.category === 'pipe' || element?.category === 'tray'
      ? [runOf(units, element, params)]
      : [];
  });
}

/** Arc lengths (mm) at which `pipe` rests on top of `beams` (the rule for pipes without supports). */
export function restingArcs(
  units: ModelUnits,
  pipe: PipeElement,
  beams: ReadonlyArray<BeamLoads>,
): number[] {
  const run = runOf(units, pipe, { pipeContentDensity: 0, cableTrayWeight: 0 });
  return supportsOf(run, beams).supports.map((support) => support.s);
}

/** Supports of a run on `beams`, sorted by arc length, and the run length (mm). */
function supportsOf(
  run: Run,
  beams: ReadonlyArray<BeamLoads>,
): { supports: Support[]; length: number } {
  const supports: Support[] = [];
  let travelled = 0;
  run.points.forEach((from, index) => {
    const to = run.points[index + 1];
    if (!to) return;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const segment = Math.hypot(dx, dy, dz);
    if (segment > 0 && Math.abs(dz) <= NEARLY_HORIZONTAL * segment) {
      for (const beam of beams) {
        const sx = beam.b[0] - beam.a[0];
        const sy = beam.b[1] - beam.a[1];
        const cross = dx * sy - dy * sx;
        if (Math.abs(cross) < 1e-9 * Math.hypot(dx, dy) * Math.hypot(sx, sy)) continue;
        const qx = beam.a[0] - from[0];
        const qy = beam.a[1] - from[1];
        const u = (qx * sy - qy * sx) / cross;
        const t = (qx * dy - qy * dx) / cross;
        const beamLength = beam.lengthM * 1000;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        if (t * beamLength < -END_TOLERANCE || t * beamLength > beamLength + END_TOLERANCE)
          continue;
        const underside = from[2] + u * dz - run.halfDepth;
        if (Math.abs(underside - beam.top) > SUPPORT_TOLERANCE) continue;
        const s = travelled + u * segment;
        const duplicate = supports.some(
          (support) => support.beam === beam && Math.abs(support.s - s) < 1,
        );
        if (!duplicate) {
          supports.push({
            s,
            beam,
            at: Math.min(beamLength, Math.max(0, t * beamLength)),
          });
        }
      }
    }
    travelled += segment;
  });
  return { supports: supports.sort((a, b) => a.s - b.s), length: travelled };
}

/** Group supports closer than GROUP_DISTANCE; each group gets the tributary of its mean position. */
function tributaries(
  supports: ReadonlyArray<Support>,
  length: number,
): Array<{ support: Support; tributary: number }> {
  const groups: Support[][] = [];
  for (const support of supports) {
    const last = groups[groups.length - 1];
    if (last && support.s - (last[last.length - 1] as Support).s < GROUP_DISTANCE)
      last.push(support);
    else groups.push([support]);
  }
  const positions = groups.map((group) => group.reduce((sum, { s }) => sum + s, 0) / group.length);
  return groups.flatMap((group, index) => {
    const here = positions[index] as number;
    const previous = positions[index - 1];
    const next = positions[index + 1];
    const before = previous === undefined ? here : (here - previous) / 2;
    const after = next === undefined ? length - here : (next - here) / 2;
    return group.map((support) => ({ support, tributary: (before + after) / group.length }));
  });
}

/**
 * Deposit pipe and tray weight as point loads on the supporting beams.
 * @invariant tributary lengths of one run sum to its length; weight is permanent
 */
export function applyLineLoads(
  units: ModelUnits,
  beams: ReadonlyArray<BeamLoads>,
  params: LineLoadParams,
  bars: ReadonlyArray<SteelBar> = [],
): LineLoadResult {
  const runs: LineRunReport[] = [];
  const warnings: string[] = [];
  const columnNodes: Array<readonly [string, ColumnNode]> = [];
  for (const run of runsOf(units, params)) {
    const pipeRun = run.pipe ? pipeRunOf(units, run.pipe) : null;
    if (pipeRun && weightSupportsOf(units, pipeRun).length > 0) {
      const supported = applySupportedPipe(units, pipeRun, run.weightPerMetre, beams, bars);
      warnings.push(...supported.warnings);
      columnNodes.push(...supported.columnNodes);
      runs.push({
        id: run.id,
        mark: run.mark,
        kind: run.kind,
        label: run.label,
        weightPerMetre: run.weightPerMetre,
        lengthM: pipeRun.lengthMm / 1000,
        supports: supported.supports,
        basis: 'supports',
        carriedKn: supported.carriedKn,
      });
      continue;
    }
    const { supports, length } = supportsOf(run, beams);
    const nozzles = supports.length === 0 && pipeRun !== null && carriedByEnds(units, pipeRun);
    let carried = 0;
    for (const { support, tributary } of tributaries(supports, length)) {
      const weight = (run.weightPerMetre * tributary) / 1000;
      addPointLoad(support.beam, support.at, weight, 0, true);
      support.beam.lineSupport = true;
      carried += weight;
    }
    runs.push({
      id: run.id,
      mark: run.mark,
      kind: run.kind,
      label: run.label,
      weightPerMetre: run.weightPerMetre,
      lengthM: length / 1000,
      supports: supports.length,
      basis: nozzles ? 'nozzles' : 'resting',
      carriedKn: carried,
    });
    if (supports.length === 0 && length > 0 && !nozzles) {
      warnings.push(
        `${run.kind} ${run.mark} (${run.label}) rests on no steel beam: its ${((run.weightPerMetre * length) / 1000).toFixed(1)} kN are not carried by any checked member${run.kind === 'pipe' ? ' (add_pipe_support: shoes on steel below or hangers from steel above)' : ''}`,
      );
    }
  }
  return { runs, warnings, columnNodes };
}
