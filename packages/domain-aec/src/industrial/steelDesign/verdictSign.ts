/** The sign printed between a design effect and its resistance in a check line: the line of a failing member must not read "≤". */
export const verdictSign = (effect: number, resistance: number): '≤' | '>' => (effect <= resistance ? '≤' : '>');

/** A resistance for a check line: whole units from 10 up, two significant digits below (a failing slender member is not "0 kN"). */
export const resistanceText = (value: number): string => (Math.abs(value) >= 10 ? value.toFixed(0) : value.toPrecision(2));
