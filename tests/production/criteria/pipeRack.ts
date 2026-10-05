import type { CableTrayElement, PipeElement } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { absolute, distance, elementsOf, polylineLength, round } from '../oracle/geometry';
import { column, parseCsv } from '../oracle/csv';
import {
  ofType,
  parseIfc,
  references,
  stepString,
  type IfcFile,
  type StepValue,
} from '../oracle/ifc';
import { PIPE_OD, section } from '../oracle/steel';
import type { PlantIntent } from '../plant/intent';
import { absoluteMembers } from './plantStructure';

/**
 * @layer tests/production/criteria
 *
 * Pipe-rack acceptance, the checks a piping / structural lead does before issuing a rack: every
 * line and the tray rest on the steel of every bent they cross, headroom over the road, spacing
 * between lines, battery limit to battery limit continuity, and line metres per size against the
 * takeoff and the pipe schedule. All geometry is read from the final document and compared with
 * the stated rules and the independent section / pipe tables.
 */

export interface RackRules {
  /** Minimum clear height under the rack over the road, mm. */
  roadClearHeight: number;
  /** Road crossing along X (it runs along Y across the whole rack). */
  road: { xMin: number; xMax: number };
  /** Minimum clear gap between adjacent lines on a tier, mm. */
  minLineGap: number;
  /** Allowed distance between a line's underside and top of steel, mm. */
  supportTolerance: number;
  batteryLimits: { west: number; east: number };
}

const AT = 1; // positional tolerance when matching bent axes, mm
const END_TOLERANCE = 10;

interface Run {
  /** Mark of the pipe / tray. */
  label: string;
  kind: 'pipe' | 'tray';
  route: Vec3[];
  /** Plan width (outside diameter / tray width) and vertical extent, mm. */
  width: number;
  height: number;
}

function runsOf(ctx: GradeContext): Run[] {
  const { document } = ctx;
  const pipe = (p: PipeElement): Run => ({
    label: `${p.mark} ${p.service}`,
    kind: 'pipe',
    route: p.points.map((point) => absolute(document, p.levelId, point)),
    width: p.diameter,
    height: p.diameter,
  });
  const tray = (t: CableTrayElement): Run => ({
    label: `${t.mark} ${t.system} tray`,
    kind: 'tray',
    route: t.points.map((point) => absolute(document, t.levelId, point)),
    width: t.width,
    height: t.height,
  });
  return [...elementsOf(document, 'pipe').map(pipe), ...elementsOf(document, 'tray').map(tray)];
}

/** Point of the route at plane x (first segment crossing it), or null when the run does not reach x. */
function crossingAt(route: Vec3[], x: number): Vec3 | null {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (!a || !b || a[0] === b[0]) continue;
    const t = (x - a[0]) / (b[0] - a[0]);
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      return [x, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    }
  }
  return null;
}

const underside = (run: Run, point: Vec3): number => point[2] - run.height / 2;

/** X of every bent: the distinct x of the model's columns. */
function bentsOf(ctx: GradeContext): number[] {
  const xs: number[] = [];
  for (const { element, start } of absoluteMembers(ctx.document)) {
    if (element.role === 'column' && !xs.some((x) => Math.abs(x - start[0]) <= AT))
      xs.push(start[0]);
  }
  return xs.sort((a, b) => a - b);
}

interface TierBeam {
  mark: string;
  yMin: number;
  yMax: number;
  top: number;
}

/** Beams spanning across the rack (along Y) in the bent plane x, with their top of steel. */
function tierBeamsAt(ctx: GradeContext, x: number): { beams: TierBeam[]; unknown: string[] } {
  const beams: TierBeam[] = [];
  const unknown: string[] = [];
  for (const { element, start, end } of absoluteMembers(ctx.document)) {
    const across =
      element.role === 'beam' &&
      Math.abs(start[0] - x) <= AT &&
      Math.abs(end[0] - x) <= AT &&
      Math.abs(start[1] - end[1]) > AT;
    if (!across) continue;
    const facts = section(element.profile);
    if (!facts) {
      unknown.push(element.profile);
      continue;
    }
    beams.push({
      mark: element.mark,
      yMin: Math.min(start[1], end[1]),
      yMax: Math.max(start[1], end[1]),
      top: (start[2] + end[2]) / 2 + facts.h / 2,
    });
  }
  return { beams, unknown };
}

