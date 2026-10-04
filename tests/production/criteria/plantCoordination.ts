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

/** Per-member verdict rows in a check's data: objects naming the member id with a utilisation / ok. */
interface MemberRow {
  id: string;
  utilisation: number | null;
  ok: boolean | null;
}

function memberRows(value: unknown, ids: ReadonlySet<string>, rows: MemberRow[] = []): MemberRow[] {
  if (Array.isArray(value)) {
    for (const item of value) memberRows(item, ids, rows);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = record['id'] ?? record['memberId'] ?? record['elementId'];
    const utilisation = record['utilisation'] ?? record['utilization'];
    const ok = record['ok'];
    if (
      typeof id === 'string' &&
      ids.has(id) &&
      (typeof utilisation === 'number' || typeof ok === 'boolean')
    ) {
      rows.push({
        id,
        utilisation: typeof utilisation === 'number' ? utilisation : null,
        ok: typeof ok === 'boolean' ? ok : null,
      });
    }
    for (const inner of Object.values(record)) memberRows(inner, ids, rows);
  }
  return rows;
}

/**
 * A member is verified when a structural check returns a verdict row for it (its id with a
 * utilisation or ok flag) and every such row passes (utilisation ≤ 1, ok not false).
 */
function coverageCheck({ document, run }: GradeContext): CheckOutcome {
  const members = elementsOf(document, 'member');
  const ids = new Set(members.map((m) => m.id));
  const checks = listCommands().filter(
    (command) =>
      command.name.startsWith('check_') &&
      command.annotations?.readOnly === true &&
      !NOT_STRUCTURAL.has(command.name),
  );
  const rows: MemberRow[] = [];
  const perCheck: string[] = [];
  for (const command of checks) {
    const found = memberRows(run(command.name).data ?? {}, ids);
    rows.push(...found);
    if (found.length > 0) perCheck.push(`${command.name} ${new Set(found.map((r) => r.id)).size}`);
  }
  const covered = new Set(rows.map((r) => r.id));
  const failing = new Set(
    rows
      .filter((r) => r.ok === false || (r.utilisation !== null && r.utilisation > 1))
      .map((r) => r.id),
  );
  const uncovered = members.filter((m) => !covered.has(m.id));
  const failed = members.filter((m) => failing.has(m.id));
  const worst = rows.reduce((max, r) => Math.max(max, r.utilisation ?? 0), 0);
  const marks = (list: typeof members): string =>
    list
      .slice(0, 6)
      .map((m) => m.mark)
      .join(', ');
  return {
    pass: members.length > 0 && uncovered.length === 0 && failed.length === 0,
    detail:
      `${covered.size - failed.length}/${members.length} steel members verified and passing` +
      (perCheck.length > 0
        ? ` (${perCheck.join(', ')}; max utilisation ${worst.toFixed(2)})`
        : ` (ran ${checks.map((c) => c.name).join(', ')})`) +
      (failed.length > 0 ? `; failing: ${marks(failed)}` : '') +
      (uncovered.length > 0 ? `; unverified e.g. ${marks(uncovered)}` : ''),
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
        'Every steel member is verified (EN 1993) under its equipment, floor and pipe loads by a structural check, and passes (utilisation ≤ 1).',
      check: coverageCheck,
    },
  ];
}
