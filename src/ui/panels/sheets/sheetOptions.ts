// Choices and param builders of the drawing-sheet forms (values are the `create_sheet` / `update_sheet` params).

import { PAPER_SIZES, PROJECTION_ANGLES, VIEW_DIRECTIONS, type ViewDirection } from '@core/model/sheet';
import { optionalText } from '@ui/numberText';

export const PAPER_OPTIONS: ReadonlyArray<readonly [string, string]> = PAPER_SIZES.map((size) => [size, size]);

export const PROJECTION_OPTIONS: ReadonlyArray<readonly [string, string]> = PROJECTION_ANGLES.map((angle) => [
  angle,
  angle === 'first' ? 'First angle (ISO)' : 'Third angle (US)',
]);

export const DIRECTION_OPTIONS: ReadonlyArray<readonly [string, string]> = VIEW_DIRECTIONS.map((direction) => [
  direction,
  direction[0]?.toUpperCase() + direction.slice(1),
]);

/** Section planes are perpendicular to an axis: no iso. */
export const SECTION_DIRECTION_OPTIONS = DIRECTION_OPTIONS.filter(([direction]) => direction !== 'iso');

export const STANDARD_VIEW_OPTIONS: ReadonlyArray<readonly [ViewDirection, string]> = [
  ['front', 'Front'],
  ['top', 'Top'],
  ['right', 'Right'],
  ['iso', 'Isometric'],
];

export const DEFAULT_STANDARD_VIEWS: readonly ViewDirection[] = ['front', 'top', 'right'];

export interface TitleBlockDraft {
  title: string;
  drawnBy: string;
  partNumber: string;
  revision: string;
  date: string;
}

export const EMPTY_TITLE_BLOCK: TitleBlockDraft = { title: '', drawnBy: '', partNumber: '', revision: '', date: '' };

/** The non-blank title block fields as params. */
export function titleBlockParams(draft: TitleBlockDraft): Record<string, string> {
  return {
    ...optionalText('title', draft.title),
    ...optionalText('drawnBy', draft.drawnBy),
    ...optionalText('partNumber', draft.partNumber),
    ...optionalText('revision', draft.revision),
    ...optionalText('date', draft.date),
  };
}
