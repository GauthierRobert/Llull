/** Results of the aerodynamics / fluids plugins: `data` numbers at 10 significant digits, summary numbers shortened to 6. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { significantNumber } from '@lib/compactNumber';
import { roundSignificant } from '@lib/significant';

/** A `data` number: 10 significant digits (stable across platforms, finer than any validation tolerance). */
export const sig = (value: number): number => roundSignificant(value, 10);

/** Every decimal literal with more than 4 fraction digits in `text`, rewritten to 6 significant digits. */
export const briefNumbers = (text: string): string =>
  text.replace(/-?\d+\.\d{5,}(?:e[-+]?\d+)?/g, (match) => significantNumber(Number(match), 6));

export const briefReport = (doc: CadDocument, summary: string, data: unknown): CommandResult => report(doc, briefNumbers(summary), data);
