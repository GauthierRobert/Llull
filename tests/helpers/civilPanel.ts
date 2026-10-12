import { resetStore } from './componentEntities';
import { beforeEach, vi } from 'vitest';
import { downloadText } from '@ui/download';
import { localDispatch } from './storeTestHelpers';

export { CivilPanel } from '@ui/panels/civil/CivilPanel';
export { downloadText } from '@ui/download';
export { localDispatch, spyDispatch } from './storeTestHelpers';

/** Before each test: fresh document, no summary, cleared `downloadText` mock (the file mocks `@ui/download`). */
export function setupCivilStore(): void {
  beforeEach(() => {
    resetStore();
    vi.mocked(downloadText).mockClear();
  });
}

/** A 20 m survey square, four TOPO-coded points. */
export const SURVEY = ['1,0,0,10,TOPO', '2,20,0,11,TOPO', '3,0,20,12,TOPO', '4,20,20,13,TOPO'].join(
  '\n',
);

/** Metres, `survey` imported as 'Topo' and a surface built from it. */
export function surveyed(survey: string = SURVEY): void {
  localDispatch('set_units', { units: 'm' });
  localDispatch('import_survey_points', { text: survey, name: 'Topo' });
  localDispatch('create_surface', {});
}
