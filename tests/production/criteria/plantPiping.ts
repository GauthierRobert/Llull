import type { Vec3 } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import {
  absolute,
  distance,
  elementsOf,
  equipmentBox,
  insideBox,
  polylineLength,
  round,
} from '../oracle/geometry';
import { PIPE_OD } from '../oracle/steel';
import { parseCsv } from '../oracle/csv';
import type { PlantIntent } from '../plant/intent';

/**
 * @layer tests/production/criteria
 *
 * Piping acceptance: every process line between its two ends with the right size, no dangling
 * pipe end (each end inside an equipment or at a battery-limit tie-in), and a line list that a
 * piping lead can issue (line number, size, service, from, to).
 */

const END_TOLERANCE = 10;

function absoluteRoute(ctx: GradeContext, levelId: string, points: Vec3[]): Vec3[] {
  return points.map((point) => absolute(ctx.document, levelId, point));
}

function linesCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const pipes = elementsOf(ctx.document, 'pipe').map((pipe) => ({
    pipe,
    route: absoluteRoute(ctx, pipe.levelId, pipe.points),
  }));
  const problems: string[] = [];
  for (const line of intent.pipes) {
    const first = line.route[0] ?? [0, 0, 0];
    const last = line.route.at(-1) ?? [0, 0, 0];
    const found = pipes.find(({ route }) => {
      const a = route[0] ?? [0, 0, 0];
      const b = route.at(-1) ?? [0, 0, 0];
      return (
        (distance(a, first) <= END_TOLERANCE && distance(b, last) <= END_TOLERANCE) ||
        (distance(a, last) <= END_TOLERANCE && distance(b, first) <= END_TOLERANCE)
      );
    });
    if (!found) {
      problems.push(`${line.line} (${line.from} → ${line.to}) not found`);
      continue;
    }
    const od = PIPE_OD[line.dn] ?? 0;
    if (Math.abs(found.pipe.diameter - od) > 0.5) {
      problems.push(`${line.line} is Ø${found.pipe.diameter}, DN${line.dn} is Ø${od}`);
    }
    const designed = polylineLength(line.route);
    const modelled = polylineLength(found.route);
    if (Math.abs(modelled - designed) > 0.01 * designed) {
      problems.push(
        `${line.line} is ${round(modelled / 1000, 2)} m long, routed ${round(designed / 1000, 2)} m`,
      );
    }
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${intent.pipes.length} process lines routed and sized`
        : problems.join('; '),
  };
}

function connectivityCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const boxes = elementsOf(ctx.document, 'equipment').map((e) => ({
    mark: e.mark,
    box: equipmentBox(ctx.document, e),
  }));
  const tieIns = Object.entries(intent.tieIns);
  const dangling: string[] = [];
  let ends = 0;
  for (const pipe of elementsOf(ctx.document, 'pipe')) {
    const route = absoluteRoute(ctx, pipe.levelId, pipe.points);
    for (const end of [route[0], route.at(-1)]) {
      if (!end) continue;
      ends++;
      const inEquipment = boxes.some(({ box }) => insideBox(end, box, 1));
      const atTieIn = tieIns.some(([, point]) => distance(point, end) <= END_TOLERANCE);
      if (!inEquipment && !atTieIn) {
        dangling.push(`${pipe.mark} end (${end.map((v) => round(v, 0)).join(', ')})`);
      }
    }
  }
  return {
    pass: dangling.length === 0,
    detail:
      dangling.length === 0
        ? `${ends} pipe ends, all connected`
        : `dangling: ${dangling.join('; ')}`,
  };
}

function lineListCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const table = parseCsv(ctx.deliverable('schedule:pipe'));
  const problems: string[] = [];
  const header = table[0] ?? [];
  for (const line of intent.pipes) {
    const row = table.slice(1).find((cells) => cells.some((cell) => cell.includes(line.line)));
    if (!row) {
      problems.push(`${line.line} not in the pipe schedule`);
      continue;
    }
    const text = row.join(' | ');
    const missing = [`DN${line.dn}`, line.from, line.to].filter((token) => !text.includes(token));
    if (missing.length > 0) problems.push(`${line.line} row lacks ${missing.join(', ')}`);
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `line list: ${intent.pipes.length} lines with number, DN, from and to`
        : `${problems.join('; ')} (schedule columns: ${header.join(', ')})`,
  };
}

export function pipingCriteria(intent: PlantIntent): Criterion[] {
  return [
    {
      id: 'process-lines',
      area: 'piping',
      requirement:
        'Every process line between its design ends, at its DN outside diameter and routed length.',
      check: (ctx) => linesCheck(intent, ctx),
    },
    {
      id: 'pipe-connectivity',
      area: 'piping',
      requirement:
        'No dangling pipe end: each end inside an equipment or at a battery-limit tie-in.',
      check: (ctx) => connectivityCheck(intent, ctx),
    },
    {
      id: 'line-list',
      area: 'piping',
      requirement:
        'The pipe schedule is a line list: line number, DN, from and to equipment per line.',
      check: (ctx) => lineListCheck(intent, ctx),
    },
  ];
}
