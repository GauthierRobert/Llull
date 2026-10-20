/** Named defaults of the explicit set-up (AF-31): each carries the source of its value; the decisions are PHY-19 TECHNICAL_SPEC §13 (Q8, Q10). */

import type { NamedValue } from '@core/model/topology';

const named = (value: number, source: string): NamedValue => ({ value, source, defaulted: true });

export const DEFAULT_TIME_STEP_SCALE = (): NamedValue =>
  named(0.9, 'LS-DYNA *CONTROL_TIMESTEP TSSFAC default (PHY-19 TECHNICAL_SPEC §13 [E4])');

export const DEFAULT_HOURGLASS_COEFFICIENT = (): NamedValue =>
  named(0.1, 'LS-DYNA *HOURGLASS QM default for the Flanagan-Belytschko viscous form (PHY-19 TECHNICAL_SPEC §13 [E2], [E4])');

export const DEFAULT_BULK_LINEAR = (): NamedValue =>
  named(0.06, 'LS-DYNA *CONTROL_BULK_VISCOSITY Q2 (linear) default (PHY-19 TECHNICAL_SPEC §13 [E4])');

export const DEFAULT_BULK_QUADRATIC = (): NamedValue =>
  named(1.5, 'LS-DYNA *CONTROL_BULK_VISCOSITY Q1 (quadratic) default (PHY-19 TECHNICAL_SPEC §13 [E4])');

/** Penalty contact scale f_si (RS-8c). */
export const DEFAULT_PENALTY_SCALE = (): NamedValue =>
  named(0.1, 'LS-DYNA *CONTROL_CONTACT SLSFAC default (PHY-19 TECHNICAL_SPEC §13.7 [E3])');

/** Hourglass / internal energy ratio above which explicit_energy_check warns (spec Q8: kept as a named default). */
export const DEFAULT_HOURGLASS_LIMIT = (): NamedValue => named(0.1, 'S13 rule of thumb');

/** Most samples a wall-force or energy history keeps in the document summary (spec §8). */
export const MAX_HISTORY_POINTS = 500;

/** Most nodes a structured hex mesh may have (the job folder stays a few hundred MB at most). */
export const MAX_STRUCTURED_NODES = 2_000_000;
