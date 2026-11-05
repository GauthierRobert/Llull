/** Utilisation helpers shared by the check rows and summaries. A refused row is not a utilisation: every helper skips it. */

/** Why a row's input was refused (grade, thickness, bolt class / size): the row was not computed. */
export interface RowRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Fail-safe `utilisation` stored on a refused row so that a consumer ignoring `refusal` still treats it as failing. It is not a computed
 * value: the helpers below and every report read `refusal`, never this number.
 */
export const REFUSED_UTILISATION = 99;

/** Any check / design row; `refusal` is set only when the row was refused. */
export interface UtilisationRow {
  readonly utilisation: number;
  readonly refusal?: RowRefusal;
}

const computed = <Item extends UtilisationRow>(items: readonly Item[]): Item[] => items.filter((item) => item.refusal === undefined);

/** The refused rows. */
export const refusedRows = <Item extends UtilisationRow>(items: readonly Item[]): Item[] =>
  items.filter((item) => item.refusal !== undefined);

/** Row fields marking a refusal: the fail-safe utilisation and the marker. */
export const refusedFields = (refusal: RowRefusal): { utilisation: number; refusal: RowRefusal } => ({
  utilisation: REFUSED_UTILISATION,
  refusal: { code: refusal.code, message: refusal.message },
});

/** The first computed item of highest utilisation; undefined when there is none. */
export const highestUtilisation = <Item extends UtilisationRow>(items: readonly Item[]): Item | undefined =>
  computed(items).reduce<Item | undefined>(
    (best, item) => (best === undefined || item.utilisation > best.utilisation ? item : best),
    undefined,
  );

/** Highest computed utilisation of the items; 0 when there are none. */
export const maxUtilisation = (items: readonly UtilisationRow[]): number => Math.max(0, ...computed(items).map((item) => item.utilisation));

/** The computed items whose utilisation exceeds 1 (failing the check). */
export const failingRows = <Item extends UtilisationRow>(items: readonly Item[]): Item[] =>
  computed(items).filter((item) => item.utilisation > 1);