function supportCheck(kind: Run['kind'], rules: RackRules, ctx: GradeContext): CheckOutcome {
  const runs = runsOf(ctx).filter((run) => run.kind === kind);
  const bents = bentsOf(ctx);
  const problems: string[] = [];
  let supports = 0;
  if (runs.length === 0) return { pass: false, detail: `no ${kind} in the model` };
  for (const x of bents) {
    const { beams, unknown } = tierBeamsAt(ctx, x);
    if (unknown.length > 0)
      problems.push(`bent x=${round(x, 0)}: section ${unknown[0]} not tabulated`);
    for (const run of runs) {
      const at = crossingAt(run.route, x);
      if (!at) {
        problems.push(`${run.label} does not reach bent x=${round(x, 0)}`);
        continue;
      }
      const bottom = underside(run, at);
      const half = run.width / 2;
      const carrier = beams.find(
        (beam) =>
          at[1] - half >= beam.yMin - AT &&
          at[1] + half <= beam.yMax + AT &&
          Math.abs(beam.top - bottom) <= rules.supportTolerance,
      );
      if (carrier) {
        supports++;
        continue;
      }
      const under = beams.filter((beam) => at[1] >= beam.yMin && at[1] <= beam.yMax);
      const nearest = under
        .map((beam) => beam.top - bottom)
        .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      problems.push(
        `${run.label} at bent x=${round(x, 0)}: ` +
          (nearest === undefined
            ? `no tier beam under y=${round(at[1], 0)}`
            : `underside ${round(bottom, 1)} is ${round(Math.abs(nearest), 1)} mm ${nearest > 0 ? 'below' : 'above'} top of steel`),
      );
    }
  }
  return {
    pass: problems.length === 0 && bents.length > 0,
    detail:
      problems.length === 0
        ? `${runs.length} ${kind}(s) each rest on a tier beam at all ${bents.length} bents (${supports} supports, underside = top of steel ±${rules.supportTolerance} mm)`
        : `${problems.length} unsupported crossing(s): ${problems.slice(0, 4).join('; ')}`,
  };
}

function roadClearanceCheck(rules: RackRules, ctx: GradeContext): CheckOutcome {
  const { xMin, xMax } = rules.road;
  const candidates: { label: string; bottom: number }[] = [];
  const obstructions: string[] = [];
  for (const { element, start, end } of absoluteMembers(ctx.document)) {
    const reaches = Math.max(start[0], end[0]) > xMin && Math.min(start[0], end[0]) < xMax;
    if (!reaches) continue;
    if (element.role === 'column')
      obstructions.push(`${element.mark} (${element.profile}) stands in the road`);
    const facts = section(element.profile);
    candidates.push({
      label: `${element.mark} ${element.profile}`,
      bottom: Math.min(start[2], end[2]) - (facts?.h ?? 0) / 2,
    });
  }
  for (const run of runsOf(ctx)) {
    // Corridor edges plus every route vertex inside the corridor (a line may dip between them).
    const inside = [
      ...[xMin, xMax].map((x) => crossingAt(run.route, x)),
      ...run.route.filter((point) => point[0] > xMin && point[0] < xMax),
    ].filter((point): point is Vec3 => point !== null);
    if (inside.length === 0) continue;
    candidates.push({
      label: run.label,
      bottom: Math.min(...inside.map((point) => underside(run, point))),
    });
  }
  const lowest = candidates.sort((a, b) => a.bottom - b.bottom)[0];
  if (!lowest)
    return { pass: false, detail: 'nothing crosses the road corridor: no rack over the road' };
  const pass = lowest.bottom >= rules.roadClearHeight && obstructions.length === 0;
  return {
    pass,
    detail:
      `lowest underside over the road (x ${xMin}–${xMax}) is ${round(lowest.bottom, 1)} mm (${lowest.label}) ` +
      `vs ${rules.roadClearHeight} mm required, ${candidates.length} element(s) cross the corridor` +
      (obstructions.length > 0 ? `; ${obstructions.join('; ')}` : ''),
  };
}

