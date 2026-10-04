import { listCommands } from '@core/commands/registry';
import type { Vec2 } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { elementsOf, elevationOf, insidePolygon } from '../oracle/geometry';
import type { PlantIntent } from '../plant/intent';

/**
 * @layer tests/production/criteria
 *
 * Coordination and engineering sign-off: clash-free model, safe access between floors, and every
 * steel member covered by a structural verification the office can sign.
 */

/** Read-only checks that are about geometry or data, not structural verification. */
const NOT_STRUCTURAL = new Set(['check_clashes', 'check_model']);
const BLONDEL = { min: 600, max: 650 };

function clashCheck({ run }: GradeContext): CheckOutcome {
  const result = run('check_clashes');
  const clashes = ((result.data as { clashes?: unknown[] } | undefined)?.clashes ?? []).length;
  return { pass: clashes === 0, detail: result.summary };
}

function accessCheck(intent: PlantIntent, { document }: GradeContext): CheckOutcome {
  const stairs = elementsOf(document, 'stair');
  const slabs = elementsOf(document, 'slab');
  const problems: string[] = [];
  for (const wanted of intent.stairs) {
    const from = intent.levels[wanted.level];
    const to = intent.levels[wanted.level + 1];
    if (!from || !to) continue;
    const stair = stairs.find(
      (s) =>
        Math.abs(elevationOf(document, s.levelId) - from.elevation) <= 1 &&
        Math.hypot(s.start[0] - wanted.start[0], s.start[1] - wanted.start[1]) <= 10,
    );
    if (!stair) {
      problems.push(`no stair from "${from.name}" at (${wanted.start.join(', ')})`);
      continue;
    }
    const rise = stair.riserCount * stair.riserHeight;
    if (Math.abs(rise - (to.elevation - from.elevation)) > 1) {
      problems.push(`${stair.mark} rises ${rise}, storey is ${to.elevation - from.elevation}`);
    }
    const blondel = 2 * stair.riserHeight + stair.treadDepth;
    if (blondel < BLONDEL.min || blondel > BLONDEL.max) {
      problems.push(
        `${stair.mark} 2R+G = ${Math.round(blondel)} mm, outside ${BLONDEL.min}–${BLONDEL.max}`,
      );
    }
    const run = stair.treadDepth * (stair.riserCount - 1);
    const nearTop: Vec2 = [
      stair.start[0] + Math.cos(stair.angle) * run * 0.75,
      stair.start[1] + Math.sin(stair.angle) * run * 0.75,
    ];
    const above = slabs.find(
      (s) => Math.abs(elevationOf(document, s.levelId) + s.offset - to.elevation) <= 1,
    );
    if (above && !(above.openings ?? []).some((opening) => insidePolygon(nearTop, opening))) {
      problems.push(`${stair.mark}: no stair well in ${above.mark} above it`);
    }
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${intent.stairs.length} stair flight(s) with wells, Blondel OK`
        : problems.join('; '),
  };
}

function coverageCheck({ document, run }: GradeContext): CheckOutcome {
  const members = elementsOf(document, 'member');
  const checks = listCommands().filter(
    (command) =>
      command.name.startsWith('check_') &&
      command.annotations?.readOnly === true &&
      !NOT_STRUCTURAL.has(command.name),
  );
  const covered = new Set<string>();
  const perCheck: string[] = [];
  for (const command of checks) {
    const result = run(command.name);
    const text = `${result.summary} ${JSON.stringify(result.data ?? {})}`;
    const hits = members.filter(
      (m) =>
        text.includes(`"${m.id}"`) ||
        new RegExp(`\\b${m.mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text),
    );
    hits.forEach((m) => covered.add(m.id));
    if (hits.length > 0) perCheck.push(`${command.name} ${hits.length}`);
  }
  const uncovered = members.filter((m) => !covered.has(m.id));
  return {
    pass: members.length > 0 && uncovered.length === 0,
    detail:
      `${covered.size}/${members.length} steel members verified by a structural check` +
      (perCheck.length > 0
        ? ` (${perCheck.join(', ')})`
        : ` (ran ${checks.map((c) => c.name).join(', ')})`) +
      (uncovered.length > 0
        ? `; unverified e.g. ${uncovered
            .slice(0, 5)
            .map((m) => m.mark)
            .join(', ')}`
        : ''),
  };
}

export function coordinationCriteria(intent: PlantIntent): Criterion[] {
  return [
    {
      id: 'clash-free',
      area: 'coordination',
      requirement: 'No hard clash and no clearance violation (check_clashes).',
      check: clashCheck,
    },
    {
      id: 'access',
      area: 'coordination',
      requirement:
        'Every designed stair flight rises one storey, meets 2R+G 600–650 mm and has its well cut.',
      check: (ctx) => accessCheck(intent, ctx),
    },
    {
      id: 'structural-coverage',
      area: 'engineering',
      requirement:
        'Every steel member is verified (EN 1993) under the equipment and floor loads by a structural check.',
      check: coverageCheck,
    },
  ];
}
