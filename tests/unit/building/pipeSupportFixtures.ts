import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@core/model/building';
import { beamOnColumns, step } from './steelFixtures';
import { xyz } from '../../helpers/xy';

/** DN100 pipe (Ø114.3) along X at y = 2000 with its underside on the top of steel (2970) of a beam along Y at x = 3000. */
export function shoeDoc(): CadDocument {
  return step(beamOnColumns(), 'add_pipe_run', {
    levelId: 'level-1',
    dn: 100,
    line: 'L-1',
    service: 'water',
    points: xyz(0, 2000, 3027.15, 6000, 2000, 3027.15),
  });
}

/** Same beam, a DN100 pipe 600 mm under it on level-2 (z relative to the level, absolute 2000). */
export function hangerDoc(): CadDocument {
  return step(beamOnColumns(), 'add_pipe_run', {
    levelId: 'level-2',
    dn: 100,
    line: 'L-2',
    points: xyz(0, 2000, -1000, 6000, 2000, -1000),
  });
}

export function supportsOf(doc: CadDocument): PipeSupportElement[] {
  return Object.values(doc.building?.elements ?? {}).filter((element): element is PipeSupportElement => element.category === 'pipeSupport');
}