interface Placed {
  run: Run;
  y: number;
  bottom: number;
}

function spacingCheck(rules: RackRules, ctx: GradeContext): CheckOutcome {
  const runs = runsOf(ctx);
  const problems: string[] = [];
  let minimum = Infinity;
  let pairs = 0;
  for (const x of bentsOf(ctx)) {
    const placed: Placed[] = [];
    for (const run of runs) {
      const at = crossingAt(run.route, x);
      if (at) placed.push({ run, y: at[1], bottom: underside(run, at) });
    }
    placed.sort((a, b) => a.bottom - b.bottom);
    const tiers: Placed[][] = [];
    for (const item of placed) {
      const tier = tiers.find(
        (group) => Math.abs((group[0]?.bottom ?? 0) - item.bottom) <= rules.supportTolerance + 50,
      );
      if (tier) tier.push(item);
      else tiers.push([item]);
    }
    for (const tier of tiers) {
      tier.sort((a, b) => a.y - b.y);
      for (let i = 1; i < tier.length; i++) {
        const a = tier[i - 1];
        const b = tier[i];
        if (!a || !b) continue;
        const gap = b.y - b.run.width / 2 - (a.y + a.run.width / 2);
        pairs++;
        minimum = Math.min(minimum, gap);
        const message = `${a.run.label} / ${b.run.label} ${round(gap, 1)} mm`;
        if (gap < rules.minLineGap && !problems.includes(message)) problems.push(message);
      }
    }
  }
  return {
    pass: problems.length === 0 && pairs > 0,
    detail:
      problems.length === 0
        ? `${pairs} adjacent pairs on the tiers, smallest clear gap ${round(minimum, 1)} mm (≥ ${rules.minLineGap} mm)`
        : `clear gap < ${rules.minLineGap} mm: ${problems.slice(0, 4).join('; ')}`,
  };
}

