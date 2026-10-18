/** Query results of the aerodynamics / fluids plugins: full-precision `data`, summary numbers shortened to 6 significant digits. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { significantNumber } from '@lib/compactNumber';

/** Every decimal literal with more than 4 fraction digits in `text`, rewritten to 6 significant digits. */
export const briefNumbers = (text: string): string =>
  text.replace(/-?\d+\.\d{5,}(?:e[-+]?\d+)?/g, (match) => significantNumber(Number(match), 6));

export const briefReport = (doc: CadDocument, summary: string, data: unknown): CommandResult => report(doc, briefNumbers(summary), data);
