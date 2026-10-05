import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@core/model/building';
import { beam, column, step, twoLevels } from './steelFixtures';

/** DN100 pipe (Ø114.3) along X at y = 2000 with its underside on the top of steel (2970) of a beam along Y at x = 3000. */
export function shoeDoc(): CadDocument {
  let doc = twoLevels();
  doc = column(doc, 3000, 0);
  doc = column(doc, 3000, 4000);
  doc = beam(doc, [3000, 0], [3000, 4000]);
  return step(doc, 'add_pipe_run', {
    levelId: 'level-1',
    dn: 100,
    line: 'L-1',
    service: 'water',
    points: [
      [0, 2000, 3027.15],
      [6000, 2000, 3027.15],
    ],
  });
}

/** Same beam, a DN100 pipe 600 mm under it on level-2 (z relative to the level, absolute 2000). */
export function hangerDoc(): CadDocument {
  let doc = twoLevels();
  doc = column(doc, 3000, 0);
  doc = column(doc, 3000, 4000);
  doc = beam(doc, [3000, 0], [3000, 4000]);
  return step(doc, 'add_pipe_run', {
    levelId: 'level-2',
    dn: 100,
    line: 'L-2',
    points: [
      [0, 2000, -1000],
      [6000, 2000, -1000],
    ],
  });
}

export function supportsOf(doc: CadDocument): PipeSupportElement[] {
  return Object.values(doc.building?.elements ?? {}).filter(
    (element): element is PipeSupportElement => element.category === 'pipeSupport',
  );
}