function batteryLimitsCheck(
  intent: PlantIntent,
  rules: RackRules,
  ctx: GradeContext,
): CheckOutcome {
  const pipes = elementsOf(ctx.document, 'pipe');
  const bents = bentsOf(ctx);
  const first = bents[0] ?? 0;
  const last = bents.at(-1) ?? 0;
  const tieIns = Object.entries(intent.tieIns);
  const used = new Map<string, string>();
  const problems: string[] = [];
  if (pipes.length !== intent.pipes.length) {
    problems.push(`${pipes.length} lines modelled, ${intent.pipes.length} in the line list`);
  }
  for (const pipe of pipes) {
    const route = pipe.points.map((point) => absolute(ctx.document, pipe.levelId, point));
    const ends = [route[0], route.at(-1)];
    const sides = ends.map((end) => {
      const tieIn = end
        ? tieIns.find(([, point]) => distance(point, end) <= END_TOLERANCE)
        : undefined;
      if (tieIn) used.set(tieIn[0], pipe.mark);
      return { end, tieIn: tieIn?.[0] };
    });
    if (sides.some((side) => side.tieIn === undefined)) {
      problems.push(`${pipe.mark} ${pipe.service}: an end is not at a battery-limit tie-in`);
      continue;
    }
    const xs = ends.map((end) => end?.[0] ?? NaN).sort((a, b) => a - b);
    if (
      Math.abs((xs[0] ?? NaN) - rules.batteryLimits.west) > END_TOLERANCE ||
      Math.abs((xs[1] ?? NaN) - rules.batteryLimits.east) > END_TOLERANCE
    ) {
      problems.push(
        `${pipe.mark} ${pipe.service} runs x ${round(xs[0] ?? NaN, 0)} to ${round(xs[1] ?? NaN, 0)}, not BL1 to BL2`,
      );
    }
    if (Math.min(...route.map((p) => p[0])) > first || Math.max(...route.map((p) => p[0])) < last) {
      problems.push(`${pipe.mark} does not span bent 1 to bent ${bents.length}`);
    }
    if (route.length !== 2)
      problems.push(`${pipe.mark} has ${route.length - 2} bend(s) on a straight rack line`);
  }
  const unused = tieIns.filter(([id]) => !used.has(id)).map(([id]) => id);
  if (unused.length > 0) problems.push(`tie-ins with no line: ${unused.slice(0, 6).join(', ')}`);
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${pipes.length} lines, each from a BL1 tie-in (x ${rules.batteryLimits.west}) to a BL2 tie-in (x ${rules.batteryLimits.east}) over all ${bents.length} bents`
        : problems.slice(0, 5).join('; '),
  };
}

const diameterOfKey = (key: string): number => Number(/Ø([\d.]+)\.m$/.exec(key)?.[1] ?? NaN);

function lineMetresCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const designed = new Map<number, number>();
  for (const line of intent.pipes) {
    const od = PIPE_OD[line.dn] ?? 0;
    designed.set(od, (designed.get(od) ?? 0) + polylineLength(line.route) / 1000);
  }
  const takeoff = ctx.run('quantity_takeoff').data as {
    lines?: { key: string; unit: string; quantity: number }[];
  };
  const takeoffByOd = new Map<number, number>();
  for (const line of takeoff.lines ?? []) {
    if (!line.key.startsWith('pipe.') || line.unit !== 'm') continue;
    const od = diameterOfKey(line.key);
    takeoffByOd.set(od, (takeoffByOd.get(od) ?? 0) + line.quantity);
  }
  const schedule = parseCsv(ctx.deliverable('schedule:pipe'));
  const scheduleByOd = new Map<number, number>();
  const diameters = column(schedule, 'Diameter (mm)');
  column(schedule, 'Length (m)').forEach((metres, index) => {
    const od = diameters[index] ?? NaN;
    scheduleByOd.set(od, (scheduleByOd.get(od) ?? 0) + metres);
  });
  const problems: string[] = [];
  const rows: string[] = [];
  for (const [od, metres] of [...designed].sort((a, b) => a[0] - b[0])) {
    const dn = Object.entries(PIPE_OD).find(([, value]) => value === od)?.[0] ?? '?';
    const taken = takeoffByOd.get(od) ?? 0;
    const listed = scheduleByOd.get(od) ?? 0;
    rows.push(`DN${dn} ${round(metres, 1)}/${round(taken, 1)}/${round(listed, 1)}`);
    const tolerance = 0.005 * metres + 0.05;
    if (Math.abs(taken - metres) > tolerance)
      problems.push(`DN${dn} takeoff ${round(taken, 1)} m, design ${round(metres, 1)} m`);
    if (Math.abs(listed - metres) > tolerance)
      problems.push(`DN${dn} pipe schedule ${round(listed, 1)} m, design ${round(metres, 1)} m`);
  }
  const extra = [...takeoffByOd.keys()].filter((od) => !designed.has(od));
  if (extra.length > 0)
    problems.push(`takeoff lists sizes not in the line list: Ø${extra.join(', Ø')}`);
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `line metres per size agree (design/takeoff/schedule): ${rows.join(', ')}`
        : `${problems.join('; ')} [design/takeoff/schedule: ${rows.join(', ')}]`,
  };
}

function trayCheck(intent: PlantIntent, rules: RackRules, ctx: GradeContext): CheckOutcome {
  const wanted = intent.trays ?? [];
  const trays = elementsOf(ctx.document, 'tray');
  const problems: string[] = [];
  if (trays.length !== wanted.length)
    problems.push(`${trays.length} tray run(s), design has ${wanted.length}`);
  const designedMetres = wanted.reduce((sum, tray) => sum + polylineLength(tray.route) / 1000, 0);
  const modelledMetres = trays.reduce(
    (sum, tray) =>
      sum + polylineLength(tray.points.map((p) => absolute(ctx.document, tray.levelId, p))) / 1000,
    0,
  );
  if (Math.abs(modelledMetres - designedMetres) > 0.005 * designedMetres + 0.05) {
    problems.push(`${round(modelledMetres, 2)} m of tray, design ${round(designedMetres, 2)} m`);
  }
  const takeoff = ctx.run('quantity_takeoff').data as {
    lines?: { key: string; unit: string; quantity: number }[];
  };
  const takeoffMetres = (takeoff.lines ?? [])
    .filter((line) => line.key.startsWith('tray.') && line.unit === 'm')
    .reduce((sum, line) => sum + line.quantity, 0);
  if (Math.abs(takeoffMetres - designedMetres) > 0.005 * designedMetres + 0.05) {
    problems.push(
      `takeoff ${round(takeoffMetres, 2)} m of tray, design ${round(designedMetres, 2)} m`,
    );
  }
  const support = supportCheck('tray', rules, ctx);
  if (!support.pass) problems.push(support.detail);
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${trays.length} cable tray run(s), ${round(modelledMetres, 2)} m in model and takeoff, supported at every bent`
        : problems.join('; '),
  };
}

