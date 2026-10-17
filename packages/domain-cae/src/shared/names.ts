/** Name grammars of the free-text fields that reach a CalculiX deck (load case and cavity names). */

/** Longest load case name. */
const LOAD_CASE_NAME_MAX = 40;
/** CalculiX limit on cavity names (05 / PHY-03 §5.2). */
const CAVITY_NAME_MAX = 3;

const LOAD_CASE_NAME = new RegExp(`^[A-Za-z0-9_]{1,${LOAD_CASE_NAME_MAX}}$`);
const CAVITY_NAME = new RegExp(`^[A-Za-z0-9_]{1,${CAVITY_NAME_MAX}}$`);

/** Problem text when `name` is not a load case identifier (letters, digits, underscore; 1-40 characters), else null. */
export const loadCaseNameProblem = (name: string): string | null =>
  LOAD_CASE_NAME.test(name) ? null : `load case name '${name.slice(0, 60)}' must be 1-${LOAD_CASE_NAME_MAX} letters, digits or underscores`;

/** Problem text when `name` is not a cavity identifier (letters, digits, underscore; 1-3 characters), else null. */
export const cavityNameProblem = (name: string): string | null =>
  CAVITY_NAME.test(name) ? null : `cavity name '${name.slice(0, 60)}' must be 1-${CAVITY_NAME_MAX} letters, digits or underscores`;
