import type { Vec2 } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import {
  elementsOf,
  elevationOf,
  equipmentBox,
  insidePolygon,
  planCorners,
  planOverlaps,
} from '../oracle/geometry';
import type { PlantIntent } from '../plant/intent';

/**
 * @layer tests/production/criteria
 *
 * Process equipment acceptance: every tag placed as specified, gratings cut where equipment passes
 * through a floor (computed geometrically, independent of the clash detector), and every elevated
 * equipment standing on a floor of its level.
 */

function placedCheck(intent: PlantIntent, { document }: GradeContext): CheckOutcome {
  const model = elementsOf(document, 'equipment');
  const problems: string[] = [];
  for (const wanted of intent.equipment) {
    const found = model.find((e) => e.mark === wanted.tag);
    if (!found) {
      problems.push(`${wanted.tag} missing`);
      continue;
    }
    const ffl = intent.levels[wanted.level]?.elevation ?? 0;
    if (Math.abs(elevationOf(document, found.levelId) - ffl) > 1) {
      problems.push(
        `${wanted.tag} on FFL ${elevationOf(document, found.levelId)}, expected ${ffl}`,
      );
    }
    if (
      Math.hypot(found.location[0] - wanted.location[0], found.location[1] - wanted.location[1]) > 5
    ) {
      problems.push(
        `${wanted.tag} at (${found.location.join(', ')}), expected (${wanted.location.join(', ')})`,
      );
    }
    const box = equipmentBox(document, found);
    const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], found.size[2]];
    if (size.some((value, axis) => Math.abs(value - (wanted.size[axis] ?? 0)) > 1)) {
      problems.push(`${wanted.tag} envelope ${size.join('×')}, expected ${wanted.size.join('×')}`);
    }
    if (found.weight !== wanted.weight) {
      problems.push(`${wanted.tag} weighs ${found.weight} kg, expected ${wanted.weight}`);
    }
    if (found.clearance < wanted.clearance) {
      problems.push(`${wanted.tag} clearance ${found.clearance}, expected ${wanted.clearance}`);
    }
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${intent.equipment.length} equipment placed (${intent.equipment.reduce((s, e) => s + e.weight, 0) / 1000} t operating)`
        : problems.join('; '),
  };
}

function openingsCheck({ document }: GradeContext): CheckOutcome {
  const slabs = elementsOf(document, 'slab');
  const problems: string[] = [];
  let crossings = 0;
  for (const equipment of elementsOf(document, 'equipment')) {
    const box = equipmentBox(document, equipment);
    for (const slab of slabs) {
      const top = elevationOf(document, slab.levelId) + slab.offset;
      if (!(top > box.min[2] + 1 && top - slab.thickness < box.max[2] - 1)) continue;
      if (!planOverlaps(box, slab.boundary)) continue;
      crossings++;
      const corners = planCorners(box);
      const cut = (slab.openings ?? []).some((opening) =>
        corners.every((corner: Vec2) => insidePolygon(corner, opening)),
      );
      if (!cut)
        problems.push(`${equipment.mark} passes through ${slab.mark} (top ${top}) with no opening`);
    }
  }
  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${crossings} floor crossing(s), all cut` : problems.join('; '),
  };
}

function supportedCheck({ document }: GradeContext): CheckOutcome {
  const slabs = elementsOf(document, 'slab');
  const problems: string[] = [];
  let elevated = 0;
  for (const equipment of elementsOf(document, 'equipment')) {
    const base = elevationOf(document, equipment.levelId);
    if (Math.abs(base) <= 1) continue;
    elevated++;
    const corners = planCorners(equipmentBox(document, equipment));
    const floor = slabs.find(
      (slab) =>
        Math.abs(elevationOf(document, slab.levelId) + slab.offset - base) <= 1 &&
        corners.every((corner) => insidePolygon(corner, slab.boundary)) &&
        !(slab.openings ?? []).some((opening) => corners.some((c) => insidePolygon(c, opening))),
    );
    if (!floor) problems.push(`${equipment.mark} at FFL ${base} does not stand on a floor`);
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${elevated} elevated equipment, all on a floor`
        : problems.join('; '),
  };
}

export function equipmentCriteria(intent: PlantIntent): Criterion[] {
  return [
    {
      id: 'equipment-placed',
      area: 'equipment',
      requirement:
        'Every equipment tag on its level, position, envelope, operating weight and clearance.',
      check: (ctx) => placedCheck(intent, ctx),
    },
    {
      id: 'floor-openings',
      area: 'equipment',
      requirement: 'Gratings cut wherever an equipment passes through a floor.',
      check: openingsCheck,
    },
    {
      id: 'equipment-supported',
      area: 'equipment',
      requirement: 'Every elevated equipment stands on a floor of its level, clear of openings.',
      check: supportedCheck,
    },
  ];
}