const numbers = (value: StepValue | undefined): number[] =>
  Array.isArray(value) ? value.map((item) => Number(item)) : [];

/** Radius, extrusion depth, start point and axis of the straight solid an IFC element is built on. */
function extrusionOf(
  file: IfcFile,
  shape: number,
): { radius: number; depth: number; origin: number[]; axis: number[] } | null {
  const entity = (id: number | undefined): { type: string; args: StepValue[] } | undefined =>
    id === undefined ? undefined : file.entities.get(id);
  const [representation] = references([entity(shape)?.args[2] ?? []]);
  const [solidId] = references([entity(representation)?.args[3] ?? []]);
  const solid = entity(solidId);
  if (solid?.type !== 'IFCEXTRUDEDAREASOLID') return null;
  const profile = entity(references([solid.args[0] ?? '$'])[0]);
  const placement = entity(references([solid.args[1] ?? '$'])[0]);
  const origin = numbers(entity(references([placement?.args[0] ?? '$'])[0])?.args[0]);
  const axis = numbers(entity(references([placement?.args[1] ?? '$'])[0])?.args[0]);
  return { radius: Number(profile?.args[3]), depth: Number(solid.args[3]), origin, axis };
}

/** The briefed line whose ends match this route (either direction), or undefined. */
function intendedLine(
  intent: PlantIntent,
  route: Vec3[],
): PlantIntent['pipes'][number] | undefined {
  const a = route[0] ?? [0, 0, 0];
  const b = route.at(-1) ?? [0, 0, 0];
  return intent.pipes.find((line) => {
    const first = line.route[0] ?? [0, 0, 0];
    const last = line.route.at(-1) ?? [0, 0, 0];
    return (
      (distance(a, first) <= END_TOLERANCE && distance(b, last) <= END_TOLERANCE) ||
      (distance(a, last) <= END_TOLERANCE && distance(b, first) <= END_TOLERANCE)
    );
  });
}

function ifcLinesCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const file = parseIfc(ctx.deliverable('ifc'));
  const segments = ofType(file, 'IFCPIPESEGMENT');
  const problems: string[] = [];
  const pipes = elementsOf(ctx.document, 'pipe');
  for (const pipe of pipes) {
    const route = pipe.points.map((point) => absolute(ctx.document, pipe.levelId, point));
    const segment = segments.find((entity) => stepString(entity.args[7]) === pipe.id);
    if (!segment) {
      problems.push(`${pipe.mark} ${pipe.service} not in the IFC`);
      continue;
    }
    const lineNumber = intendedLine(intent, route)?.line;
    if (lineNumber === undefined) {
      problems.push(`${pipe.mark} matches no briefed line`);
    } else if (
      !new RegExp(`(^|\\W)${lineNumber}(\\W|$)`).test(
        `${stepString(segment.args[2])} ${stepString(segment.args[3])}`,
      )
    ) {
      problems.push(`${pipe.mark}: IFC carries no line number ${lineNumber}`);
    }
    const solid = extrusionOf(file, references([segment.args[6] ?? '$'])[0] ?? -1);
    const start = route[0] ?? [0, 0, 0];
    const end = route.at(-1) ?? [0, 0, 0];
    const length = distance(start, end);
    const exported: Vec3 = [
      solid?.origin[0] ?? NaN,
      solid?.origin[1] ?? NaN,
      solid?.origin[2] ?? NaN,
    ];
    const direction = [
      (end[0] - start[0]) / length,
      (end[1] - start[1]) / length,
      (end[2] - start[2]) / length,
    ];
    if (!solid) problems.push(`${pipe.mark}: no extruded solid`);
    else if (
      Math.abs(solid.radius * 2 - pipe.diameter) > 0.5 ||
      Math.abs(solid.depth - length) > 1 ||
      distance(exported, start) > 1 ||
      direction.some((component, index) => Math.abs(component - (solid.axis[index] ?? NaN)) > 1e-3)
    ) {
      problems.push(
        `${pipe.mark} IFC solid Ø${round(solid.radius * 2, 1)} × ${round(solid.depth, 1)} mm, model Ø${pipe.diameter} × ${round(length, 1)} mm`,
      );
    }
  }
  const trays = ofType(file, 'IFCCABLECARRIERSEGMENT').length;
  const modelTrays = elementsOf(ctx.document, 'tray').length;
  if (trays !== modelTrays)
    problems.push(`IFC has ${trays} cable carrier segment(s), model ${modelTrays} tray(s)`);
  return {
    pass: problems.length === 0 && pipes.length > 0,
    detail:
      problems.length === 0
        ? `${pipes.length} IFC pipe segments carry their line number, OD, length, start point and direction; ${trays} cable carrier(s)`
        : problems.slice(0, 4).join('; '),
  };
}

export function pipeRackCriteria(intent: PlantIntent, rules: RackRules): Criterion[] {
  return [
    {
      id: 'rack-line-supports',
      area: 'engineering',
      requirement:
        'Every line rests on the tier beam of every bent it crosses: pipe underside = top of steel (±5 mm).',
      check: (ctx) => supportCheck('pipe', rules, ctx),
    },
    {
      id: 'rack-cable-tray',
      area: 'engineering',
      requirement:
        'The cable tray runs the rack length on the upper tier, supported on every bent, and is in the takeoff.',
      check: (ctx) => trayCheck(intent, rules, ctx),
    },
    {
      id: 'rack-road-clearance',
      area: 'coordination',
      requirement:
        'Clear height under the rack over the road crossing is at least the briefed value, with no column in the road.',
      check: (ctx) => roadClearanceCheck(rules, ctx),
    },
    {
      id: 'rack-line-spacing',
      area: 'piping',
      requirement:
        'Adjacent lines (and the tray) on a tier keep the minimum clear gap between outside diameters.',
      check: (ctx) => spacingCheck(rules, ctx),
    },
    {
      id: 'rack-battery-limits',
      area: 'piping',
      requirement:
        'Every line runs straight from its BL1 tie-in to its BL2 tie-in over the full rack length; no tie-in left unused.',
      check: (ctx) => batteryLimitsCheck(intent, rules, ctx),
    },
    {
      id: 'rack-ifc-lines',
      area: 'deliverables',
      requirement:
        'The IFC carries every line with its line number, outside diameter, length, start point and direction, and the cable tray.',
      check: (ctx) => ifcLinesCheck(intent, ctx),
    },
    {
      id: 'rack-line-metres',
      area: 'piping',
      requirement:
        'Total line metres per DN agree between the design, the quantity takeoff and the pipe schedule.',
      check: (ctx) => lineMetresCheck(intent, ctx),
    },
  ];
}
